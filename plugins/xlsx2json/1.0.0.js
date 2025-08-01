const xlsx = require('xlsx');

function writingRules(inputArray, outputNodeTemplate) {
  // 过滤出xlsx文件
  const xlsxFiles = inputArray.filter(item => item.normExt === 'xlsx');

  // 处理每个文件并生成输出节点
  return xlsxFiles.map(file => ({
    ...outputNodeTemplate,
    normExt:'json',
    content: JSON.stringify(readExcel(file)) // 读取Excel内容
  }));

  // return []
}

function readExcel(file) {
  try {
    // 1. 读取工作簿（启用公式计算）
    const workbook = xlsx.readFile(file.path);

    // 2. 遍历所有工作表
    const sheets = workbook.SheetNames.map(sheetName => {
      const worksheet = workbook.Sheets[sheetName];
      const jsonData = xlsx.utils.sheet_to_json(worksheet);

      return {
        name: sheetName,
        data: jsonData
      };
    });

    // 3. 返回结构化结果
    return sheets;

  } catch (error) {
    console.error(`读取文件 ${file.path} 失败:`, error.message);
    return []; // 返回空避免进程中断
  }
}

// module.exports = writingRules; // 导出主处理函数

module.exports = {
  name: 'xlsx2json',
  version: '1.0.0',
  process: writingRules,
  description:'主要用于将xlsx文件转化为json',
  notes:{
    node:'14.18.0',
  },
  input: {
    normExt: 'xlsx文件'
  },
  output: {
    normExt: 'json文件',
    format: "[{name:sheet页名称,data:这一页的数据}]"
  },
  rely:{//默认 latest
    'xlsx': '0.18.0'
  }
};