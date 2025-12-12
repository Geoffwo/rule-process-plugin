const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs-extra');

const year = 2025
const month = 10

async function writingRules(inputArray, outputNodeTemplate) {
  const outputDir = outputNodeTemplate.path // 临时目录绝对路径
  const tempDir = path.join(outputDir, './temp') // 临时目录绝对路径

  // 构建输出文件名和路径
  const outputFileName = `青岛市电力看汽车制造业分析报告_${year}年${month}月.docx`;
  const outputPath = path.join(outputDir, outputFileName);
  await repackDocx(tempDir, outputPath);
}

/**
 * 重新打包DOCX文件
 * @param {string} tempDir 临时解压目录
 * @param {string} outputPath 输出文件路径
 */
async function repackDocx(tempDir, outputPath) {
  try {
    const newZip = new AdmZip();
    // 递归读取临时目录所有文件
    const files = await fs.readdir(tempDir, { withFileTypes: true, recursive: true });

    for (const file of files) {
      if (file.isFile()) {
        const filePath = path.join(file.path, file.name);
        // 计算相对于tempDir的路径（保证ZIP内路径正确）
        const zipRelativePath = path.relative(tempDir, filePath).replace(/\\/g, '/');
        // 读取文件内容并添加到ZIP
        const fileContent = await fs.readFile(filePath);
        newZip.addFile(zipRelativePath, fileContent);
      }
    }

    // 写入ZIP文件
    newZip.writeZip(outputPath);

    // 验证文件是否生成成功
    console.log(`DOCX生成成功：${outputPath}`);
  } catch (err) {
    console.log(`重新打包DOCX失败：${err.message}`);
  }
}

// module.exports = writingRules; // 导出主处理函数

module.exports = {
  name: 'docxBatch',
  version: '1.1.2',
  process: writingRules,
  description:'主要用于批量生成docx文件-特定青岛-对1.0.4进行打包为docx',
  notes:{
    node:'18.20.4',
  },
  input: {
    normExt: 'template.docx文件',
    format: '${{变量名}}'
  },
  output: {
    normExt: '[1-12]月.docx',
    format: '${{变量名}}->替换值'
  },
  rely:{//默认 latest
    'adm-zip': '0.5.16'
  }
};