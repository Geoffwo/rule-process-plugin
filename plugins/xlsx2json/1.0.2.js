const xlsx = require('xlsx');

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

module.exports = {
  name: 'xlsx2json',
  version: '1.0.0',
  process: readExcel
};