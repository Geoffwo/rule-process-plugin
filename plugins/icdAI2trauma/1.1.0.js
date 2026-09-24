/*
 * 外伤提醒知识库 AI 批量标注（rule-process 插件版 · 流式 yield · 只产出 JSONL）
 *
 * 业务目标：对"规则预处理模块（icdCheck2trauma）"输出的候选集逐条判定 相关/无关，
 * 剔除完全和外伤无关的条目，输出带标注结果的数据集用于入库。
 *
 * 知识库用途：线上开单时弹窗提醒医生创建外伤申请单。
 * 策略：优先召回、宁宽勿漏（仅弹窗提示，不强制）——判定时不确定一律判"相关"。
 *
 * 职责边界：本插件只负责"AI 标注 → trauma.jsonl"，
 * JSONL 转 Excel 由下游插件 jsonl2xlsx 完成。
 * 链路：icdCheck2trauma（candidate.xlsx）→ traumaAILabel（trauma.jsonl）→ jsonl2xlsx（trauma.xlsx）
 *
 * 数据流（从上往下读）：
 *   writingRules（async function*）
 *     ├─ readExcel ← candidate.xlsx
 *     ├─ buildTasks
 *     ├─ 流式读旧 trauma.jsonl → 断点续跑过滤
 *     ├─ yield 前置结论（编码/名称缺失的，标"相关"）
 *     ├─ for await reviewAll(...) → 每条结论 yield 给框架追加写 trauma.jsonl
 *     └─ yield 运行摘要 trauma.json
 *
 * JSONL 记录格式（自包含：每行一个扁平对象，jsonl2xlsx 可直接转表格行）：
 *   { "rowIdx": 行号, ...原候选列, "AI评审": "相关|无关", "AI理由": "..." }
 */
const path = require('path');
const xlsx = require('xlsx');
const readline = require('readline');

// ── LangChain.js ──────────────────────────────────────────────
// 注意：以下依赖需安装（见底部 rely 字段）。未安装时本插件 require 阶段即报错，
// 属于预期行为，安装后即可加载。
const { ChatOpenAI } = require('@langchain/openai');
const { JsonOutputParser } = require('@langchain/core/output_parsers');
const { SystemMessage, HumanMessage } = require('@langchain/core/messages');

// ══════════════════════════════════════════════════════════════
// 1. 配置
// ══════════════════════════════════════════════════════════════
const SETTINGS = {
    apiUrl: 'http://127.0.0.1:7863/v1',//http://10.24.20.186:18090/qwen235b/v1
    apiKey: 'WildWorkAPI',
    model: 'workbuddy/hy3',//Qwen3-235B-A22B-Q4_K_M.gguf
    temperature: 0.1,
    maxTokens: 10000,
    timeoutMs: 60 * 1000 * 10,   // 10 分钟

    // 批次送审（每批条数）
    batchSize: 16,
    // 批间随机休息（防封）
    sleepMinMs: 0.5 * 1000,       // 1 秒
    sleepMaxMs: 0.8 * 1000,       // 3 秒
    logEvery: 50,

    // 每 requestSleepEvery 次模型请求后，长休息 requestSleepMinMs~requestSleepMaxMs
    requestSleepEvery: 50,       // 每 10 次请求长休一次；设 0 禁用
    requestSleepMinMs: 60 * 1000 * 0.5,   // 3 分钟
    requestSleepMaxMs: 60 * 1000 * 1.5,   // 5 分钟

    // LangChain 重试策略：接口瞬时失败（超时/5xx/网络）自动重试
    retryAttempts: 0,
};

// ★ 外伤相关性筛查 prompt：二分类（相关/无关），优先召回、宁宽勿漏
const SYSTEM_PROMPT =
    '你是外伤相关性筛查助手。' +
    '判断给定的 ICD10 诊断条目是否与"外伤"相关（即是否需要提醒医生创建外伤申请单）。' +
    '策略：优先召回、宁宽勿漏——只要与外伤存在任何可能关联，一律判"相关"；只有明确与外伤完全无关才判"无关"。' +
    '本判定仅用于线上弹窗提示，不强制。' +
    '严格按用户要求的JSON格式输出，不要输出任何多余文字。';

const VERDICT_RELEVANT = '相关';
const VERDICT_IRRELEVANT = '无关';
const ALL_VERDICTS = [VERDICT_RELEVANT, VERDICT_IRRELEVANT];


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
 * 流式逐行解析旧 trauma.jsonl（断点续跑：收集已评行号）。
 * 用 readline 逐行读取（crlfDelay:Infinity 自动兼容 \r\n），避免整文件进内存。
 * 第二参 stream 为回调：每条成功解析且为对象的记录会传给 stream(record)，
 * 由调用方决定如何处理（本插件用于把 rowIdx 收集进 Set）。
 * 坏行/非对象行跳过并计数告警（不中断）；返回统计对象。
 */
async function readJsonlStream(source, stream) {
    const emptyResult = {
        totalLines: 0,
        emptyLines: 0,
        objLines: 0,
        badLines: 0,
        notObjLines: 0
    };
    if (!source) return emptyResult;

    let streamValue;
    try { streamValue = source.stream(); } catch (e) { return emptyResult; }
    if (!streamValue) return emptyResult;

    let totalLines = 0, // 总行数
        emptyLines = 0, // 空行数
        objLines = 0,   // 处理行数
        badLines = 0,   // 坏行数
        notObjLines = 0;// 非对象行数

    // ★ stream 模式下用 readline 逐行读取，避免整文件进内存
    const rl = readline.createInterface({
        input: streamValue,
        crlfDelay: Infinity
    });

    for await (const line of rl) {
        totalLines++;

        const text = line.trim();
        if (!text) { emptyLines++; continue; } // 跳过空行

        let record;
        try {
            record = JSON.parse(text);
        } catch (e) {
            badLines++;
            console.warn('JSONL 单行解析失败，已跳过:', text.slice(0, 80));
            continue;
        }

        if (!record || typeof record !== 'object' || Array.isArray(record)) {
            notObjLines++;
            console.warn('JSONL 单行非对象，已跳过:', text.slice(0, 80));
            continue;
        }

        objLines++;

        // ★ 回调在 parse 的 try 外，写盘错误才会正常冒泡到调用方
        if (typeof stream === 'function') stream(record);
    }
    return {
        totalLines,
        objLines,
        errorLines: badLines + notObjLines,
        badLines,
        notObjLines
    };
}

/**
 * 判定某行是否需要评（断点续跑/删行重评的统一入口）。
 * 纯存在性判断：rowIdx 已在旧 jsonl 中 → 跳过（存在即最终）；
 * 不存在（从未评过 / 被手动删除）→ 待评。
 * 想重评某行（含接口失败的行）→ 手动删除该行后重跑。
 */
function shouldRerun(doneRowIdxs, rowIdx) {
    return !doneRowIdxs.has(rowIdx);
}

/**
 * 构造一条 JSONL 节点的 yield 载荷
 * 框架按 content 原样追加写 trauma.jsonl（不补换行），
 * 因此这里必须自带 '\n'，否则所有记录挤在同一行、下游解析失败
 */
function makeJsonlNode(outputNodeTemplate, record, mode) {
    return [{
        ...outputNodeTemplate,
        fileName: 'trauma',
        normExt: 'jsonl',
        content: JSON.stringify(record) + '\n',
        option: { flag: mode }       // 'w' 清空 / 'a' 追加
    }];
}


// ══════════════════════════════════════════════════════════════
// 3. 调模型（LangChain.js）
// ══════════════════════════════════════════════════════════════

// 端点已是 OpenAI 兼容（/v1/chat/completions + messages/model/temperature/max_tokens），
// ChatOpenAI 可直接接管，模型/密钥/地址一行不改语义。
const lcApiKey = SETTINGS.apiKey.replace(/^Bearer\s+/i, '');                  // LangChain 自带 Bearer 前缀
const lcBaseURL = SETTINGS.apiUrl.replace(/\/chat\/completions\/?$/i, '');    // → http://127.0.0.1:7863/v1

const chatModel = new ChatOpenAI({
    model: SETTINGS.model,
    apiKey: lcApiKey,
    configuration: { baseURL: lcBaseURL },
    temperature: SETTINGS.temperature,
    maxTokens: SETTINGS.maxTokens,
    timeout: SETTINGS.timeoutMs,
    maxRetries: 0                       // 关闭 SDK 内置重试，统一由 withRetry 管理策略
});

const chatModelRetry = chatModel.withRetry({ stopAfterAttempt: SETTINGS.retryAttempts });
const jsonParser = new JsonOutputParser();

// 尝试从响应中取"思维链"（DeepSeek 兼容端点常放 reasoning_content）。
// 取不到时 think 为 null，不影响主流程。
function extractThink(response) {
    if (!response) return null;
    if (response.additional_kwargs && response.additional_kwargs.reasoning_content) {
        return response.additional_kwargs.reasoning_content;
    }
    if (response.reasoning) return response.reasoning;
    return null;
}


// ══════════════════════════════════════════════════════════════
// 4. 拼提示词
// ══════════════════════════════════════════════════════════════

function buildPrompt(tasks) {
    const recordLines = tasks.map((task, position) =>
        `【${position + 1}】编码：${task.code}；名称：${task.name}`
    ).join('\n');

    return `逐条判断以下 ${tasks.length} 条 ICD10 诊断条目是否与"外伤"相关（是否需要提醒医生创建外伤申请单）。

判定：
- 相关：诊断涉及损伤、创伤、骨折、脱位、烧伤、烫伤、冻伤、电击、中毒、动物咬蜇伤、窒息、溺水、外因致伤（交通事故/跌倒/暴力等）、创伤并发症等外伤范畴。只要与外伤存在任何可能关联，一律判"相关"。
- 无关：诊断与外伤完全无关（如内科疾病、肿瘤、慢性病、感染性疾病、先天性疾病等非外伤条目）。

原则：优先召回、宁宽勿漏。不确定时判"相关"。只有明确与外伤完全无关才判"无关"。
注意：本判定仅用于线上弹窗提示，不强制。

记录：
${recordLines}

输出JSON数组，共 ${tasks.length} 项，序号必须与记录一致，每项格式：
{"idx":记录序号,"verdict":"相关|无关","reason":"20字以内理由"}`;
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

        // 更稳的解析：优先 JsonOutputParser，失败回退容忍式 extractJson
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
                    // ★ 宁宽勿漏：verdict 无效时默认"相关"
                    verdict: isValidVerdict ? entry.verdict : VERDICT_RELEVANT,
                    reason: isValidVerdict ? (entry.reason || '') : '模型输出无法解析',
                    think: thinkText
                });
            }
        }

        // 组装对齐后的结果数组，缺失项标「相关 · 模型漏项」（宁宽勿漏）
        const results = [];
        for (let i = 0; i < tasks.length; i++) {
            const verdict = verdictMap.get(i + 1);
            results.push(verdict || {
                verdict: VERDICT_RELEVANT,
                reason: '模型漏项',
                think: thinkText
            });
        }
        return results;
    } catch (error) {
        // ★ 宁宽勿漏：接口失败整批默认"相关"（不做单条回退）
        // 接口失败不等于"无关"，保留为"相关"避免漏召回
        return tasks.map(() => ({
            verdict: VERDICT_RELEVANT,
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

            if (verdict.verdict === VERDICT_RELEVANT) statistics.relevant++;
            else statistics.irrelevant++;

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
                console.log(`AI标注进度: ${processedCount}/${totalCount}（已耗时 ${elapsedSec}s）`);
            }
        }

        // 不是最后一批才休息
        if (i + batchSize < totalCount) {
            const hitLongSleep = SETTINGS.requestSleepEvery > 0 && requestCount !== 0 && requestCount % SETTINGS.requestSleepEvery === 0;

            if (hitLongSleep) {
                console.log(`已请求 ${requestCount} 次，触发长休息 ${SETTINGS.requestSleepMinMs}~${SETTINGS.requestSleepMaxMs}ms`);
                await randomSleep(SETTINGS.requestSleepMinMs, SETTINGS.requestSleepMaxMs);
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
        const code = row['icd_code'];
        const name = row['icd_name'];

        if (!code || !name) {
            // ★ 宁宽勿漏：编码/名称缺失标"相关"（数据质量问题不代表与外伤无关）
            preVerdicts.set(rowIdx, {
                verdict: VERDICT_RELEVANT,
                reason: '编码或名称缺失'
            });
        } else {
            tasks.push({
                rowIdx: rowIdx,
                code: code,
                name: name
            });
        }
    });
    return { tasks: tasks, preVerdicts: preVerdicts };
}


// ══════════════════════════════════════════════════════════════
// 7. 主流程（★ 生成器）
// ══════════════════════════════════════════════════════════════

async function* writingRules(inputArray, outputNodeTemplate) {
    const outputDir = outputNodeTemplate.path;
    const inputPath = path.join(outputDir, '../inputDir');
    const jsonlPath = path.join(inputPath, 'trauma.jsonl');   // 框架写到这里
    const outputNode = {
        ...outputNodeTemplate,
        path: inputPath
    };

    // 步骤1：找到上一规则输出的 candidate.xlsx
    const sourceFile = inputArray.find(file => file.normExt === 'xlsx' && file.name === 'candidate');
    if (!sourceFile) {
        yield [{ ...outputNodeTemplate, content: `错误: 未找到 candidate.xlsx，请先运行 icdCheck2trauma 规则生成候选集` }];
        return;
    }

    // 步骤1.5：断点续跑——流式读旧 trauma.jsonl → Set<rowIdx>（存在即最终）
    const jsonlFile = inputArray.find(file => file.normExt === 'jsonl' && file.name === 'trauma');
    const doneRowIdxs = new Set();
    const resumeStats = await readJsonlStream(jsonlFile, (record) => {
        if (record && typeof record.rowIdx === 'number') doneRowIdxs.add(record.rowIdx);
    });
    if (resumeStats.errorLines > 0) {
        console.warn(`断点续跑读取旧 trauma.jsonl：总行 ${resumeStats.totalLines}，有效 ${resumeStats.objLines}，跳过坏行 ${resumeStats.badLines} / 非对象 ${resumeStats.notObjLines}`);
    }

    // 步骤2：读候选集
    const sourceRows = readExcel(sourceFile.path);
    if (sourceRows.length === 0) {
        yield [{ ...outputNodeTemplate, content: `错误: candidate.xlsx 无数据行` }];
        return;
    }
    console.log(`已加载 ${sourceRows.length} 条候选记录（来自 ${sourceFile.path}）\n`);

    // 步骤3：造任务，并按存在性过滤（断点续跑：旧 jsonl 已有的行号一律跳过）
    const taskBuild = buildTasks(sourceRows);

    const tasks = taskBuild.tasks.filter(task => shouldRerun(doneRowIdxs, task.rowIdx));
    const preVerdicts = new Map(
        [...taskBuild.preVerdicts].filter(
            ([rowIdx]) => shouldRerun(doneRowIdxs, rowIdx)
        )
    );
    const skipped = taskBuild.tasks.length - tasks.length;
    console.log(`待标注 ${tasks.length} 条，跳过已评估 ${skipped} 条`);

    // 统计初始化（二分类）；编码/名称缺失的行已标"相关"，计入 relevant
    const statistics = { relevant: preVerdicts.size, irrelevant: 0 };

    console.log(`断点续跑文件已就绪: ${jsonlPath}\n`);

    // 步骤5：前置结论（编码/名称缺失的）先落盘，同样携带原行数据（自包含记录）
    for (const [rowIdx, verdict] of preVerdicts) {
        yield makeJsonlNode(outputNode, {
            rowIdx: rowIdx,
            ...sourceRows[rowIdx],
            'AI评审': verdict.verdict,
            'AI理由': verdict.reason
        }, 'a');
    }

    // 步骤6：逐批标注，边标边 yield（for await 转发）
    const startTime = Date.now();
    for await (const node of reviewAll(tasks, sourceRows, outputNode, statistics)) {
        yield node;
    }
    const elapsedSec = Math.round((Date.now() - startTime) / 1000);

    console.log(`AI标注完成，耗时 ${elapsedSec}s`);
    console.log(`相关: ${statistics.relevant}，无关: ${statistics.irrelevant}`);
    console.log('JSONL 文件:', jsonlPath);
    console.log('后续: 运行 jsonl2xlsx 规则将 trauma.jsonl 转为 trauma.xlsx');

    // 步骤7：yield 运行摘要
    yield [{
        ...outputNodeTemplate,
        fileName: 'trauma',
        normExt: 'json',
        content: JSON.stringify({
            module: '外伤提醒知识库-AI批量标注',
            sourceRows: sourceRows.length,
            trauma: tasks.length,
            skippedEvaluated: skipped,
            relevant: statistics.relevant,
            irrelevant: statistics.irrelevant,
            resumeMode: skipped > 0 ? 'resume' : (doneRowIdxs.size > 0 ? 'full-resume' : 'full'),
            elapsedSeconds: elapsedSec,
            jsonlFile: jsonlPath,
            nextStep: '运行 jsonl2xlsx 规则将 trauma.jsonl 转为 trauma.xlsx，筛出"相关"条目入库'
        }, null, 2)
    }];
}


// ══════════════════════════════════════════════════════════════
// 8. 插件导出
// ══════════════════════════════════════════════════════════════

module.exports = {
    name: 'icdAI2trauma',
    version: '1.1.0',
    mode: 'stream',
    process: writingRules,
    description: '外伤提醒知识库-AI批量标注模块（流式 yield · 只产出 JSONL · LangChain.js 版）：对规则预处理（icdCheck2trauma）输出的候选集逐条判定 相关/无关（是否与外伤相关、是否需提醒创建外伤申请单），剔除完全与外伤无关的条目；优先召回、宁宽勿漏，解析失败/接口失败/模型漏项一律兜底"相关"',
    notes: {
        node: '18.20.4',
        tips: [
            '业务目标：对候选集逐条 AI 复审，判定 相关/无关，剔除完全和外伤无关的条目，输出带标注结果的数据集用于入库',
            '知识库用途：线上开单时弹窗提醒医生创建外伤申请单；策略：优先召回、宁宽勿漏（仅提示、不强制）',
            '判定：相关=涉及损伤/创伤/骨折/烧伤/中毒/外因致伤等外伤范畴；无关=与外伤完全无关（内科疾病/肿瘤/慢性病/感染/先心病等）',
            '宁宽勿漏：不确定时判"相关"；解析失败/接口失败/模型漏项一律兜底"相关"（避免漏召回）',
            '输入约定：上一规则（icdCheck2trauma）输出的 candidate.xlsx（列：icd_code, icd_name, 命中规则, 命中关键词）',
            '输出：trauma.jsonl（框架流式追加，写入 inputDir）+ trauma.json（运行摘要）',
            'JSONL 记录自包含：每行 = {rowIdx, ...原候选列, AI评审(相关|无关), AI理由}，jsonl2xlsx 可直接转表格行',
            '处理策略：批次送审，15条/批（SETTINGS.batchSize 可调）；批间随机等待 10~30s；每 10 次请求长休 3~5 分钟（防封，均可配）；失败经 withRetry 重试后整批兜底"相关"；批次内缺失项标"模型漏项"',
            '断点续跑：启动时读取已生成的 trauma.jsonl，已有行号一律跳过（存在即最终，不判定内容），只评缺失的行并追加，不清空文件；想重评某行（含接口失败的行）→ 手动删除该行后重跑',
            '更稳点(LangChain)：JsonOutputParser 优先解析、失败回退容忍式 extractJson；接口瞬时失败由 withRetry 自动重试',
            '流式落地：每条结论通过 yield 输出，框架负责 append 到 trauma.jsonl，中途崩溃已落盘部分不丢',
            '链路：icdCheck2trauma（candidate.xlsx）→ traumaAILabel（trauma.jsonl）→ jsonl2xlsx（trauma.xlsx）',
            '注意：命中规则、命中关键词不发送给模型（不可信字段）',
            '依赖：@langchain/openai、@langchain/core（见 rely，二者必须版本配对）；端点须为 OpenAI 兼容',
            '版本配对（已核对 npm 2026-09）：@langchain/openai@^1.5.13 要求 @langchain/core@^1.2.11，且 openai@1.x 要求 Node>=22',
            '若插件实际跑在 Node 18（非框架的 node22 target），请改用旧线 @langchain/openai@^0.3.17 + @langchain/core@^0.3.0',
            '已知缺口：自定义端点 workbuddy/hy3-x 未必暴露 reasoning_content，AI思考列可能为空（不影响主流程）',
            '接口地址/密钥/sleep 区间/batchSize/logEvery 等集中在顶部 SETTINGS，运行前按需调整',
            '版本 1.1.0 改动：断点续跑读取旧 trauma.jsonl 由"手动按行切分缓冲"改为 readline 逐行读取（crlfDelay:Infinity 兼容 CRLF），同样只驻留行号集合、避免整文件进内存；坏行计数并告警而非静默跳过'
        ]
    },
    input: {
        normExt: 'xlsx文件',
        format: 'Excel：约定 candidate.xlsx（icdCheck2trauma 规则输出），列：icd_code, icd_name, 命中规则, 命中关键词'
    },
    output: {
        normExt: 'jsonl文件',
        format: 'trauma.jsonl：每行 {rowIdx, ...原候选列, AI评审(相关|无关), AI理由}；另有 trauma.json 运行摘要'
    },
    rely: {
        'xlsx': '0.18.0',
        '@langchain/openai': '1.5.13',
        '@langchain/core': '1.2.11'
    }
};
