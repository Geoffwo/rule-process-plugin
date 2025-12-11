const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs-extra');

async function writingRules(inputArray, outputNodeTemplate) {
  // 过滤出docx文件
  const docxFile = inputArray.find(item => item.normExt === 'docx' && item.name === 'template');

  if (!docxFile) {
    console.log('未找到 template.docx，正在生成默认模板...');
    const templatePath = path.join(outputNodeTemplate.path, 'template.docx');
    await createDefaultDocxTemplate(templatePath);
    return [{...outputNodeTemplate, content: '错误: 未找到template.docx模板文件,已创建示例文件'}];
  }

  const contents = []
  await generateReport(docxFile,outputNodeTemplate,contents);


  console.log('\n 所有报告生成完成！');

  // 处理每个文件并生成输出节点
  return [{
    ...outputNodeTemplate,
    normExt:'json',
    content: JSON.stringify(contents,null,2) // 读取Excel内容
  }];
}

async function generateReport(docxFile,outputNodeTemplate,contents){
  const outputDir = outputNodeTemplate.path // 临时目录绝对路径
  const tempDir = path.join(outputDir, './temp') // 临时目录绝对路径
  const docxFilePath = docxFile.path
  
  // 2. 批量生成12个月报告
  for (let month = 1; month <= 12; month++) {
    console.log('开始解压DOCX模板文件...');
    const zip = new AdmZip(docxFilePath);
    await fs.emptyDir(tempDir); // 清空临时目录
    zip.extractAllTo(tempDir, true);//全部解压
    console.log('模板文件解压完成...');

    const result = await generateMonthlyReport(tempDir, outputDir, month);
    contents.push(result);
  }
}

/**
 * 生成单月的调研报告
 * @param {string} tempDir 临时目录
 * @param {string} outputDir 输出目录
 * @param {number} month 月份（1-12）
 * @returns {Promise<{fileName: string, path: string, success: boolean}>} 生成结果
 */
async function generateMonthlyReport(tempDir, outputDir, month) {
  // 构建输出文件名和路径
  const outputFileName = `青岛市电力看汽车制造业分析报告_2025年${month}月.docx`;
  const outputPath = path.join(outputDir, outputFileName);

  try {
    // 格式化月份（补零）
    const formattedMonth = String(month).padStart(2, '0');
    // 构建替换数据（配置化，便于扩展）
    const replaceData = {
      reportType: '名称',
      reportMonth: `2025年${formattedMonth}月`,
    };

    // 3. 替换XML（兼容不同Word版本的页眉/页脚命名）
    const patterns  = [
      path.join(tempDir, 'word/document.xml'),
      path.join(tempDir, 'word/header*.xml'),
      path.join(tempDir, 'word/footer*.xml'),
      path.join(tempDir, 'word/charts/chart*.xml'),
    ];

    const xmlFiles = await expandPatterns(patterns);

    for (const xmlFile of xmlFiles) {
      await replaceXmlContent(xmlFile, replaceData);
    }

    // 重新打包DOCX
    await repackDocx(tempDir, outputPath);
    return {
      outputFileName,
      outputPath,
      success: true
    };
  } catch (err) {
    console.log(`生成${month}月报告失败：${err.message}`);
    return {
      outputFileName,
      outputPath:'',
      success: false,
      error: err.message
    };
  }
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

/**
 * 将带 * 的路径模式展开为真实存在的文件路径列表
 * @param {string[]} patterns - 路径模式数组，如 ['xxx/word/header*.xml']
 * @returns {Promise<string[]>} - 匹配到的真实文件绝对路径数组
 */
async function expandPatterns( patterns) {
  const matchedFiles = new Set(); // 用 Set 去重

  for (const pattern of patterns) {
    const fullPath = pattern;

    // 情况1: 不包含 * → 当作普通文件路径
    if (!pattern.includes('*')) {
      if (await fs.pathExists(fullPath)) {
        matchedFiles.add(fullPath);
      }
      continue;
    }

    // 情况2: 包含 * → 只支持文件名中的单个 *
    const dirPart = path.dirname(fullPath);     // 如 C:/tmp/abc/word
    const baseNamePattern = path.basename(fullPath); // 如 header*.xml

    // 检查目录是否存在
    if (!await fs.pathExists(dirPart)) continue;

    // 将 * 转为正则：header*.xml → /^header.*\.xml$/
    const regexStr = baseNamePattern
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // 转义所有正则特殊字符
        .replace(/\\\*/g, '.*');                // 将 \* 替换为 .*
    const fileRegex = new RegExp(`^${regexStr}$`, 'i');

    try {
      const files = await fs.readdir(dirPart);//读取目录
      for (const file of files) {
        if (fileRegex.test(file)) {
          matchedFiles.add(path.join(dirPart, file));
        }
      }
    } catch (err) {
      if (err.code !== 'ENOTDIR') throw err; // 如果不是“非目录”错误，抛出
    }
  }

  return Array.from(matchedFiles);
}

/**
 * 替换XML文件中的占位符
 * @param {string} xmlPath XML文件绝对路径
 * @param {Record<string, string>} replaceData 替换键值对
 */
async function replaceXmlContent(xmlPath, replaceData) {
  try {
    // 读取文件（兼容UTF8 BOM格式）
    let xmlStr = await fs.readFile(xmlPath, 'utf8');
    let newXmlStr = xmlStr;
    const keys = Object.keys(replaceData);
    keys.forEach(key => {
      const placeholder = `{{${key}}}`;
      const safePlaceholder = placeholder
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // 转义所有正则特殊字符
          .replace(/\\\*/g, '.*');                // 将 \* 替换为 .*
      newXmlStr = newXmlStr.replace(new RegExp(safePlaceholder, 'g'), replaceData[key]);
    });
    await fs.writeFile(xmlPath, newXmlStr, 'utf8');
  } catch (err) {
    console.error(` 替换XML失败（${xmlPath}）：`, err.message);
  }
}

/**
 * 创建一个最小可用的 template.docx 文件（含占位符）
 * @param {string} outputPath - 输出路径，如 ./template.docx
 */
async function createDefaultDocxTemplate(outputPath) {
  const zip = new AdmZip();

  // 1. [Content_Types].xml
  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
  zip.addFile('[Content_Types].xml', Buffer.from(contentTypesXml, 'utf8'));

  // 2. _rels/.rels
  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  zip.addFile('_rels/.rels', Buffer.from(relsXml, 'utf8'));

  // 3. word/document.xml（含占位符）
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:r>
        <w:t>报告类型：{{reportType}}</w:t>
      </w:r>
    </w:p>
    <w:p>
      <w:r>
        <w:t>报告月份：{{reportMonth}}</w:t>
      </w:r>
    </w:p>
    <w:p>
      <w:r>
        <w:t>页眉可包含 {{reportMonth}}（如需，请在页眉中添加相同占位符）</w:t>
      </w:r>
    </w:p>
    <w:sectPr>
      <!-- 可选：添加页眉引用 -->
      <!-- <w:headerReference w:type="default" r:id="rIdHeader"/> -->
    </w:sectPr>
  </w:body>
</w:document>`;
  zip.addFile('word/document.xml', Buffer.from(documentXml, 'utf8'));

  // 4. word/_rels/document.xml.rels
  const docRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <!-- 若需要页眉，可在此添加 header1.xml 引用 -->
</Relationships>`;
  zip.addFile('word/_rels/document.xml.rels', Buffer.from(docRelsXml, 'utf8'));

  // 写入 ZIP 文件
  zip.writeZip(outputPath);
  console.log(`✅ 默认模板已生成：${outputPath}`);
}

// module.exports = writingRules; // 导出主处理函数

module.exports = {
  name: 'docxBatch',
  version: '1.0.1',
  process: writingRules,
  description:'主要用于批量生成docx文件-增强图标修改-特定青岛',
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