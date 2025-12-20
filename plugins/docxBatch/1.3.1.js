const AdmZip = require('adm-zip');
const { execSync  } = require('child_process');
const robot = require('robotjs');
const path = require('path');
const fs = require('fs-extra');

async function writingRules(inputArray, outputNodeTemplate) {
    // 过滤出docx文件
    const docxFile = inputArray.find(item => item.normExt === 'docx' && item.name === 'template');
    const jsonFiles = inputArray.filter(item => item.normExt === 'json');//动态数据
    const batchFiles = inputArray.filter(item => item.normExt === 'docx');
    const outputPath = outputNodeTemplate.path;
    const inputPath = path.join(outputPath, '../inputDir');
    const templatePath = path.join(inputPath, './template.docx');


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

    // 核心判断：检查所有 batchFile 是否都能在 inputArray 找到对应的同名目录
    const allDirExist = batchFiles.every(batchFile => {
        return inputArray.some(item => item.name === batchFile.name && item.isDirectory === true );
    });

    if (!allDirExist) {
        console.log('批量处理docx文件解压...');
        for (const batchFile of batchFiles) {
            const tempPath = path.join(inputPath, batchFile.name);
            await unzipDocx(batchFile, tempPath);
        }
        // 解压后重新过滤inputArray（模拟新增解压文件），实际场景需根据业务补充
        return [{ ...outputNodeTemplate, content: '错误: 未找到docx解压文件,已创建解压文件' }];
    }

    const contents = [];
    // 传递tempPath和replaceData
    await generateReport(inputPath, jsonFiles, batchFiles, inputArray, contents);

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
    const jsonFile = data.find(item=>item.name==='template');

    //返回obj对象 按照实际逻辑处理
    return JSON.parse(jsonFile.content)
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
 * @param {object} jsonFiles - 所有数据
 * @param batchFiles - 所有docx文件
 * @param {array} inputArray - 文件元信息数组
 * @param {array} contents - 结果收集数组
 */
async function generateReport(outputPath, jsonFiles, batchFiles, inputArray, contents) {
    try {
        for (const batchFile of batchFiles) {
            const tempDir = path.join(batchFile.dir,batchFile.name)
            // 获取特定数据
            const replaceData = processData(jsonFiles);
            const options = {
                tempDir,
                outputPath,
                replaceData,
                inputArray
            };
            // 收集替换后的XML内容（内存缓存，不修改原模板）
            const replacedXmlContents = await generateSingleReport(options);

            // 重新打包DOCX（使用内存中的替换后内容，原模板文件不变）
            const outputFile = path.join(outputPath, `调研报告_${new Date().getTime()}.docx`);
            await repackDocx(tempDir, outputFile,inputArray, replacedXmlContents);

            console.log(`正在触发OOXML规则自动修正：${outputFile}`);
            await updateOOXML(outputFile)

            contents.push({ outputPath: outputFile, success: true });
            console.log(`文档生成成功：${outputFile}`);
        }
    } catch (err) {
        contents.push({ outputPath: '', success: false, error: err.message });
        console.error('生成失败：', err.message);
    }
}

/**
 * 基础延迟函数（Promise版）
 * @param {number} ms 延迟毫秒数
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 修复OOXML格式（异步封装+容错+动态延迟）
 * 也可以用libreOffice无界面处理，但是libreOffice和wps格式存在不兼容
 * @param {string} outputFile - 文档路径
 * @returns {Promise<void>} 确保异步流程可等待
 */
async function updateOOXML(outputFile){
    // 1. 同步执行打开文档命令（阻塞直到命令执行完成）
    // 注意：start命令本身是异步打开程序，execSync仅等待命令发送完成，而非程序加载完成
    execSync(`start "" "${outputFile}"`, {
        stdio: 'ignore' // 忽略命令输出，避免控制台打印无关信息
    });

    await sleep(7500);
    // 2. 模拟输入空格 → 清除空格（触发文档修改）
    console.log('执行输入/清除空格操作...');
    robot.keyTap('space'); // 输入空格

    await sleep(1000);
    robot.keyTap('backspace'); // 清除空格


    // 主动保存（Ctrl+S）→ 关闭（Alt+F4）
    await sleep(1000);
    console.log('模拟 Ctrl+S 保存文档...');
    // 组合键模拟 Ctrl+S
    robot.keyToggle('control', 'down');
    robot.keyTap('s');
    robot.keyToggle('control', 'up');

    await sleep(1000);
    console.log('模拟 Alt+F4 关闭文档...');
    // 组合键模拟 Alt+F4
    robot.keyToggle('alt', 'down');
    robot.keyTap('f4');
    robot.keyToggle('alt', 'up');
    console.log('操作完成');
}

/**
 * 修复OOXML格式（异步封装+容错+动态延迟）
 * @param {string} outputFile - 文档路径
 * @returns {Promise<void>} 确保异步流程可等待
 */
async function updateChartData(outputFile){
    // 1. 同步执行打开文档命令（阻塞直到命令执行完成）
    // 注意：start命令本身是异步打开程序，execSync仅等待命令发送完成，而非程序加载完成
    execSync(`start "" "${outputFile}"`, {
        stdio: 'ignore' // 忽略命令输出，避免控制台打印无关信息
    });

    await sleep(7500);
    //2. 开始 选型卡（Alt+H）
    console.log('模拟 Alt+H 选择 开始 选项卡...');
    // 组合键模拟 Alt+H
    robot.keyToggle('alt', 'down');
    robot.keyTap('h');
    robot.keyToggle('alt', 'up');

    await sleep(1000);
    console.log('模拟 选择第一个图表...');
    // 选择（SL）→ 选择对象（O）->选择第一个图表（tab）
    robot.keyTap('s');
    robot.keyTap('l');

    await sleep(300);
    robot.keyTap('o');

    //从这里开始循环 循环次数有chart.xml/xlsx数量决定
    await sleep(300);
    robot.keyTap('tab');

    //2. 图表工具 选型卡（Alt+JC）
    console.log('模拟 Alt+JC 选择 图表工具 选项卡...');
    await sleep(1000);
    // 组合键模拟 Alt+JC
    robot.keyToggle('alt', 'down');
    robot.keyTap('j');
    robot.keyTap('c');
    robot.keyToggle('alt', 'up');

    // 编辑数据
    console.log('模拟 编辑数据 更新数据缓存...');
    await sleep(1000);
    robot.keyTap('e');

    // 关闭数据文档
    console.log('模拟 Alt+F4 关闭数据文档...');
    await sleep(1000);
    // 组合键模拟 Alt+F4
    robot.keyToggle('alt', 'down');
    robot.keyTap('f4');
    robot.keyToggle('alt', 'up');

    //循环结束

    // 7. 保存并关闭文档
    console.log('模拟 Ctrl+S 保存修改...');
    await sleep(1000);
    robot.keyToggle('control', 'down');
    robot.keyTap('s');
    robot.keyToggle('control', 'up');

    console.log('模拟 Alt+F4 关闭文档...');
    await sleep(1000);
    robot.keyToggle('alt', 'down');
    robot.keyTap('f4');
    robot.keyToggle('alt', 'up');

    console.log('图表数据更新完成');
}

/**
 * 重新打包DOCX文件（优先使用内存中的替换后XML内容，原模板文件不修改）
 * @param {string} tempDir 临时解压目录（原模板）
 * @param {string} outputPath 输出文件路径
 * @param {object} replacedXmlContents 替换后的XML内容映射 { 文件相对路径: 新内容 }
 */
async function repackDocx2(tempDir, outputPath, replacedXmlContents = {}) {
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

async function repackDocx(tempDir, outputPath,inputArray, replacedXmlContents = {}) {
    try {
        const newZip = new AdmZip();
        const files = inputArray.filter(item=>item.path.startsWith(tempDir));
        for (const file of files) {
            if (!file.isDirectory) {
                const filePath = file.path;
                // 计算相对于tempDir的路径（保证ZIP内路径正确）
                const zipRelativePath = path.relative(tempDir, filePath).replace(/\\/g, '/');
                let fileContent;

                // 优先使用内存中替换后的内容，否则读取原模板文件
                if (replacedXmlContents[zipRelativePath]) {
                    fileContent = Buffer.from(replacedXmlContents[zipRelativePath], 'utf8');
                    console.log(`使用替换后的内容打包：${zipRelativePath}`);
                } else {
                    fileContent = file.content;
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
        //path.relative(from, to) 计算并返回从 from 路径到 to 路径的「相对路径字符串」。
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
    version: '1.3.1',
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