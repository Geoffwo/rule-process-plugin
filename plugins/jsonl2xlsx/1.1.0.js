/*
 * jsonl2xlsx-stream（rule-process 流式版）
 * 职责：把大体积 jsonl 文件（每行一个 JSON 对象）流式转换成 xlsx 表格。
 *
 * 与 ruleDir/rule.js（全量版）的差异：
 *   - mode:'stream'：框架不预读 content，规则内用 node.stream() + readline 逐行读取，
 *     输入侧内存 O(单行)，不再受 full 模式 -s 200MB 读取上限约束
 *   - 写出用 exceljs WorkbookWriter 逐行流式落盘（xlsx 包没有流式写出能力，
 *     XLSX.stream 仅支持 csv/html/json/xlml 四种文本格式导出，见 notes）
 *   - 不处理 rowIdx：直接按文件行序输出
 *   - 列顺序取首条有效记录的字段顺序
 *   - 坏行（JSON 解析失败/非对象行）跳过并 warn，不中断
 *   - 每处理完一个文件 yield 一个摘要节点（xlsx 本体由规则直接写盘，
 *     框架输出通道只承载摘要，单文件逐行内容无法走 yield）
 */
const path = require('path');
const readline = require('readline');
const ExcelJS = require('exceljs');

async function* writingRules(inputArray, outputNodeTemplate) {
    // 过滤出 jsonl 文件（目录节点 normExt 为空串，不会误匹配）
    const jsonlFiles = inputArray.filter(item => item.normExt === 'jsonl');

    if (jsonlFiles.length === 0) {
        yield [{ ...outputNodeTemplate, content: '错误: 未找到 jsonl 文件（每行一个 JSON 对象）' }];
        return;
    }

    // 逐文件处理：xlsx 本体流式写盘，摘要节点逐个 yield
    for (const jsonlFile of jsonlFiles) {
        const summary = await generateXlsx(jsonlFile, outputNodeTemplate);
        yield [{
            ...outputNodeTemplate,
            fileName: `${jsonlFile.name}_summary`,
            normExt: 'json',
            content: JSON.stringify(summary, null, 2)
        }];
    }
}

async function readJsonlStream(source,stream) {
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
        objLines = 0, // 处理行数
        badLines = 0, // 坏行数
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
        errorLines:badLines+notObjLines,
        badLines,
        notObjLines
    };
}

async function generateXlsx(jsonlFile, outputNodeTemplate) {
    const outputDir = outputNodeTemplate.path; // 输出目录绝对路径
    const fileName = `${jsonlFile.name}.xlsx`;
    const outputPath = path.join(outputDir, fileName);

    // 流式写入器：行级 commit 落盘，workbook 数据不整体驻留内存
    const writer = new ExcelJS.stream.xlsx.WorkbookWriter({
        filename: outputPath,
        useStyles: false,       // 不写样式，提速省内存
        useSharedStrings: false // 字符串内联写入，避免共享字符串表在内存中聚合
    });
    const worksheet = writer.addWorksheet('Sheet1');

    let rows = 0;      // 已写出数据行数（不含表头）
    let badLines = 0;  // 坏行数
    let columns = null;// 列定义，由首条有效记录确定

    try {
        // ★ 唯一一次读取；await 保证回调全部执行完再 commit
        const stat = await readJsonlStream(jsonlFile, (record) => {
            // 首条有效记录定列，并显式写出表头行（流式 writer 行需按序 commit）
            if (!columns) {
                columns = Object.keys(record);
                worksheet.addRow(columns).commit();
            }

            worksheet.addRow(toRow(columns, record)).commit();
            rows++;
        });


        if (rows === 0) {
            throw new Error('无有效记录（空文件或全部行解析失败）');
        }

        await writer.commit(); // 收尾：写出 zip 收尾结构并关闭文件

        const badLines = stat.badLines + stat.notObjLines;
        console.log(`已生成: ${outputPath}（${rows} 行，坏行 ${badLines}）`);
        return {
            name: fileName,
            path: outputPath,
            rows,
            badLines,
            success: true
        };
    } catch (writeError) {
        console.log(`XLSX文件写入失败：${writeError.message}`);
        return {
            name: fileName,
            path: '',
            rows,
            badLines,
            success: false,
            msg: writeError.message
        };
    }
}

/** 按列顺序把记录转成单元格数组：null/undefined 置空，嵌套对象/数组序列化 */
function toRow(columns, record) {
    return columns.map(key => {
        const value = record[key];

        if (value === null || value === undefined) return '';

        if (typeof value === 'object') return JSON.stringify(value);

        return value;
    });
}

module.exports = {
    name: 'jsonl2xlsx-stream',
    version: '1.0.0',
    mode: 'stream', // 声明为流式模式
    process: writingRules,
    description: '流式将 jsonl 转换为 xlsx：逐行读取逐行写出，内存 O(单行)，适合超大文件；不处理 rowIdx，按文件行序输出',
    notes: {
        node: '18.20.4',
        tips: [
            '输入约定：jsonl 文件（如 icd10ai 输出的 reviewed.jsonl），每行一个扁平 JSON 对象',
            '输出：与 jsonl 同名的 xlsx（data.jsonl → data.xlsx）+ 每文件一份 *_summary.json 摘要',
            '流式：读入 readline 逐行、写出 exceljs WorkbookWriter 逐行 commit，峰值内存与文件大小无关',
            '行序：按文件行序输出，不处理 rowIdx（需还原源表行序请用全量版 ruleDir/rule.js）',
            '列顺序取首条有效记录的字段顺序，后续记录新增字段不追加列',
            '坏行（JSON 解析失败/非对象行）跳过并 warn，不中断',
            '选型：xlsx 包（SheetJS）无 .xlsx 流式写出能力，XLSX.stream 仅支持 csv/html/json/xlml 文本导出，故写出端用 exceljs'
        ]
    },
    input: {
        normExt: 'jsonl文件',
        format: 'JSON Lines：每行一个 JSON 对象，字段即 Excel 列'
    },
    output: {
        normExt: 'xlsx文件'
    },
    rely: { 'exceljs': '^4.4.0' }
};
