/*
 * ICD 联合诊断拆分 AI 审核（rule-process 插件版 · 流式 yield · 只产出 JSONL）
 *
 * ══════════════════════════════════════════════════════════════
 * 2.0.0 改造说明（相对 1.0.0）：仅把"调模型 + 解析 + 重试"内部换成
 * LangChain.js（ChatOpenAI + JsonOutputParser + withRetry），
 * 对外契约（mode:'stream'、async function* process、节点 yield 形状、
 * 下游 jsonl2xlsx）完全不变。目标：更稳的解析与重试，不引入 Graph。
 *
 * 2.0.0 功能适配（对齐 1.1.1）：在保留 LangChain 调用层的前提下，
 * 移植 1.1.1 的三项新能力——
 *   ① 断点续跑：流式读旧 reviewed.jsonl → Set<rowIdx>（存在即最终），
 *      只评缺失行并追加，不再清空文件；重评某行 → 手动删除该行后重跑
 *   ② 批次送审：batchSize 条/批，按 idx 对齐，缺失项标"模型漏项"，
 *      整批失败全部兜底"人工复审"（不做单条回退）
 *   ③ 防封延时：批间随机 10~30s；每 requestSleepEvery 次请求后
 *      长休息 3~5 分钟（设 0 禁用）
 * 同时对齐 1.1.1 的输出路径约定：reviewed.jsonl 写入 inputDir，
 * 供下游 jsonl2xlsx 直接作为输入拾取。
 * ══════════════════════════════════════════════════════════════
 *
 * 职责边界：本插件只负责"AI 审核 → reviewed.jsonl"，
 * JSONL 转 Excel 由下游插件 jsonl2xlsx 完成。
 * 链路：icdCheck（result.xlsx）→ icdAI（reviewed.jsonl）→ jsonl2xlsx（reviewed.xlsx）
 *
 * 数据流（从上往下读）：
 *   writingRules（async function*）
 *     ├─ readExcel ← result.xlsx
 *     ├─ buildTasks
 *     ├─ 流式读旧 reviewed.jsonl → 断点续跑过滤
 *     ├─ yield 前置结论（名称缺失的）
 *     ├─ for await reviewAll(...) → 每条结论 yield 给框架追加写 reviewed.jsonl
 *     └─ yield 运行摘要 reviewed.json
 *
 * 流式落地：
 *   - 每条结论通过 yield 交给框架，框架负责追加写 reviewed.jsonl
 *   - 中途崩溃，框架已落盘的部分不丢
 *
 * JSONL 记录格式（自包含：每行一个扁平对象，jsonl2xlsx 可直接转表格行）：
 *   { "rowIdx": 行号, ...原12列, "AI评审": "合理|不合理|人工复审", "AI理由": "..." }
 */
const path = require('path');
const xlsx = require('xlsx');

// ── LangChain.js（仅替换调模型/解析/重试三处）────────────────────
// 注意：以下依赖需安装（见底部 rely 字段）。未安装时本插件 require 阶段即报错，
// 属于预期行为，安装后即可加载。
const { ChatOpenAI } = require('@langchain/openai');
const { JsonOutputParser } = require('@langchain/core/output_parsers');
const { SystemMessage, HumanMessage } = require('@langchain/core/messages');

// ══════════════════════════════════════════════════════════════
// 1. 配置
// ══════════════════════════════════════════════════════════════
const SETTINGS = {
    apiUrl: 'http://127.0.0.1:7863/v1',
    apiKey: 'WildWorkAPI',
    model: 'workbuddy/hy3',
    temperature: 0.1,
    maxTokens: 10000,
    timeoutMs: 60 * 1000 * 10,   // 10 分钟

    // 普通批间休息（对齐 1.1.1 防封节奏）
    sleepMinMs: 10 * 1000,       // 10 秒
    sleepMaxMs: 30 * 1000,       // 30 秒
    batchSize: 8,
    logEvery: 50,

    // 每 requestSleepEvery 次模型请求后，长休息 requestSleepMinMs~requestSleepMaxMs
    requestSleepEvery: 8,        // 每 8 次请求长休一次；设 0 表示禁用
    requestSleepMinMs: 60 * 1000 * 3,   // 3 分钟
    requestSleepMaxMs: 60 * 1000 * 5,   // 5 分钟

    // LangChain 重试策略：接口瞬时失败（超时/5xx/网络）自动重试
    retryAttempts: 0
};

const SYSTEM_PROMPT =
    '你是ICD联合诊断拆分审核助手。' +
    '判断给定的拆分【联合编码 = 成分1 + 成分2】在医学语义上是否成立，并判断是否属于官方合并编码或医保规则明确允许的联合替代。' +
    '仅依据编码名称、编码分类和明确的医保编码规则判断，不得依据预打分。' +
    '若结算规则不明确，输出“人工复审”。' +
    '严格按用户要求的JSON格式输出，不要输出任何多余文字。';

const VERDICT_OK = '合理';
const VERDICT_BAD = '不合理';
const VERDICT_MANUAL = '人工复审';
const ALL_VERDICTS = [VERDICT_OK, VERDICT_BAD, VERDICT_MANUAL];


// ══════════════════════════════════════════════════════════════
// 2. 小工具
// ══════════════════════════════════════════════════════════════

function readExcel(filePath) {
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) throw new Error(`文件无工作表: ${filePath}`);
    return xlsx.utils.sheet_to_json(worksheet);
}

/**
 * 容忍式 JSON 提取（作为 JsonOutputParser 失败时的兜底）。
 * 处理 ```json 代码块、前后多余文字，支持数组或单对象。
 */
function extractJson(replyText) {
    const cleaned = String(replyText).replace(/```json|```/g, '').trim();
    const arrayStart = cleaned.indexOf('[');
    const arrayEnd = cleaned.lastIndexOf(']');
    const objectStart = cleaned.indexOf('{');
    const objectEnd = cleaned.lastIndexOf('}');

    if (arrayStart >= 0 && arrayEnd > arrayStart) {
        try { return JSON.parse(cleaned.slice(arrayStart, arrayEnd + 1)); } catch (e) {}
    }
    if (objectStart >= 0 && objectEnd > objectStart) {
        try { return JSON.parse(cleaned.slice(objectStart, objectEnd + 1)); } catch (e) {}
    }
    return null;
}

function randomSleep(minMs, maxMs) {
    const waitMs = minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
    return new Promise(resolve => setTimeout(resolve, waitMs));
}

/**
 * 流式逐行解析旧 reviewed.jsonl → Set<rowIdx>（断点续跑：已评行号集合）。
 * 边读边按 '\n' 拆行、逐行 JSON.parse，只取 rowIdx 即弃记录本体，
 * 内存只驻留行号集合（不攒全文、不驻留记录对象，避免大文件 OOM）。
 * 坏行/非对象行跳过。
 */
async function readJsonlStream(source) {
    const doneRowIdxs = new Set();

    // 输入目录无旧 reviewed.jsonl（首次全量跑）→ 空 Set，所有行都判待评
    if (!source) return doneRowIdxs;

    let stream;
    try { stream = source.stream(); } catch (e) { return doneRowIdxs; }

    // buffer 只保留"尚未凑齐一行"的残片，不攒全文（避免大文件 OOM）
    let buffer = '';
    for await (const chunk of stream) {
        buffer += chunk;
        let nl;
        // 内层循环：把本次 chunk 带来的所有完整行全部切出处理
        // 切分只认真实换行字节 0x0A；字段内容里的换行已被 JSON.stringify
        // 转义成 \n 字面量（反斜杠+n 两个字符），不会被误切
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;   // 空行跳过
            try {
                const rec = JSON.parse(line);
                // 只取行号即弃记录；存在即最终，不判定内容有效性
                if (rec && typeof rec.rowIdx === 'number') doneRowIdxs.add(rec.rowIdx);
            } catch (e) { /* 坏行跳过 */ }
        }
    }

    return doneRowIdxs;
}

/**
 * 判定某行是否需要评（断点续跑/删行重评的统一入口）。
 * 纯存在性判断：rowIdx 已在旧 jsonl 中 → 跳过（存在即最终，已有内容不重跑、
 * 不重复追加）；不存在（从未评过 / 被手动删除）→ 待评。
 * 想重评某行（含接口失败的行）→ 手动删除该行后重跑。
 */
function shouldRerun(doneRowIdxs, rowIdx) {
    return !doneRowIdxs.has(rowIdx);
}

/**
 * 构造一条 JSONL 节点的 yield 载荷
 * 框架按 content 原样追加写 reviewed.jsonl（不补换行），
 * 因此这里必须自带 '\n'，否则所有记录挤在同一行、下游解析失败
 */
function makeJsonlNode(outputNodeTemplate, record, mode) {
    return [{
        ...outputNodeTemplate,
        fileName: 'reviewed',
        normExt: 'jsonl',
        content: JSON.stringify(record) + '\n',
        option: { flag: mode }       // 'w' 清空 / 'a' 追加
    }];
}


// ══════════════════════════════════════════════════════════════
// 3. 调模型（★ LangChain.js 替换手写 fetch）
// ══════════════════════════════════════════════════════════════

// 端点已是 OpenAI 兼容（/v1/chat/completions + messages/model/temperature/max_tokens），
// ChatOpenAI 可直接接管，模型/密钥/地址一行不改语义。
const lcApiKey = SETTINGS.apiKey.replace(/^Bearer\s+/i, '');                       // LangChain 自带 Bearer 前缀
const lcBaseURL = SETTINGS.apiUrl.replace(/\/chat\/completions\/?$/i, '');         // → http://127.0.0.1:7863/v1

const chatModel = new ChatOpenAI({
    model: SETTINGS.model,
    apiKey: lcApiKey,
    configuration: { baseURL: lcBaseURL },
    temperature: SETTINGS.temperature,
    maxTokens: SETTINGS.maxTokens,
    timeout: SETTINGS.timeoutMs,
    maxRetries: 0                       // 关闭 SDK 内置重试，统一由 withRetry 管理策略
});

// 显式重试：瞬时失败自动重试，最终仍失败才在 reviewBatch 兜底层置"人工复审"
const chatModelRetry = chatModel.withRetry({ stopAfterAttempt: SETTINGS.retryAttempts });

// 容忍式 JSON 解析器（提示词已要求严格 JSON，这里做结构化兜底）
const jsonParser = new JsonOutputParser();

// 尝试从响应中取"思维链"（DeepSeek 兼容端点常放 reasoning_content）。
// 注意：LangChain 默认不保证暴露该字段，取不到时 think 为 null，不影响主流程。
function extractThink(response) {
    if (!response) return null;

    if (response.additional_kwargs && response.additional_kwargs.reasoning_content) {
        return response.additional_kwargs.reasoning_content;
    }

    if (response.reasoning) return response.reasoning;   // LangChain 较新版本的推理字段
    return null;
}


// ══════════════════════════════════════════════════════════════
// 4. 拼提示词
// ══════════════════════════════════════════════════════════════

function buildPrompt(tasks) {
    const recordLines = tasks.map((task, position) =>
        `【${position + 1}】联合诊断：${task.unionCode} ${task.union}；成分1：${task.part1Code} ${task.part1}；成分2：${task.part2Code} ${task.part2}；`
    ).join('\n');

    return `审核以下 ${tasks.length} 条拆分记录，判断每条"成分1+成分2"是否为联合诊断的合理拆分，以及结算时能否用联合编码代替两个成分编码。


判定：
- 合理：成分均为联合编码的真实组成部分，组合后医学语义完全等价，无遗漏、无扩大，且属于官方合并编码或医保规则明确允许的联合替代。
- 人工复审：成分与联合编码兼容但信息不完整、成分未完全覆盖(联合编码的范围明显大于两个成分覆盖的总和)、语义模糊、专业性强、无法确定，或结算规则不明确。
- 不合理：成分与联合编码无关、拆分错误、成分重复、语义矛盾、单成分自身范围超出联合编码。

记录：
${recordLines}

输出JSON数组，共 ${tasks.length} 项，序号必须与记录一致，每项格式：
{"idx":记录序号,"verdict":"合理|不合理|人工复审","reason":"20字以内理由"}`;
}


// ══════════════════════════════════════════════════════════════
// 5. 批次审核 / 审核全部（★ 流式生成器）
// ══════════════════════════════════════════════════════════════

async function reviewBatch(tasks) {
    try {
        const response = await chatModelRetry.invoke([
            new SystemMessage(SYSTEM_PROMPT),
            new HumanMessage(buildPrompt(tasks))
        ]);

        const replyText = typeof response.content === 'string'
            ? response.content
            : JSON.stringify(response.content);

        const thinkText = extractThink(response);

        // ★ 更稳的解析：优先 JsonOutputParser，失败回退容忍式 extractJson
        let parsedData = null;
        try {
            parsedData = await jsonParser.parse(replyText);
        } catch (parseErr) {
            parsedData = extractJson(replyText);
        }
        const entries = Array.isArray(parsedData) ? parsedData : (parsedData ? [parsedData] : []);

        // 按 idx 对齐到 tasks 位置（idx 从 1 开始）
        const verdictMap = new Map();
        for (const entry of entries) {
            const isValidVerdict = entry && ALL_VERDICTS.indexOf(entry.verdict) >= 0;
            const idx = Number(entry && entry.idx);
            if (Number.isInteger(idx) && idx >= 1 && idx <= tasks.length) {
                verdictMap.set(idx, {
                    verdict: isValidVerdict ? entry.verdict : VERDICT_MANUAL,
                    reason: isValidVerdict ? (entry.reason || '') : '模型输出无法解析',
                    think: thinkText
                });
            }
        }

        // 组装对齐后的结果数组，缺失项标「人工复审 · 模型漏项」
        const results = [];
        for (let i = 0; i < tasks.length; i++) {
            const verdict = verdictMap.get(i + 1);
            results.push(verdict || {
                verdict: VERDICT_MANUAL,
                reason: '模型漏项',
                think: thinkText
            });
        }
        return results;
    } catch (error) {
        // withRetry 重试耗尽后整批失败，全部兜底人工复审（不做单条回退）
        return tasks.map(() => ({
            verdict: VERDICT_MANUAL,
            reason: '接口失败:' + error.message
        }));
    }
}

/**
 * 批次审核（生成器）。
 * 每批审完后，逐条 yield 一个 JSONL 节点给框架落盘。
 * 记录自包含（原行数据 + 结论），供下游 jsonl2xlsx 直接转表格行。
 * 每批之间随机 sleep（不是每条）；达到长休阈值时触发长休息（防封）。
 */
async function* reviewAll(tasks, sourceRows, outputNodeTemplate, statistics) {
    const totalCount = tasks.length;
    const startTime = Date.now();
    const batchSize = SETTINGS.batchSize;
    let processedCount = 0;
    let requestCount = 0; // 本次运行已发起的模型请求次数

    for (let i = 0; i < totalCount; i += batchSize) {
        const batch = tasks.slice(i, i + batchSize);
        const verdicts = await reviewBatch(batch);
        requestCount++;

        for (let j = 0; j < batch.length; j++) {
            const singleTask = batch[j];
            const verdict = verdicts[j];

            if (verdict.verdict === VERDICT_OK) statistics.ok++;
            else if (verdict.verdict === VERDICT_BAD) statistics.bad++;
            else statistics.manual++;

            // ★ 流式 yield：交给框架追加写盘
            yield makeJsonlNode(outputNodeTemplate, {
                rowIdx: singleTask.rowIdx,
                ...sourceRows[singleTask.rowIdx],
                'AI评审': verdict.verdict,
                'AI理由': verdict.reason,
                'AI思考（调试模型使用）': verdict.think,
            }, 'a');

            processedCount++;
            if (processedCount % SETTINGS.logEvery === 0 || processedCount === totalCount) {
                const elapsedSec = Math.round((Date.now() - startTime) / 1000);
                console.log(`AI审核进度: ${processedCount}/${totalCount}（已耗时 ${elapsedSec}s）`);
            }
        }

        // 不是最后一批才休息
        if (i + batchSize < totalCount) {
            const hitLongSleep = SETTINGS.requestSleepEvery > 0 && requestCount !== 0 && requestCount % SETTINGS.requestSleepEvery === 0;

            if (hitLongSleep) {
                const longMin = SETTINGS.requestSleepMinMs;
                const longMax = SETTINGS.requestSleepMaxMs;
                console.log(`已请求 ${requestCount} 次，触发长休息 ${longMin}~${longMax}ms`);
                await randomSleep(longMin, longMax);
            } else {
                await randomSleep(SETTINGS.sleepMinMs, SETTINGS.sleepMaxMs);
            }
        }
    }
}


// ══════════════════════════════════════════════════════════════
// 6. 造任务
// ══════════════════════════════════════════════════════════════

function buildTasks(sourceRows) {
    const tasks = [];
    const preVerdicts = new Map();

    sourceRows.forEach((row, rowIdx) => {
        const unionName = row['联合名称'];
        const part1Name = row['ICD名称1'];
        const part2Name = row['ICD名称2'];

        if (!unionName || !part1Name || !part2Name) {
            preVerdicts.set(rowIdx, {
                verdict: VERDICT_MANUAL,
                reason: '关键名称缺失'
            });
        } else {
            tasks.push({
                rowIdx: rowIdx,
                union: unionName,
                unionCode: row['联合编码'],
                part1: part1Name,
                part1Code: row['ICD编码1'],
                part2: part2Name,
                part2Code: row['ICD编码2']
            });
        }
    });
    return { tasks: tasks, preVerdicts: preVerdicts };
}


// ══════════════════════════════════════════════════════════════
// 7. 主流程（★ 生成器）
// ══════════════════════════════════════════════════════════════

async function* writingRules(inputArray, outputNodeTemplate) {
    const outputDir = outputNodeTemplate.path // 临时目录绝对路径
    const inputPath = path.join(outputDir, '../inputDir');
    const jsonlPath = path.join(inputPath, 'reviewed.jsonl');   // 框架写到这里
    const outputNode = {
        ...outputNodeTemplate,
        path: inputPath
    }

    // 步骤1：找到上一规则输出的 result.xlsx
    const sourceFile = inputArray.find(
        file => file.normExt === 'xlsx' && file.name === 'result'
    );
    if (!sourceFile) {
        yield [{ ...outputNodeTemplate, content: '错误: 未找到 result.xlsx，请先运行 icdCheck 规则生成预结果' }];
        return;
    }

    // 步骤1.5：断点续跑——流式读旧 reviewed.jsonl → Set<rowIdx>（存在即最终）
    const jsonlFile = inputArray.find(file => file.normExt === 'jsonl' && file.name === 'reviewed');
    const doneRowIdxs = await readJsonlStream(jsonlFile);

    // 步骤2：读 Excel
    const sourceRows = readExcel(sourceFile.path);
    if (sourceRows.length === 0) {
        yield [{ ...outputNodeTemplate, content: '错误: result.xlsx 无数据行' }];
        return;
    }
    console.log(`已加载 ${sourceRows.length} 条记录（来自 ${sourceFile.path}）\n`);

    // 步骤3：造任务，并按存在性过滤（断点续跑：旧 jsonl 已有的行号一律跳过，存在即最终）
    const taskBuild = buildTasks(sourceRows);

    // 过滤后的要执行任务
    const tasks = taskBuild.tasks.filter(task => shouldRerun(doneRowIdxs, task.rowIdx));
    // 过滤后的要跳过任务
    const preVerdicts = new Map(
        [...taskBuild.preVerdicts].filter(
            ([rowIdx]) => shouldRerun(doneRowIdxs, rowIdx)
        )
    );
    const skipped = taskBuild.tasks.length - tasks.length;
    console.log(`待审核 ${tasks.length} 条，跳过已评估 ${skipped} 条`);

    const statistics = { ok: 0, bad: 0, manual: preVerdicts.size };

    // ★ 步骤4：断点续跑模式——不再清空文件，仅追加本次新评的行（保留旧行）

    console.log(`断点续跑文件已就绪: ${jsonlPath}\n`);

    // ★ 步骤5：前置结论（名称缺失的）先落盘，同样携带原行数据（自包含记录）
    for (const [rowIdx, verdict] of preVerdicts) {
        yield makeJsonlNode(outputNode, {
            rowIdx: rowIdx,
            ...sourceRows[rowIdx],
            'AI评审': verdict.verdict,
            'AI理由': verdict.reason
        }, 'a');
    }

    // ★ 步骤6：逐条审核，边审边 yield（for await 转发）
    const startTime = Date.now();
    for await (const node of reviewAll(tasks, sourceRows, outputNode, statistics)) {
        yield node;
    }
    const elapsedSec = Math.round((Date.now() - startTime) / 1000);

    console.log(`AI审核完成，耗时 ${elapsedSec}s`);
    console.log(`合理: ${statistics.ok}，不合理: ${statistics.bad}，人工复审: ${statistics.manual}`);
    console.log('JSONL 文件:', jsonlPath);

    // ★ 步骤7：yield 运行摘要
    yield [{
        ...outputNodeTemplate,
        fileName: 'reviewed',
        normExt: 'json',
        content: JSON.stringify({
            sourceRows: sourceRows.length,
            reviewed: tasks.length,
            skippedEvaluated: skipped,
            reasonable: statistics.ok,
            unreasonable: statistics.bad,
            manualReview: statistics.manual,
            resumeMode: skipped > 0 ? 'resume' : (doneRowIdxs.size > 0 ? 'full-resume' : 'full'),
            elapsedSeconds: elapsedSec,
            jsonlFile: jsonlPath,
            nextStep: '运行 jsonl2xlsx 规则将 reviewed.jsonl 转为 reviewed.xlsx'
        }, null, 2)
    }];
}


// ══════════════════════════════════════════════════════════════
// 8. 插件导出
// ══════════════════════════════════════════════════════════════

module.exports = {
    name: 'icdAI',
    version: '2.1.0',
    mode: 'stream',
    process: writingRules,
    description: 'ICD 联合诊断拆分 AI 审核（流式 yield · 只产出 JSONL · LangChain.js 版）：内部以 ChatOpenAI + JsonOutputParser + withRetry 替换手写 fetch，并已对齐 1.1.1 能力——防封延时、断点续跑、批次送审，逐条判定"联合诊断=成分1+成分2"是否成立，每条结论（含原行数据）通过 yield 交给框架追加写 reviewed.jsonl；Excel 转换由下游 jsonl2xlsx 插件完成',
    notes: {
        node: '18.20.4',
        tips: [
            '输入约定：上一规则（icdCheck）输出的 result.xlsx（12列预结果表）',
            '输出：reviewed.jsonl（框架流式追加，写入 inputDir）+ reviewed.json（运行摘要）',
            'JSONL 记录自包含：每行 = {rowIdx, ...原12列, AI评审, AI理由}，jsonl2xlsx 可直接转表格行',
            'AI评审=合理：两成分为联合诊断真实组成；不合理：拆分错误/无关；人工复审：模型无法确定或接口失败',
            '处理策略：批次送审，8条/批（SETTINGS.batchSize 可调）；每批之间随机等待 10~30s；每 3 次请求长休 3~5 分钟（防封，均可配）；失败经 withRetry 重试后整批兜底"人工复审"；批次内缺失项标"模型漏项"',
            '断点续跑：启动时读取已生成的 reviewed.jsonl，已有行号一律跳过（存在即最终，不判定内容），只评缺失的行并追加，不清空文件；想重评某行（含接口失败的行）→ 手动删除该行后重跑',
            '更稳点(LangChain)：JsonOutputParser 优先解析、失败回退容忍式 extractJson；接口瞬时失败由 withRetry 自动重试',
            '流式落地：每条结论通过 yield 输出，框架负责 append 到 reviewed.jsonl，中途崩溃已落盘部分不丢',
            '链路：icdCheck（result.xlsx）→ icdAI（reviewed.jsonl）→ jsonl2xlsx（reviewed.xlsx）',
            '注意：关联得分、灰度标记、匹配方式不发送给模型（不可信字段）',
            '依赖：@langchain/openai、@langchain/core（见 rely，二者必须版本配对）；端点须为 OpenAI 兼容',
            '版本配对（已核对 npm 2026-09）：@langchain/openai@^1.5.13 要求 @langchain/core@^1.2.11，且 openai@1.x 要求 Node>=22',
            '若插件实际跑在 Node 18（非框架的 node22 target），请改用旧线 @langchain/openai@^0.3.17 + @langchain/core@^0.3.0',
            '已知缺口：自定义端点 workbuddy/hy3-x 未必暴露 reasoning_content，AI思考列可能为空（不影响主流程）',
            '接口地址/密钥/sleep 区间/batchSize/logEvery 等集中在顶部 SETTINGS，运行前按需调整'
        ]
    },
    input: {
        normExt: 'xlsx文件',
        format: 'Excel：约定 result.xlsx（icdCheck 规则输出），12列预结果表'
    },
    output: {
        normExt: 'jsonl文件',
        format: 'reviewed.jsonl：每行 {rowIdx, ...原12列, AI评审(合理|不合理|人工复审), AI理由}；另有 reviewed.json 运行摘要'
    },
    rely: {
        'xlsx': '0.18.0',
        '@langchain/openai': '1.5.13',
        '@langchain/core': '1.2.11'
    }
};
