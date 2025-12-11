const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs-extra');

const year = 2025

async function writingRules(inputArray, outputNodeTemplate) {
  // 过滤出docx文件
  const docxFile = inputArray.find(item => item.normExt === 'docx' && item.name === 'template');
  const jsonFiles = inputArray.filter(item => item.normExt === 'json');//动态数据

  if (!docxFile) {
    console.log('未找到 template.docx，正在生成默认模板...');
    const templatePath = path.join(outputNodeTemplate.path, 'template.docx');
    await createDefaultDocxTemplate(templatePath);
    return [{...outputNodeTemplate, content: '错误: 未找到template.docx模板文件,已创建示例文件'}];
  }

  if (jsonFiles.length===0) {
    console.log('未找到 jsonFiles动态数据');
    return [{...outputNodeTemplate, content: '错误: 未找到jsonFiles动态数据'}];
  }

  const contents = []
  await generateReport(docxFile,outputNodeTemplate,contents,jsonFiles);


  console.log('\n 所有报告生成完成！');

  // 处理每个文件并生成输出节点
  return [{
    ...outputNodeTemplate,
    normExt:'json',
    content: JSON.stringify(contents,null,2) // 读取Excel内容
  }];
}

async function generateReport(docxFile,outputNodeTemplate,contents,jsonFiles){
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

    const result = await generateMonthlyReport(tempDir, outputDir, month,jsonFiles);
    contents.push(result);
  }
}

/**
 * 生成单月的调研报告
 * @param {string} tempDir 临时目录
 * @param {string} outputDir 输出目录
 * @param {number} month 月份（1-12）
 * @param jsonFiles
 * @returns {Promise<{fileName: string, path: string, success: boolean}>} 生成结果
 */
async function generateMonthlyReport(tempDir, outputDir, month,jsonFiles) {
  // 构建输出文件名和路径
  const outputFileName = `青岛市电力看汽车制造业分析报告_${year}年${month}月.docx`;
  const outputPath = path.join(outputDir, outputFileName);
  // 格式化月份（补零）
  const formattedMonth = String(month).padStart(2, '0');
  const jsonFile = jsonFiles.find(item=>item.name===`${year}年${formattedMonth}月`);

  if(!jsonFile){
    console.log(`生成${month}月报告失败：缺失json数据`);
    return {
      outputFileName,
      outputPath:'',
      success: false,
      error: '缺失json数据'
    };
  }

  const replace = processJsonData(jsonFile)
  // console.log('replace',replace);
  const xAxisData = xAxis(month);
  const xAxisJqData = xAxisJq(xAxisData,jsonFiles);
  const xAxisYdData = xAxisYd(xAxisData,jsonFiles);
  const xAxisGmData = xAxisGm(xAxisData,jsonFiles);

  try {
    // 构建替换数据（配置化，便于扩展）
    const replaceData = {
      reportType: '名称',
      reportMonth: `${year}年${month}月`,
      ...replace,
      ...xAxisData,
      ...xAxisJqData,
      ...xAxisYdData,
      ...xAxisGmData,
    };

    console.log('replaceData',replaceData);

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
    }
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

function xAxisJq(xAxisData,jsonFiles){
  const keys = Object.keys(xAxisData);
  // 2. 初始化返回结果（默认值0）
  const result = {};

  keys.forEach((key, index)=>{
    const jsonFile = jsonFiles.find(item=>item.name===xAxisData[key]) || {content:'[]'}
    const content = JSON.parse(jsonFile.content)
    const qingDaoData = content.find(item=>item.name.includes('青岛'));
    const qingDao = qingDaoData?.data || {};
    // 生成字段名：numValue01 ~ numValue10
    const fieldName = 3100801 + index;
    result[fieldName] = qingDao['电力景气指数'] || 0;
  })
  return result
}

function xAxisYd(xAxisData,jsonFiles){
  const keys = Object.keys(xAxisData);
  // 2. 初始化返回结果（默认值0）
  const result = {};

  keys.forEach((key, index)=>{
    const jsonFile = jsonFiles.find(item=>item.name===xAxisData[key]) || {content:'[]'}
    const content = JSON.parse(jsonFile.content)
    const qingDaoData = content.find(item=>item.name.includes('青岛'));
    const qingDao = qingDaoData?.data || {};
    // 生成字段名：numValue01 ~ numValue10
    const fieldName = 3200801 + index;
    result[fieldName] = qingDao['用电增长指数'] || 0;
  })
  return result
}

function xAxisGm(xAxisData,jsonFiles){
  const keys = Object.keys(xAxisData);
  // 2. 初始化返回结果（默认值0）
  const result = {};

  keys.forEach((key, index)=>{
    const jsonFile = jsonFiles.find(item=>item.name===xAxisData[key]) || {content:'[]'}
    const content = JSON.parse(jsonFile.content)
    const qingDaoData = content.find(item=>item.name.includes('青岛'));
    const qingDao = qingDaoData?.data || {};
    // 生成字段名：numValue01 ~ numValue10
    const fieldName = 3300801 + index;
    result[fieldName] = qingDao['规模增长指数'] || 0;
  })
  return result
}

function xAxis(month) {
  // 1. 入参容错：确保month是1-12的整数，否则默认1月
  const targetMonth = Math.max(1, Math.min(12, Number(month) || 1));
  // console.log('targetMonth',targetMonth);
  // 2. 获取当前年份
  const currentYear = year //new Date().getFullYear();
  // 3. 构建12个索引的日期映射（xIndex12→targetMonth，向前倒推）
  const result = {};

  // 遍历12个索引（xIndex1 到 xIndex12）
  for (let i = 1; i <= 12; i++) {
    // 计算当前索引对应的偏移月：xIndex12偏移0，xIndex11偏移-1，…，xIndex1偏移-11
    const offset = 12 - i;
    // 计算目标月份 = 传入月份 - 偏移量
    let calcMonth = targetMonth - offset;
    // 计算年份（处理跨年：calcMonth≤0时，年份-1，月份+12）
    let calcYear = currentYear;
    if (calcMonth <= 0) {
      calcYear = currentYear - 1;
      calcMonth += 12;
    }
    // 月份补零为两位（如1→01，12→12）
    const formattedMonth = String(calcMonth).padStart(2, '0');
    // 拼接日期字符串（YYYY年MM月）
    const dateStr = `${calcYear}年${formattedMonth}月`;
    // 赋值到对应索引（xIndex1, xIndex2...xIndex12）
    result[`xIndex${String(i).padStart(2, '0')}`] = dateStr;
  }

  return result;
}

function top3NumSorted(data){
  //用电客户数-本月 data 最大的三个
  const top3NumSortedData = [...data].sort((a, b) => {
    const aNum = Number(a.data?.['用电客户数-本月']) || 0;
    const bNum = Number(b.data?.['用电客户数-本月']) || 0;
    return bNum - aNum; // 降序
  }).slice(0, 3);

  // 5. 提取前3名的名称和值（容错：不足3个时补空/0）
  const [top1NumItem, top2NumItem, top3NumItem] = top3NumSortedData;
  const numTop1Name = top1NumItem?.name || '';
  const numTop1Value = Number(top1NumItem?.data?.['用电客户数-本月']) || 0;
  const numTop2Name = top2NumItem?.name || '';
  const numTop2Value = Number(top2NumItem?.data?.['用电客户数-本月']) || 0;
  const numTop3Name = top3NumItem?.name || '';
  const numTop3Value = Number(top3NumItem?.data?.['用电客户数-本月']) || 0;

  return {
    numTop1Name,
    numTop1Value,
    numTop2Name,
    numTop2Value,
    numTop3Name,
    numTop3Value,
  }
}

function top3JQSorted(data){
  //用电客户数-本月 data 最大的三个
  const top3NumSortedData = [...data].sort((a, b) => {
    const aNum = Number(a.data?.['电力景气指数']) || 0;
    const bNum = Number(b.data?.['电力景气指数']) || 0;
    return bNum - aNum; // 降序
  }).slice(0, 3);

  // 5. 提取前3名的名称和值（容错：不足3个时补空/0）
  const [top1NumItem, top2NumItem, top3NumItem] = top3NumSortedData;
  const jqTop1Name = top1NumItem?.name || '';
  const jqTop1Value = Number(top1NumItem?.data?.['电力景气指数']) || 0;
  const jqTop2Name = top2NumItem?.name || '';
  const jqTop2Value = Number(top2NumItem?.data?.['电力景气指数']) || 0;
  const jqTop3Name = top3NumItem?.name || '';
  const jqTop3Value = Number(top3NumItem?.data?.['电力景气指数']) || 0;

  return {
    jqTop1Name,
    jqTop1Value,
    jqTop2Name,
    jqTop2Value,
    jqTop3Name,
    jqTop3Value,
  }
}

function top3YDSorted(data){
  //用电客户数-本月 data 最大的三个
  const top3NumSortedData = [...data].sort((a, b) => {
    const aNum = Number(a.data?.['用电增长指数']) || 0;
    const bNum = Number(b.data?.['用电增长指数']) || 0;
    return bNum - aNum; // 降序
  }).slice(0, 3);

  // 5. 提取前3名的名称和值（容错：不足3个时补空/0）
  const [top1NumItem, top2NumItem, top3NumItem] = top3NumSortedData;
  const ydTop1Name = top1NumItem?.name || '';
  const ydTop1Value = Number(top1NumItem?.data?.['用电增长指数']) || 0;
  const ydTop2Name = top2NumItem?.name || '';
  const ydTop2Value = Number(top2NumItem?.data?.['用电增长指数']) || 0;
  const ydTop3Name = top3NumItem?.name || '';
  const ydTop3Value = Number(top3NumItem?.data?.['用电增长指数']) || 0;

  return {
    ydTop1Name,
    ydTop1Value,
    ydTop2Name,
    ydTop2Value,
    ydTop3Name,
    ydTop3Value,
  }
}

function top3GMSorted(data){
  //用电客户数-本月 data 最大的三个
  const top3NumSortedData = [...data].sort((a, b) => {
    const aNum = Number(a.data?.['规模增长指数']) || 0;
    const bNum = Number(b.data?.['规模增长指数']) || 0;
    return bNum - aNum; // 降序
  }).slice(0, 3);

  // 5. 提取前3名的名称和值（容错：不足3个时补空/0）
  const [top1NumItem, top2NumItem, top3NumItem] = top3NumSortedData;
  const gmTop1Name = top1NumItem?.name || '';
  const gmTop1Value = Number(top1NumItem?.data?.['规模增长指数']) || 0;
  const gmTop2Name = top2NumItem?.name || '';
  const gmTop2Value = Number(top2NumItem?.data?.['规模增长指数']) || 0;
  const gmTop3Name = top3NumItem?.name || '';
  const gmTop3Value = Number(top3NumItem?.data?.['规模增长指数']) || 0;

  return {
    gmTop1Name,
    gmTop1Value,
    gmTop2Name,
    gmTop2Value,
    gmTop3Name,
    gmTop3Value,
  }
}

function numSorted(data) {
  // 1. 定义区域排序优先级（核心顺序）
  const areaOrder = [
    '市南',
    '市北',
    '李沧',
    '崂山',
    '黄岛',
    '城阳',
    '即墨',
    '胶州',
    '平度',
    '莱西'
  ];

  // 2. 初始化返回结果（默认值0）
  const result = {};

  // 3. 遍历区域顺序，提取对应数值
  areaOrder.forEach((area, index) => {
    // 生成字段名：numValue01 ~ numValue10
    const fieldName = 2400801 + index;

    // 查找匹配的区域数据（模糊匹配，兼容“市南”/“市南区”等命名）
    const areaItem = data.find(item => item.name.includes(area));

    // 提取“用电客户数-本月”，转数字并容错（无数据/非数字则0）
    const numValue = Number(areaItem?.data?.['用电客户数-本月']) || 0;

    // 赋值到结果对象
    result[fieldName] = numValue;
  });

  return result;
}

function jqSorted(data) {
  // 1. 定义区域排序优先级（核心顺序）
  const areaOrder = [
    '市南',
    '市北',
    '李沧',
    '崂山',
    '黄岛',
    '城阳',
    '即墨',
    '胶州',
    '平度',
    '莱西'
  ];

  // 2. 初始化返回结果（默认值0）
  const result = {};

  // 3. 遍历区域顺序，提取对应数值
  areaOrder.forEach((area, index) => {
    // 生成字段名：numValue01 ~ numValue10
    const fieldName = 2500801 + index;

    // 查找匹配的区域数据（模糊匹配，兼容“市南”/“市南区”等命名）
    const areaItem = data.find(item => item.name.includes(area));

    // 提取“用电客户数-本月”，转数字并容错（无数据/非数字则0）
    const numValue = Number(areaItem?.data?.['电力景气指数']) || 0;

    // 赋值到结果对象
    result[fieldName] = numValue;
  });

  return result;
}

function ydSorted(data) {
  // 1. 定义区域排序优先级（核心顺序）
  const areaOrder = [
    '市南',
    '市北',
    '李沧',
    '崂山',
    '黄岛',
    '城阳',
    '即墨',
    '胶州',
    '平度',
    '莱西'
  ];

  // 2. 初始化返回结果（默认值0）
  const result = {};

  // 3. 遍历区域顺序，提取对应数值
  areaOrder.forEach((area, index) => {
    // 生成字段名：numValue01 ~ numValue10
    const fieldName = 2600801 + index;

    // 查找匹配的区域数据（模糊匹配，兼容“市南”/“市南区”等命名）
    const areaItem = data.find(item => item.name.includes(area));

    // 提取“用电客户数-本月”，转数字并容错（无数据/非数字则0）
    const numValue = Number(areaItem?.data?.['用电增长指数']) || 0;

    // 赋值到结果对象
    result[fieldName] = numValue;
  });

  return result;
}

function gmSorted(data) {
  // 1. 定义区域排序优先级（核心顺序）
  const areaOrder = [
    '市南',
    '市北',
    '李沧',
    '崂山',
    '黄岛',
    '城阳',
    '即墨',
    '胶州',
    '平度',
    '莱西'
  ];

  // 2. 初始化返回结果（默认值0）
  const result = {};

  // 3. 遍历区域顺序，提取对应数值
  areaOrder.forEach((area, index) => {
    // 生成字段名：numValue01 ~ numValue10
    const fieldName = 2700801 + index;

    // 查找匹配的区域数据（模糊匹配，兼容“市南”/“市南区”等命名）
    const areaItem = data.find(item => item.name.includes(area));

    // 提取“用电客户数-本月”，转数字并容错（无数据/非数字则0）
    const numValue = Number(areaItem?.data?.['规模增长指数']) || 0;

    // 赋值到结果对象
    result[fieldName] = numValue;
  });

  return result;
}

function processJsonData(jsonFile){
  const content = JSON.parse(jsonFile.content)
  const qingDaoData = content.find(item=>item.name.includes('青岛'));
  const qingDao = qingDaoData?.data;
  const data = content.filter(item=>!item.name.includes('青岛'));

  const top3NumSortedData = top3NumSorted(data);
  const top3JQSortedData = top3JQSorted(data);
  const top3YDSortedData = top3YDSorted(data);
  const top3GMSortedData = top3GMSorted(data);

  const numSortedData = numSorted(data);
  const jqSortedData = jqSorted(data);
  const ydSortedData = ydSorted(data);
  const gmSortedData = gmSorted(data);

  return {
    qingDaoNum:qingDao['用电客户数-本月'],
    qingDaoJQ:qingDao['电力景气指数'],
    qingDaoYD:qingDao['用电增长指数'],
    qingDaoGM:qingDao['规模增长指数'],
    ...top3NumSortedData,
    ...top3JQSortedData,
    ...top3YDSortedData,
    ...top3GMSortedData,
    ...numSortedData,
    ...jqSortedData,
    ...ydSortedData,
    ...gmSortedData,
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
      const placeholder = `${key}`;
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
        <w:t>报告类型：reportType</w:t>
      </w:r>
    </w:p>
    <w:p>
      <w:r>
        <w:t>报告月份：reportMonth</w:t>
      </w:r>
    </w:p>
    <w:p>
      <w:r>
        <w:t>页眉可包含 reportMonth（如需，请在页眉中添加相同占位符）</w:t>
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
  version: '1.0.2',
  process: writingRules,
  description:'主要用于批量生成docx文件-特定青岛-增加动态json数据处理，更新模板',
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