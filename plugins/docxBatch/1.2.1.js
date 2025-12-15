const AdmZip = require('adm-zip');
const xlsx = require('xlsx');
const path = require('path');
const fs = require('fs-extra');

async function writingRules(inputArray, outputNodeTemplate) {
    // 过滤出docx文件
    const docxFile = inputArray.find(item => item.normExt === 'docx' && item.name === 'template');
    const jsonFiles = inputArray.filter(item => item.normExt === 'json');//动态数据
    const zipTempDir = inputArray.find(item => item.name === 'zipTemp' && item.isDirectory === true);
    const outputPath = outputNodeTemplate.path;
    const templatePath = path.join(outputPath, '../inputDir/template.docx');
    const inputPath = path.join(outputPath, '../inputDir');
    const tempPath = path.join(outputPath, '../inputDir/zipTemp');

    if (!docxFile) {
        console.log('未找到 template.docx，正在生成默认模板...');
        await createDefaultDocxTemplate(templatePath);
        return [{ ...outputNodeTemplate, content: '错误: 未找到template.docx模板文件,已创建示例文件' }];
    }

    if (jsonFiles.length === 0) {
        console.log('未找到 jsonFiles动态数据');
        const jsonTemplate = createDefaultJsonTemplate();
        return [
            { ...outputNodeTemplate, path: inputPath, fileName: 'template', normExt: 'json', content: JSON.stringify(jsonTemplate, null, 2) },
            { ...outputNodeTemplate, content: '错误: 未找到jsonFiles动态数据' }
        ];
    }

    if (!zipTempDir) {
        console.log('未找到docx模板解压文件...');
        await unzipDocx(docxFile, tempPath);
        // 解压后重新过滤inputArray（模拟新增解压文件），实际场景需根据业务补充
        return [{ ...outputNodeTemplate, content: '错误: 未找到docx模板解压文件,已创建解压文件' }];
    }

    // 合并所有json数据
    const replaceData = processData(jsonFiles);
    const contents = [];
    // 传递tempPath和replaceData
    await generateReport(outputPath, replaceData, tempPath, inputArray, contents);

    console.log('\n 所有报告生成完成！');

    // 处理每个文件并生成输出节点
    return [{
        ...outputNodeTemplate,
        normExt: 'json',
        content: JSON.stringify(contents, null, 2)
    }];
}

function processData(jsonFiles){
    const data = [...jsonFiles];

    //返回obj对象 按照实际逻辑处理
    return JSON.parse(data[0].content)
}

async function unzipDocx(docxFile, tempPath) {
    const docxFilePath = docxFile.path;

    console.log('开始解压DOCX模板文件...');
    const zip = new AdmZip(docxFilePath);
    await fs.emptyDir(tempPath);
    zip.extractAllTo(tempPath, true);
    console.log('模板文件解压完成...');
}

/**
 * 生成Word文档（支持嵌套循环，不修改模板格式）
 * @param {string} outputPath - 输出目录
 * @param {object} replaceData - 替换数据
 * @param {string} tempDir - 解压临时目录
 * @param {array} inputArray - 文件元信息数组
 * @param {array} contents - 结果收集数组
 */
async function generateReport(outputPath, replaceData, tempDir, inputArray, contents) {
    try {
        // 工具函数：保留两位小数（避免浮点数精度问题）
        const toFixed2 = (num) => Number(num.toFixed(2));

        // 工具函数：生成指定范围的随机数
        const getRandom = (min, max) => Math.random() * (max - min) + min;

        // 定义时间区间对应的index（6:00=24，19:00=76）
        // 6:00-8:00 对应index 24-32，取起始点24作为策略开始
        const startIndex = Number(getRandom(6,8).toFixed(0))*4;
        // 17:00-19:00 对应index 68-76，取结束点76作为策略结束
        const endIndex = Number(getRandom(17,19).toFixed(0))*4;

        // 示例：replaceData 模拟数据（实际以业务传入为准）
        // const replaceData = [{ name: "夏季空调基线", data: [{ 基线: 26.5 }, ...] }];
        const xlsxName = replaceData[0].name;
        const xlsxData = replaceData[0].data; // 96点数据，每15分钟一个点

        // 最终处理后的96点数据对象/数组（推荐数组格式更易遍历）
        const resultData = [];

        for (let index = 0; index < xlsxData.length; index++) {
            const item = xlsxData[index];
            const originBase = item["基线"]; // 原始基线值
            const dataItem = {};

            // 1. 格式化时间：index转 时:分（如 6:00、17:15）
            const hour = Math.floor(index / 4); // 每4个index=1小时（15分钟/点）
            const minute = (index % 4) * 15;    // 分钟：0/15/30/45
            dataItem[""] = `${hour}:${minute.toString().padStart(2, '0')}`;

            // 2. 计算原始基线（乘以0.95-1.05随机数 + ±0.01浮动，保留两位）
            const baseRandom = getRandom(0.95, 1.05); // 0.95-1.05随机数
            const baseFloat = getRandom(-0.01, 0.01); // ±0.01浮动
            const calcBase = toFixed2(originBase * baseRandom + baseFloat);
            dataItem["基线"] = calcBase;

            // 4. 策略起点/终点（index=24 或 76）：温度控/定时控 = 基线
            if (index === startIndex || index === endIndex) {
                dataItem["温度控"] = calcBase;
                dataItem["定时控"] = calcBase;
            }

            // 5. 策略区间内（24 < index < 76）：按规则计算
            if (index > startIndex && index < endIndex) {
                // 5.1 温度控：24±1随机浮动（保留两位）
                const tempFloat = getRandom(-1, 1); // -1到1随机数
                const calcTemp = toFixed2(24 + tempFloat);
                dataItem["温度控"] = calcTemp;

                // 5.2 定时控：基线&温度控的平均值 + 随机浮动，且不超出两者范围
                const minVal = Math.min(calcBase, calcTemp);// 最小值（基线/温度控）
                const maxVal = Math.max(calcBase, calcTemp); // 最大值（基线/温度控）
                const avgVal = (calcBase + calcTemp) / 2;    // 平均值
                const timerFloat = getRandom(-0.5, 0.5);     // 平均值±0.5浮动
                let calcTimer = toFixed2(avgVal + timerFloat);

                // 限制定时控在[minVal, maxVal]范围内
                calcTimer = Math.max(minVal, Math.min(maxVal, calcTimer));
                dataItem["定时控"] = toFixed2(calcTimer);
            }

            // 推入结果数组（推荐数组格式，便于后续导出/展示）
            resultData.push(dataItem);
        }

        // 最终输出：resultData 是包含96个对象的数组，每个对象含「时间、基线、温度控、定时控」
        console.log("处理后96点温度数据：", resultData);
        console.log("Excel名称：", xlsxName);
        const endData = [
            {
                "name": "Sheet1",
                "data": resultData
            }
        ]
        // ========== 关键修改1：调用函数替换嵌入的Workbook1.xlsx ==========
        await generateAndReplaceEmbeddedExcel(tempDir, endData);

        const getTimeByIndex = (index)=>{
            // 1. 格式化时间：index转 时:分（如 6:00、17:15）
            const hour = Math.floor(index / 4); // 每4个index=1小时（15分钟/点）
            const minute = (index % 4) * 15;    // 分钟：0/15/30/45
            return `${hour}:${minute.toString().padStart(2, '0')}`;
        }

        const dataProcess={
            timing_startIndex:getTimeByIndex(startIndex),
            timing_endIndex:getTimeByIndex(endIndex),
        }
        const options = {
            tempDir,
            outputPath,
            replaceData: dataProcess,
            inputArray
        };
        // 收集替换后的XML内容（内存缓存，不修改原模板）
        const replacedXmlContents = await generateSingleReport(options);

        // 重新打包DOCX（使用内存中的替换后内容，原模板文件不变）
        const outputFile = path.join(outputPath, `居民用户评估报告_${new Date().getTime()}.docx`);
        await repackDocx(tempDir, outputFile, replacedXmlContents);

        contents.push({ outputPath: outputFile, success: true });
        console.log(`文档生成成功：${outputFile}`);
    } catch (err) {
        contents.push({ outputPath: '', success: false, error: err.message });
        console.error('生成失败：', err.message);
    }
}

// ========== 关键新增函数：生成并替换嵌入的Workbook1.xlsx ==========
/**
 * 生成新的Excel并替换DOCX解压目录中embeddings下的Workbook1.xlsx
 * @param {string} tempDir DOCX解压临时目录
 * @param jsonData
 */
async function generateAndReplaceEmbeddedExcel(tempDir, jsonData) {
    try {
        // 1. 定义嵌入Excel的路径（DOCX标准嵌入路径：word/embeddings/Workbook1.xlsx）
        const embeddedExcelDir = path.join(tempDir, 'word', 'embeddings');
        const embeddedExcelPath = path.join(embeddedExcelDir, 'Workbook1.xlsx');

        // 2. 确保embeddings目录存在（若原模板无此目录则创建）
        await fs.ensureDir(embeddedExcelDir);
        console.log(`确认/创建嵌入Excel目录：${embeddedExcelDir}`);

        // 创建新的Excel工作簿
        const workbook = xlsx.utils.book_new();
        // 遍历每个sheet数据
        jsonData.forEach(item => {
            const sheetName = item.name; // sheet名称（市南/市北等）
            let sheetData = item.data;   // sheet数据

            // 统一数据格式：如果是对象，转为包含该对象的数组
            if (!Array.isArray(sheetData)) {
                sheetData = [sheetData];
            }

            // 将JSON数组转换为Excel工作表
            const worksheet = xlsx.utils.json_to_sheet(sheetData);

            // 将工作表添加到工作簿
            xlsx.utils.book_append_sheet(workbook, worksheet, sheetName);
        });

        // 5. 写入XLSX文件（同步写入，加异常捕获）
        xlsx.writeFile(workbook, embeddedExcelPath);
        console.log(`✅ 嵌入Excel替换完成：${embeddedExcelPath}`);

        // 5. 若需要更新inputArray（让后续XML处理感知文件变化，可选）
        // 可根据业务场景补充inputArray的更新逻辑
    } catch (err) {
        throw new Error(`替换嵌入Excel失败：${err.message}`);
    }
}

/**
 * 重新打包DOCX文件（优先使用内存中的替换后XML内容，原模板文件不修改）
 * @param {string} tempDir 临时解压目录（原模板）
 * @param {string} outputPath 输出文件路径
 * @param {object} replacedXmlContents 替换后的XML内容映射 { 文件相对路径: 新内容 }
 */
async function repackDocx(tempDir, outputPath, replacedXmlContents = {}) {
    try {
        const newZip = new AdmZip();
        const files = await fs.readdir(tempDir, { withFileTypes: true, recursive: true });

        for (const file of files) {
            if (file.isFile()) {
                const filePath = path.join(file.path, file.name);
                // 计算相对于tempDir的路径（保证ZIP内路径正确）
                const zipRelativePath = path.relative(tempDir, filePath).replace(/\\/g, '/');
                let fileContent;

                // 优先使用内存中替换后的内容，否则读取原模板文件
                if (replacedXmlContents[zipRelativePath]) {
                    fileContent = Buffer.from(replacedXmlContents[zipRelativePath], 'utf8');
                    console.log(`使用替换后的内容打包：${zipRelativePath}`);
                } else {
                    fileContent = await fs.readFile(filePath);
                }

                newZip.addFile(zipRelativePath, fileContent);
            }
        }

        // 写入ZIP文件
        newZip.writeZip(outputPath);
        console.log(`DOCX生成成功：${outputPath}`);
    } catch (err) {
        throw new Error(`重新打包DOCX失败：${err.message}`);
    }
}

/**
 * 处理单个文档替换（内存替换，不修改原模板文件）
 * @param {object} options - 配置项
 * @param {string} options.tempDir - 解压目录
 * @param {string} options.outputPath - 输出路径
 * @param {object} options.replaceData - 替换数据
 * @param {array} options.inputArray - 文件元信息数组
 * @returns {object} 替换后的XML内容映射 { 相对路径: 新内容 }
 */
async function generateSingleReport(options = {}) {
    const { tempDir, replaceData, inputArray } = options;
    if (!tempDir || !replaceData || !inputArray) {
        throw new Error('generateSingleReport缺少必要参数：tempDir/replaceData/inputArray');
    }

    // 从inputArray筛选需要处理的XML文件（替代原expandPatterns逻辑）
    const xmlFilePatterns = [
        'word/document.xml',
        'word/header', // 匹配header*.xml
        'word/footer', // 匹配footer*.xml
        'word/charts/chart' // 匹配chart*.xml
    ];
    const xmlFiles = inputArray.filter(item => {
        if (item.isDirectory) return false;
        const relativePath = path.relative(tempDir, item.path).replace(/\\/g, '/');
        return xmlFilePatterns.some(pattern =>
            relativePath.startsWith(pattern) && relativePath.endsWith('.xml')
        );
    });

    if (xmlFiles.length === 0) {
        throw new Error('未从inputArray中找到需要处理的XML文件（document/header/footer/chart）');
    }

    // 收集替换后的XML内容（相对路径 -> 新内容）
    const replacedXmlContents = {};
    for (const xmlFile of xmlFiles) {
        const relativePath = path.relative(tempDir, xmlFile.path).replace(/\\/g, '/');
        // 执行替换（无兜底，失败直接抛错）
        const newXmlContent = await replaceXmlContent(xmlFile.path, replaceData, inputArray);
        replacedXmlContents[relativePath] = newXmlContent;
    }

    return replacedXmlContents;
}

/**
 * 替换XML文件中的占位符（仅从inputArray读取，无兜底，不修改原文件）
 * @param {string} xmlPath XML文件绝对路径
 * @param {Record<string, string>} replaceData 替换键值对
 * @param {array} inputArray 文件元信息数组
 * @returns {string} 替换后的XML内容
 */
async function replaceXmlContent(xmlPath, replaceData, inputArray = []) {
    // 1. 从inputArray查找目标文件（无兜底，找不到直接报错）
    const targetFile = inputArray.find(item => item.path === xmlPath);
    if (!targetFile) {
        throw new Error(`未在inputArray中找到目标XML文件：${xmlPath}`);
    }

    // 2. 检查content是否存在（无数据直接报错）
    if (targetFile.content === null || targetFile.content === undefined || targetFile.content === '') {
        throw new Error(`目标XML文件内容为空：${xmlPath}`);
    }

    console.log(`从inputArray读取内容并替换：${xmlPath}`);
    let xmlContent = targetFile.content;

    // 3. 处理条件判断
    xmlContent = processIfBlocks(xmlContent, replaceData);
    // 4. 处理循环列表
    xmlContent = processLoopBlocks(xmlContent, replaceData);
    // 5. 替换基础变量
    xmlContent = replaceVariables(xmlContent, replaceData);
    // 仅返回替换后的内容，不写入文件（保持原模板不变）
    return xmlContent;
}

/** 处理条件区块 */
function processIfBlocks(xml, data) {
    const ifRegex = /\{if_start:(\w+)\}([\s\S]*?)\{if_end:\1\}/g;
    return xml.replace(ifRegex, (match, flagName, blockContent) => {
        // 简化版条件判断：直接判断数据中是否存在该字段且为true
        return data[flagName] ? blockContent : '';
    });
}

/** 处理循环区块（核心：支持嵌套循环，递归调用） */
function processLoopBlocks(xml, data) {
    const loopRegex = /\{loop_start:(\w+)\}([\s\S]*?)\{loop_end:\1\}/g;

    const processedXml = xml.replace(loopRegex, (match, loopFlag, itemTemplate) => {
        const loopData = data[loopFlag] || [];
        if (!Array.isArray(loopData)) return '';

        return loopData.map(item => {
            // 替换当前循环变量
            let itemContent = itemTemplate.replace(
                new RegExp(`\\{${loopFlag}_var:(\\w+(?:\\.\\w+)*)\\}`, 'g'),
                (subMatch, subKey) => escapeXml(getNestedValue(item, subKey) ?? '')
            );

            // 递归处理内层循环
            itemContent = processLoopBlocks(itemContent, item);
            return itemContent;
        }).join('');
    });

    return processedXml;
}

/** 替换基础变量 */
function replaceVariables(xml, data) {
    return xml.replace(/\{var:(\w+(?:\.\w+)*)\}/g, (match, key) => {
        const value = getNestedValue(data, key);
        return escapeXml(value ?? '');
    });
}

/** 辅助函数：获取嵌套属性值 */
function getNestedValue(obj, key) {
    return key.split('.').reduce((acc, curr) => {
        return acc && acc[curr] !== undefined ? acc[curr] : null;
    }, obj);
}

/** 辅助函数：XML特殊字符转义 */
function escapeXml(str) {
    if (typeof str !== 'string') str = String(str);
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * 创建默认docx模板
 * @param {string} outputPath 输出路径
 */
async function createDefaultDocxTemplate(outputPath) {
    const zip = new AdmZip();

    // [Content_Types].xml
    const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
    zip.addFile('[Content_Types].xml', Buffer.from(contentTypesXml, 'utf8'));

    // _rels/.rels
    const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
    zip.addFile('_rels/.rels', Buffer.from(relsXml, 'utf8'));

    // word/document.xml
    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:r>
        <w:t>报告名称：{var:reportTitle}</w:t>
      </w:r>
    </w:p>
    <w:p>
      <w:r>
        <w:t>报告时间：{var:reportTime}</w:t>
      </w:r>
    </w:p>
    <w:p>
      <w:r>
        <w:t>{if_start:showCategoryCount}分类数量≥2{if_end:showCategoryCount}</w:t>
      </w:r>
    </w:p>
    <w:p>
      <w:r>
        <w:t>{loop_start:categories}</w:t>
      </w:r>
    </w:p>
    <w:p>
      <w:r>
        <w:t>{categories_var:categoryName}-{var:reportTitle}</w:t>
      </w:r>
    </w:p>
    <w:p>
      <w:r>
        <w:t>{loop_end:categories}</w:t>
      </w:r>
    </w:p>
    <w:p>
      <w:r>
        <w:t>{loop_start:categories}{loop_start:products}</w:t>
      </w:r>
    </w:p>
    <w:p>
      <w:r>
        <w:t>{categories_var:categoryName}-{products_var:productName}</w:t>
      </w:r>
    </w:p>
    <w:p>
      <w:r>
        <w:t>{loop_end:products}{loop_end:categories}</w:t>
      </w:r>
    </w:p>
  </w:body>
</w:document>`;
    zip.addFile('word/document.xml', Buffer.from(documentXml, 'utf8'));

    // word/_rels/document.xml.rels
    const docRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`;
    zip.addFile('word/_rels/document.xml.rels', Buffer.from(docRelsXml, 'utf8'));

    zip.writeZip(outputPath);
    console.log(`✅ 默认模板已生成：${outputPath}`);
}

/** 创建默认JSON模板 */
function createDefaultJsonTemplate() {
    return {
        reportTitle: '2024年家电产品全品类规格报告',
        reportTime: new Date().toLocaleString('zh-CN'),
        showCategoryCount: true,
        categories: [
            { categoryName: '冰箱', products: [{ productName: '十字门冰箱' },{ productName: '老式冰箱' }] },
            { categoryName: '空调', products: [{ productName: '一级能效空调' }] }
        ]
    };
}

module.exports = {
    name: 'docxBatch',
    version: '1.2.0',
    process: writingRules,
    description: '主要用于批量生成docx文件-提取通用文档循环逻辑',
    notes: {
        node: '18.20.4',
    },
    input: {
        normExt: 'template.docx文件',
        format: '${{变量名}}'
    },
    output: {
        normExt: '[1-12]月.docx',
        format: '${{变量名}}->替换值'
    },
    rely: {
        'adm-zip': '0.5.16'
    }
};


