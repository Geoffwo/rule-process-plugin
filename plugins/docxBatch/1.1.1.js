const path = require("path");
const year = 2025

async function writingRules(inputArray, outputNodeTemplate) {
  // 过滤出xml文件
  const xmlFiles = inputArray.filter(item => item.normExt === 'xml');
  const jsonFiles = inputArray.filter(item => item.normExt === 'json');//动态数据

  if (xmlFiles.length===0) {
    console.log('未找到 xmlFiles 动态数据');
    return [{...outputNodeTemplate, content: '错误: 未找到 xmlFiles 文件'}];
  }

  if (jsonFiles.length===0) {
    console.log('未找到 jsonFiles 动态数据');
    return [{...outputNodeTemplate, content: '错误: 未找到 jsonFiles 动态数据'}];
  }

  const result = []
  await generateReport(xmlFiles,outputNodeTemplate,result,jsonFiles);


  console.log('\n 所有图表xml处理完成！');

  // 处理每个文件并生成输出节点
  return result;
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

async function generateReport(xmlFiles,outputNodeTemplate,contents,jsonFiles){
  // 2. 批量生成12个月报告
  const month = 10
  const formattedMonth = String(month).padStart(2, '0');
  const xAxisData = xAxis(month);

  // 新增：地市列表（复用原有排序，作为循环基准）
  const areas = [
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

  // 排序核心逻辑：提取数字并比较
  xmlFiles.sort((a, b) => {
    // 正则提取 "chart" 后的数字（容错：无数字则返回0）
    const numA = a.name.match(/chart(\d+)/) ? parseInt(RegExp.$1, 10) : 0;
    const numB = b.name.match(/chart(\d+)/) ? parseInt(RegExp.$1, 10) : 0;
    // 升序排序（numA - numB），降序则反过来
    return numA - numB;
  });

  xmlFiles.forEach(item=>{
    console.log(item.name);
  })

  xmlFiles.forEach((xmlFile,xmlIndex)=>{
    const xmlContent = xmlFile.content;
    const area = areas[xmlIndex%areas.length];

    // 2. 初始化返回结果（默认值0）
    const data = {};
    const keys = Object.keys(xAxisData);
    keys.forEach((key, index)=>{
      const jsonFile = jsonFiles.find(item=>item.name===xAxisData[key]) || {content:'[]'}
      const content = JSON.parse(jsonFile.content)
      const cityData = content.find(item=>item.name.includes(area));
      const city = cityData?.data || {};
      // 生成字段名：numValue01 ~ numValue10
      const fieldName = 4100801 + index;
      data[fieldName] = city['电力景气指数'] || 0;

      const fieldName2 = 4200801 + index;
      data[fieldName2] = city['用电增长指数'] || 0;

      const fieldName3 = 4300801 + index;
      data[fieldName3] = city['规模增长指数'] || 0;
    })

    let newXmlStr = xmlContent;
    const dataKeys = Object.keys(data);
    dataKeys.forEach(key => {
      const placeholder = `${key}`;
      const safePlaceholder = placeholder
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          .replace(/\\\*/g, '.*');
      newXmlStr = newXmlStr.replace(new RegExp(safePlaceholder, 'g'), data[key]);
    });

    const outputPath=path.join(outputNodeTemplate.path, './temp/word/charts');

    contents.push({
      ...outputNodeTemplate,
      path:outputPath,
      fileName:xmlFile.name,
      normExt: 'xml',
      content: newXmlStr,
    });
  })

}

// module.exports = writingRules; // 导出主处理函数

module.exports = {
  name: 'docxBatch',
  version: '1.1.1',
  process: writingRules,
  description:'主要用于批量生成docx文件-特定青岛-1.0.3生成后，手动复制到新的word文档保存，会将图表chart重新生成，此时，对批量chart.xml进行硬编码规则处理，需要手动替换，但已减少操作成本',
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
    // 'adm-zip': '0.5.16'
  }
};