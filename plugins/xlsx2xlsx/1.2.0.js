/**
 * 简化版：ExcelJS WorkbookReader 流式读取，只输出一个文件
 * 功能：过滤掉【二级分类】=违反诊疗规范过度诊疗、过度检查 的行，只保留符合条件行
 */
const path = require('path');
const ExcelJS = require('exceljs');

// 配置集中对象
const config = {
    input_file: '原始数据', // 输入文件匹配关键字
    input_file_header: '二级分类',                              // 过滤依据的表头列名
    input_file_value: '过度检查',     // 需要剔除的分类值
    output_file: '原始数据-新.xlsx', // 输出文件名
};

async function writingRules(inputArray, outputNodeTemplate, ctx) {
    const inputFile = inputArray.find(file => file.name && file.name === config.input_file && file.normExt === 'xlsx');
    if (!inputFile) throw new Error(`未找到输入文件: ${config.input_file}.xlsx`);

    console.log(`[输入] ${inputFile.name}.xlsx，过滤剔除【${config.input_file_header}】=【${config.input_file_value}】行`);

    const outputDir = outputNodeTemplate.path // 临时目录绝对路径
    const outputPath = path.join(outputDir, config.output_file);
    const inputPath = inputFile.path;
    const stats = await streamFilterXlsx(inputPath, outputPath);

    console.log(`过滤完成: 总 ${stats.totalRows} 行，剔除 ${stats.removedRows} 行，保留 ${stats.keptRows} 行`);
    console.log(`输出文件: ${outputPath}`);

    return [{
        ...outputNodeTemplate,
        fileName: 'result',
        normExt: 'json',
        content: JSON.stringify({
            input: inputFile.name,
            removeCategory: config.input_file_value,
            output: { file: config.output_file, path: outputPath, rows: stats.keptRows },
            ...stats
        }, null, 2)
    }];
}

async function streamFilterXlsx(inputPath, outputPath) {
    const stats = { totalRows: 0, removedRows: 0, keptRows: 0 };
    const colCache = new Map();

    // 业务处理钩子
    const onHandle = async (data,writer) => {
        const { sheetName, rowVals, isHeader } = data;
        const sheet = writer.getSheet(sheetName);

        if (isHeader) {
            const idx = rowVals.indexOf(config.input_file_header);
            if (idx === -1) {
                throw new Error(`【${sheetName}】缺少表头【${config.input_file_header}】`);
            }
            colCache.set(sheetName, idx);
            sheet.addRow(rowVals).commit();
            return;
        }

        stats.totalRows++;
        const catIndex = colCache.get(sheetName);
        const cellVal = rowVals[catIndex];
        if (cellVal === config.input_file_value) {
            stats.removedRows++;
        } else {
            stats.keptRows++;
            sheet.addRow(rowVals).commit();
        }
    };

    await streamXlsx(inputPath, outputPath, onHandle);
    return stats;
}


/**
 * 流式Excel文件（ExcelJS流式读写，适合大文件）
 * @param {string} inputPath 源文件路径
 * @param {string} outputPath 输出文件路径
 * @param {Function} onHandle 处理逻辑
 * @returns {Promise<{totalRows:number,removedRows:number,keptRows:number}>} 统计信息
 */
async function streamXlsx(inputPath, outputPath, onHandle) {
    const writer = streamWriterXlsx(outputPath);
    // for await 迭代天然背压：上一行未写完，下一行不解析，无需手工串行队列
    await streamReaderXlsx(inputPath, async (data) => {
        await onHandle(data, writer);
    });
    await writer.commit();
}

/**
 * 打印进度日志
 * @param {object} totalRows
 * @param {number} startTime 开始时间戳 Date.now()
 * @param {number} logEvery 间隔行数
 */
function log(totalRows, startTime, logEvery=10000) {
    if (logEvery <= 0) return;
    if (totalRows % logEvery !== 0) return;

    const elapsedSec = Math.round((Date.now() - startTime) / 1000);
    const speed = elapsedSec > 0 ? Math.round(totalRows / elapsedSec) : 0;
    console.log(`进度: ${totalRows}行 | ${speed}行/s`);
}

/**
 * 流式读取器：只负责读，通过回调吐出数据，不写文件
 * 使用 async iterator（for await）：每次迭代真正 await，
 * 写入慢时自动暂停解析（背压），替代事件回调（事件回调返回的 promise 会被丢弃，无背压保证）
 * @param {string} path
 * @param {Function} onRead 回调：async (data) => {}
 * data: { sheetName:string, rowVals:any[], isHeader:boolean }
 * @returns {Promise<{totalRows:number}>}
 */
async function streamReaderXlsx(path, onRead) {
    // 流式读取器
    const WorkbookReader = ExcelJS.stream.xlsx.WorkbookReader

    const startTime = Date.now();  // 记录开始时间，用于计算速度

    // 初始化流式读取器
    const reader = new WorkbookReader(path, {
        readSharedStrings: true,    // 读取共享字符串（标准xlsx内部格式）
        readStyles: false,          // 不读取样式，提速
        readHyperlinks: false       // 不读取超链接，提速
    });

    let totalRows = 0;

    // 逐个 sheet 迭代（每次 await，天然背压）
    for await (const worksheetReader of reader) {
        const sheetName = worksheetReader.name;
        let header = null;

        // sheet 内逐行迭代（每次 await，天然背压）
        for await (const row of worksheetReader) {
            // row.values[0] 永远是null，是ExcelJS内部占位，slice切掉
            // row.values = [null, "内科", null, "已审核"]
            // slice(1) → ["内科", null, "已审核"]
            // map后 → ["内科", "", "已审核"]
            const rowVals = row.values.slice(1).map(v => v ?? '');

            // 首次行：表头
            if (!header) {
                header = rowVals;
                await onRead({ sheetName, rowVals, isHeader: true });
                continue;
            }

            totalRows++;
            await onRead({ sheetName, rowVals, isHeader: false });

            log(totalRows, startTime);
        }
    }

    return { totalRows };
}

function streamWriterXlsx(path) {
    // 流式写入器
    const WorkbookWriter = ExcelJS.stream.xlsx.WorkbookWriter

    // 创建流式写出实例，不缓存到内存
    const writer = new WorkbookWriter({
        filename: path,       // 输出文件路径
        useStyles: false,           // 不保留单元格样式，提速减体积
        useSharedStrings: false     // 关闭共享字符串表，简化写入逻辑
    });

    const sheetMap = new Map();

    return {
        /** 用到的时候再创建sheet，加入 map 缓存 */
        getSheet(sheetName) {
            if (!sheetMap.has(sheetName)) {
                // 不存在才新建，懒加载
                const sheet = writer.addWorksheet(sheetName);
                sheetMap.set(sheetName, sheet);
            }
            return sheetMap.get(sheetName);
        },
        /** 最终提交写入（必须调用） */
        async commit() {
            // 完成写入、关闭文件
            await writer.commit();
        }
    };
}

module.exports = {
    name: 'xlsx2xlsx',
    version: '1.2.0',
    process: writingRules,
    mode: 'stream', // 明细表800MB，禁止引擎全量读入内存
    description: 'ExcelJS官方流式读取（async iterator 背压），只输出保留后的文件，丢弃疑似过度检查行',
    input: {
        normExt: 'xlsx文件',
        format: '原始数据.xlsx'
    },
    output: {
        normExt: 'xlsx + json摘要',
        format: '原始数据-新.xlsx'
    },
    rely: {
        'exceljs': '4.4.0'
    }
};
