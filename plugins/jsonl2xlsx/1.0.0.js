/*
 * jsonl2xlsx（rule-process 插件版）
 * 职责：把 jsonl 文件（每行一个 JSON 对象）转换成 xlsx 表格。
 *
 * 典型链路：icd10check（result.xlsx）→ icd10ai（reviewed.jsonl）→ jsonl2xlsx（reviewed.xlsx）
 * 即：把上游产出的 reviewed.jsonl 放入输入目录，本插件生成同名 reviewed.xlsx。
 *
 * 转换规则：
 *   - 每行一个 JSON 对象 → Excel 一行，字段即列（列顺序取首条记录的字段顺序）
 *   - 所有记录都含数字 rowIdx 时按 rowIdx 升序排序，还原源表行序（如 icd10ai 的输出）
 *   - 坏行（JSON 解析失败）跳过并 warn，不中断
 */
const xlsx = require('xlsx');
const path = require('path');

function writingRules(inputArray, outputNodeTemplate) {
    // 过滤出 jsonl 文件（目录节点 normExt 为空串，不会误匹配）
    const jsonlFiles = inputArray.filter(item => item.normExt === 'jsonl');

    if (jsonlFiles.length === 0) {
        console.log('未找到 jsonl 文件');
        return [{ ...outputNodeTemplate, content: '错误: 未找到 jsonl 文件（每行一个 JSON 对象）' }];
    }

    const contents = [];
    jsonlFiles.forEach(jsonlFile => {
        generateXlsx(jsonlFile, outputNodeTemplate, contents);
    });

    // 处理每个文件并生成输出节点
    return [
        { ...outputNodeTemplate, normExt: 'json', content: JSON.stringify(contents, null, 2) }
    ];
}

function generateXlsx(jsonlFile, outputNodeTemplate, contents) {
    const outputDir = outputNodeTemplate.path; // 输出目录绝对路径
    const fileName = `${jsonlFile.name}.xlsx`;
    const outputPath = path.join(outputDir, fileName);

    try {
        const records = parseJsonl(jsonlFile.content);
        if (records.length === 0) {
            throw new Error('无有效记录（空文件或全部行解析失败）');
        }

        // 所有记录都含数字 rowIdx 时按其升序排序，还原源表行序
        if (records.every(record => typeof record.rowIdx === 'number')) {
            records.sort((a, b) => a.rowIdx - b.rowIdx);
        }

        // 创建新的Excel工作簿（首条记录的字段顺序即列顺序）
        const workbook = xlsx.utils.book_new();
        const worksheet = xlsx.utils.json_to_sheet(records);
        xlsx.utils.book_append_sheet(workbook, worksheet, 'Sheet1');

        // 写入XLSX文件（同步写入，加异常捕获）
        xlsx.writeFile(workbook, outputPath);

        console.log(`已生成: ${outputPath}（${records.length} 行）`);
        contents.push({
            name: fileName,
            path: outputPath,
            rows: records.length,
            success: true
        });
    } catch (writeError) {
        console.log(`XLSX文件写入失败：${writeError.message}`);
        contents.push({
            name: fileName,
            path: '',
            success: false,
            msg: writeError.message
        });
    }
}

/** 解析 JSONL 文本：按行拆分 → 逐行 JSON.parse，坏行/非对象行跳过 */
function parseJsonl(text) {
    return String(text || '').split('\n')
        .filter(line => line.trim().length > 0)
        .map(line => {
            try {
                return JSON.parse(line);
            } catch (e) {
                console.warn('JSONL 单行解析失败，已跳过:', line.slice(0, 80));
                return null;
            }
        })
        .filter(record => record && typeof record === 'object' && !Array.isArray(record));
}

module.exports = {
    name: 'jsonl2xlsx',
    version: '1.0.0',
    process: writingRules,
    description: '将 jsonl 文件转换为 xlsx：每行一个 JSON 对象 → 一行，字段即列；记录含数字 rowIdx 时按其升序还原行序',
    notes: {
        node: '18.20.4',
        tips: [
            '输入约定：jsonl 文件（如 icd10ai 输出的 reviewed.jsonl），每行一个扁平 JSON 对象',
            '输出：与 jsonl 同名的 xlsx（reviewed.jsonl → reviewed.xlsx）+ 运行摘要 json',
            '行序：所有记录都含数字 rowIdx 时按 rowIdx 升序排序（还原源表行序），否则按文件行序',
            '列顺序取首条记录（排序后）的字段顺序',
            '坏行（JSON 解析失败/非对象行）跳过并 warn，不中断'
        ]
    },
    input: {
        normExt: 'jsonl文件',
        format: 'JSON Lines：每行一个 JSON 对象，字段即 Excel 列'
    },
    output: {
        normExt: 'xlsx文件'
    },
    rely: { 'xlsx': '0.18.0' }
};
