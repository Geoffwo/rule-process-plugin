const { execSync } = require('child_process');
const robot = require('robotjs');
const path = require('path');
const AdmZip = require('adm-zip');

/**
 * 基础延迟函数（Promise版），适配不同电脑响应速度
 * @param {number} ms 延迟毫秒数
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 创建默认docx模板
 * @param {string} outputPath 输出路径
 */
async function createEmptyDocx(outputPath) {
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
  <w:body><w:p><w:r><w:t></w:t></w:r></w:p></w:body>
</w:document>`;
    zip.addFile('word/document.xml', Buffer.from(documentXml, 'utf8'));

    // word/_rels/document.xml.rels
    const docRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`;
    zip.addFile('word/_rels/document.xml.rels', Buffer.from(docRelsXml, 'utf8'));

    zip.writeZip(outputPath);
    console.log(` 空白文件已生成：${outputPath}`);
}

/**
 * 核心：批量合并文件（基于robotjs模拟键盘操作）
 * @param {array} inputArray 输入文件元信息数组（格式同原有逻辑：[{path: '文件路径', normExt: 'docx/json'}]）
 * @param {object} outputNodeTemplate 输出节点模板（格式同原有逻辑）
 * @returns {array} 合并结果节点
 */
async function writingRules(inputArray, outputNodeTemplate) {
    // 1. 过滤出需要合并的文件（默认只处理DOCX，可扩展其他文本类文件）
    const docxFiles = inputArray.filter(item =>
        item.normExt === 'docx'
    );

    // 2. 校验输入
    if (docxFiles.length === 0) {
        const errorMsg = '错误：未找到可合并的DOCX文件（文件不存在或格式非DOCX）';
        console.log(errorMsg);
        return [{ ...outputNodeTemplate, content: errorMsg }];
    }

    // 3. 初始化合并目标文件路径
    const outputDir = outputNodeTemplate.path;
    const mergedFileName = `合并文件_${new Date().getTime()}.docx`;
    const mergedFilePath = path.join(outputDir, mergedFileName);

    try {
        // 4. 创建空的目标DOCX文件（避免目标文件不存在）
        await createEmptyDocx(mergedFilePath);

        // 6. 遍历待合并文件，逐一键盘模拟复制粘贴
        for (let i = 0; i < docxFiles.length; i++) {
            const file = docxFiles[i];
            const fileName = path.basename(file.path);
            console.log(`\n正在合并第 ${i+1}/${docxFiles.length} 个文件：${fileName}`);

            // 6.1 打开源文件
            execSync(`start "" "${file.path}"`, { stdio: 'ignore' });
            await sleep(7500); // 等待源文件加载

            // 6.2 模拟全选（Ctrl+A）
            console.log('   → 执行全选（Ctrl+A）');
            robot.keyToggle('control', 'down');
            robot.keyTap('a');
            robot.keyToggle('control', 'up');
            await sleep(1000);

            // 6.3 模拟复制（Ctrl+C）
            console.log('   → 执行复制（Ctrl+C）');
            robot.keyToggle('control', 'down');
            robot.keyTap('c');
            robot.keyToggle('control', 'up');
            await sleep(1000);

            // 6.4 切回目标文件（Alt+Tab）
            // console.log('   → 切回目标文件（Alt+Tab）');
            // robot.keyToggle('alt', 'down');
            // robot.keyTap('tab');
            // robot.keyToggle('alt', 'up');
            // await sleep(2000);

            // 5. 打开目标文件（作为合并的主文件）
            console.log(`   → 打开合并目标文件：${mergedFilePath}`);
            execSync(`start "" "${mergedFilePath}"`, { stdio: 'ignore' });
            await sleep(7500); // 等待WPS/Word完全加载

            // 6.5 模拟粘贴（Ctrl+V）
            console.log('   → 执行粘贴（Ctrl+V）');
            robot.keyToggle('control', 'down');
            robot.keyTap('v');
            robot.keyToggle('control', 'up');
            await sleep(2000);

            // 6.6 插入分隔符（换行+分割线，避免内容粘连）
            console.log('   → 插入分隔符');
            robot.keyTap('enter');
            // robot.keyTap('enter');
            // robot.typeString('--- 分割线 ---');
            // robot.keyTap('enter');
            await sleep(1000);

            // 7. 保存目标文件（Ctrl+S）
            console.log('   → 保存合并后的目标文件（Ctrl+S）');
            robot.keyToggle('control', 'down');
            robot.keyTap('s');
            robot.keyToggle('control', 'up');
            await sleep(1000);

            // 8. 关闭目标文件（Alt+F4）
            console.log('   → 关闭目标文件（Alt+F4）');
            robot.keyToggle('alt', 'down');
            robot.keyTap('f4');
            robot.keyToggle('alt', 'up');
            await sleep(2000);
        }

        // 9. 返回成功结果
        const successMsg = `成功：合并${docxFiles.length}个文件，输出路径：${mergedFilePath}`;
        console.log(`\n ${successMsg}`);
        return [{
            ...outputNodeTemplate,
            fileName: mergedFileName,
            normExt: 'json',
            content: JSON.stringify({
                success: true,
                mergedCount: docxFiles.length,
                mergedFiles: docxFiles.map(f => f.name),
                outputPath: mergedFilePath
            }, null, 2)
        }];

    } catch (err) {
        // 异常处理
        const errorMsg = `合并失败：${err.message}`;
        console.error(errorMsg);
        return [{
            ...outputNodeTemplate,
            content: JSON.stringify({
                success: false,
                error: err.message,
                outputPath: mergedFilePath
            }, null, 2)
        }];
    }
}

// 插件导出（保持和你原有代码一致的格式，便于集成）
module.exports = {
    name: 'docxMerged',
    version: '1.0.0',
    process: writingRules, // 核心处理函数
    description: '基于robotjs的文件批量合并插件，支持DOCX文件，通过模拟start打开文件+Ctrl+A/C/V实现内容合并',
    notes: {
        node: '18.20.4', // 兼容你的Node版本
        tips: [
            '运行前请确保WPS是DOCX默认打开程序',
            '延迟时间（sleep）可根据电脑性能调整（建议8000-15000ms）',
            '运行时请勿操作键盘/鼠标，避免干扰robotjs模拟操作'
        ]
    },
    input: {
        normExt: 'docx', // 支持的输入文件格式
        format: '文件元信息数组：[{path: "文件绝对路径", normExt: "docx", isDirectory: false}]'
    },
    output: {
        normExt: 'docx', // 输出文件格式
        format: '合并后的DOCX文件，内容包含所有源文件内容+回车'
    },
    rely: {
        'robotjs': '0.6.0',
        'adm-zip': '0.5.16'
    }
};