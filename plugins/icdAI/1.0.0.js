/*
 * ICD 联合诊断拆分 AI 审核（rule-process 插件版 · 流式 yield · 只产出 JSONL）
 *
 * 职责边界：本插件只负责"AI 审核 → reviewed.jsonl"，
 * JSONL 转 Excel 由下游插件 jsonl2xlsx 完成。
 * 链路：icdCheck（result.xlsx）→ icdAI（reviewed.jsonl）→ jsonl2xlsx（reviewed.xlsx）
 *
 * 数据流（从上往下读）：
 *   writingRules（async function*）
 *     ├─ readExcel ← result.xlsx
 *     ├─ buildTasks
 *     ├─ yield 'w' 节点清空 reviewed.jsonl
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

// ══════════════════════════════════════════════════════════════
// 1. 配置
// ══════════════════════════════════════════════════════════════
const SETTINGS = {
    apiUrl: 'http://127.0.0.1:7863/v1/chat/completions',
    apiKey: 'Bearer WildWorkAPI',
    model: 'workbuddy/hy3-x',
    temperature: 0.1,
    maxTokens: 7000,
    timeoutMs: 60000,
    sleepMinMs: 200,
    sleepMaxMs: 800,
    logEvery: 50
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
// 3. 调模型
// ══════════════════════════════════════════════════════════════

async function callModel(messages) {
    const controller = new AbortController();
    const timeoutTimer = setTimeout(() => controller.abort(), SETTINGS.timeoutMs);
    try {
        const response = await fetch(SETTINGS.apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': SETTINGS.apiKey
            },
            body: JSON.stringify({
                model: SETTINGS.model,
                temperature: SETTINGS.temperature,
                max_tokens: SETTINGS.maxTokens,
                messages: messages
            }),
            signal: controller.signal
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const responseData = await response.json();
        const replyContent = responseData.choices
            && responseData.choices[0]
            && responseData.choices[0].message
            && responseData.choices[0].message.content;

        const thinkContent = responseData.choices
            && responseData.choices[0]
            && responseData.choices[0].message
            && responseData.choices[0].message.reasoning_content;

        if (!replyContent) throw new Error('响应缺少 content');
        return {
            replyText:replyContent,
            thinkText:thinkContent
        };
    } finally {
        clearTimeout(timeoutTimer);
    }
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
- 人工复审：成分与联合编码兼容但信息不完整、成分未完全覆盖、语义模糊、专业性强、无法确定，或结算规则不明确。
- 不合理：成分与联合编码无关、拆分错误、成分重复、语义矛盾、单成分自身范围超出联合编码。

记录：
${recordLines}

输出JSON数组，共 ${tasks.length} 项，序号必须与记录一致，每项格式：
{"idx":记录序号,"verdict":"合理|不合理|人工复审","reason":"20字以内理由"}`;
}


// ══════════════════════════════════════════════════════════════
// 5. 审核一条 / 审核全部（★ 流式生成器）
// ══════════════════════════════════════════════════════════════

async function reviewOne(singleTask) {
    try {
        const {replyText,thinkText} = await callModel([
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildPrompt([singleTask]) }
        ]);
        const parsedData = extractJson(replyText);
        const entry = Array.isArray(parsedData) ? parsedData[0] : parsedData;
        const isValidVerdict = entry && ALL_VERDICTS.indexOf(entry.verdict) >= 0;

        return {
            verdict: isValidVerdict ? entry.verdict : VERDICT_MANUAL,
            reason: isValidVerdict ? (entry.reason || '') : '模型输出无法解析',
            think: thinkText
        };
    } catch (error) {
        return {
            verdict: VERDICT_MANUAL,
            reason: '接口失败:' + error.message
        };
    }
}

/**
 * 逐条审核（生成器）。
 * 每审出一条结论，就 yield 一个 JSONL 节点给框架落盘。
 * 记录自包含（原行数据 + 结论），供下游 jsonl2xlsx 直接转表格行。
 * 每条之间随机 sleep。
 */
async function* reviewAll(tasks, sourceRows, outputNodeTemplate, statistics) {
    const totalCount = tasks.length;
    const startTime = Date.now();

    for (let i = 0; i < totalCount; i++) {
        const singleTask = tasks[i];
        const verdict = await reviewOne(singleTask);

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

        const processedCount = i + 1;
        if (processedCount % SETTINGS.logEvery === 0 || processedCount === totalCount) {
            const elapsedSec = Math.round((Date.now() - startTime) / 1000);
            console.log(`AI审核进度: ${processedCount}/${totalCount}（已耗时 ${elapsedSec}s）`);
        }

        if (processedCount < totalCount) {
            await randomSleep(SETTINGS.sleepMinMs, SETTINGS.sleepMaxMs);
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
    const outputDir = outputNodeTemplate.path;
    const jsonlPath = path.join(outputDir, 'reviewed.jsonl');   // 框架写到这里

    // 步骤1：找到上一规则输出的 result.xlsx
    const sourceFile = inputArray.find(
        file => file.normExt === 'xlsx' && file.name === 'result'
    );
    if (!sourceFile) {
        yield [{ ...outputNodeTemplate, content: '错误: 未找到 result.xlsx，请先运行 icdCheck 规则生成预结果' }];
        return;
    }

    // 步骤2：读 Excel
    const sourceRows = readExcel(sourceFile.path);
    if (sourceRows.length === 0) {
        yield [{ ...outputNodeTemplate, content: '错误: result.xlsx 无数据行' }];
        return;
    }
    console.log(`已加载 ${sourceRows.length} 条记录（来自 ${sourceFile.path}）\n`);

    // 步骤3：造任务
    const taskBuildResult = buildTasks(sourceRows);
    const tasks = taskBuildResult.tasks;
    const preVerdicts = taskBuildResult.preVerdicts;
    console.log(`待审核 ${tasks.length} 条，跳过 ${preVerdicts.size} 条（名称缺失）`);

    const statistics = { ok: 0, bad: 0, manual: preVerdicts.size };

    // ★ 步骤4：先 yield 一个 'w' 节点清空 JSONL（空内容覆盖写，不产生垃圾行）
    yield [{
        ...outputNodeTemplate,
        fileName: 'reviewed',
        normExt: 'jsonl',
        content: '',
        option: { flag: 'w' }
    }];
    console.log(`流式输出文件已就绪: ${jsonlPath}\n`);

    // ★ 步骤5：前置结论（名称缺失的）先落盘，同样携带原行数据（自包含记录）
    for (const [rowIdx, verdict] of preVerdicts) {
        yield makeJsonlNode(outputNodeTemplate, {
            rowIdx: rowIdx,
            ...sourceRows[rowIdx],
            'AI评审': verdict.verdict,
            'AI理由': verdict.reason
        }, 'a');
    }

    // ★ 步骤6：逐条审核，边审边 yield（for await 转发）
    const startTime = Date.now();
    for await (const node of reviewAll(tasks, sourceRows, outputNodeTemplate, statistics)) {
        yield node;
    }
    const elapsedSec = Math.round((Date.now() - startTime) / 1000);

    console.log(`AI审核完成，耗时 ${elapsedSec}s`);
    console.log(`合理: ${statistics.ok}，不合理: ${statistics.bad}，人工复审: ${statistics.manual}`);
    console.log('JSONL 文件:', jsonlPath);
    console.log('后续: 将 reviewed.jsonl 放入输入目录，运行 jsonl2xlsx 规则生成 reviewed.xlsx');

    // ★ 步骤7：yield 运行摘要
    yield [{
        ...outputNodeTemplate,
        fileName: 'reviewed',
        normExt: 'json',
        content: JSON.stringify({
            sourceRows: sourceRows.length,
            reviewed: tasks.length,
            skipped: preVerdicts.size,
            reasonable: statistics.ok,
            unreasonable: statistics.bad,
            manualReview: statistics.manual,
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
    version: '1.0.0',
    mode: 'stream',
    process: writingRules,
    description: 'ICD 联合诊断拆分 AI 审核（流式 yield · 只产出 JSONL）：逐条判定"联合诊断=成分1+成分2"是否成立，每条结论（含原行数据）通过 yield 交给框架追加写 reviewed.jsonl；Excel 转换由下游 jsonl2xlsx 插件完成',
    notes: {
        node: '18.20.4',
        tips: [
            '输入约定：上一规则（icdCheck）输出的 result.xlsx（12列预结果表）',
            '输出：reviewed.jsonl（框架流式追加）+ reviewed.json（运行摘要）',
            'JSONL 记录自包含：每行 = {rowIdx, ...原12列, AI评审, AI理由}，jsonl2xlsx 可直接转表格行',
            'AI评审=合理：两成分为联合诊断真实组成；不合理：拆分错误/无关；人工复审：模型无法确定或接口失败',
            '处理策略：逐条送审，1条/请求；每条之间随机等待 200~800ms；失败直接兜底"人工复审"',
            '流式落地：每条结论通过 yield 输出，框架负责 append 到 reviewed.jsonl，中途崩溃已落盘部分不丢',
            '链路：icdCheck（result.xlsx）→ icdAI（reviewed.jsonl）→ jsonl2xlsx（reviewed.xlsx）',
            '注意：关联得分、灰度标记、匹配方式不发送给模型（不可信字段）',
            '接口地址/密钥/sleep 区间/logEvery 等集中在顶部 SETTINGS，运行前按需调整'
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
    rely: { 'xlsx': '0.18.0' }
};
