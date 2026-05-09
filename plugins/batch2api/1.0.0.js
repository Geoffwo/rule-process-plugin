const xlsx = require('xlsx');
const axios = require("axios");
const fs = require("fs");
const path = require("path");

function readExcel(file,sheet) {
  // 1. 读取工作簿（启用公式计算）
  const workbook = xlsx.readFile(file.path);

  const sheetToRead = sheet || workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetToRead];

  if (!worksheet) {
    throw new Error(`工作表 "${sheetToRead}" 不存在，可用工作表: ${workbook.SheetNames.join(', ')}`);
  }

  // 3. 返回结构化结果
  return xlsx.utils.sheet_to_json(worksheet);
}

/**
 * 延迟函数
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------- 模板渲染：将 {{key}} 替换为行数据对应字段 ----------
function renderTemplate(template, row) {
  //template {"archiveId": "{{id}}","name": "{{姓名}}","type": "{{类型}}","status": "active"}
  //row { "id": "1001", "姓名": "张三", "类型": "个人" }

  //如果是字符串 进行正则元数据捕获
  if (typeof template === 'string') {
    return template.replace(/\{\{(.+?)\}\}/g, (_, col) => row[col.trim()] ?? '');
  }

  //如果是数组 逐项递归
  if (Array.isArray(template)) {
    return template.map(item => renderTemplate(item, row));
  }

  //如果是对象
  if (template !== null && typeof template === 'object') {
    const newObj = {};
    //遍历对象每一个的属性，进行值替换
    for (const key of Object.keys(template)) {
      //设置属性名和对应的实际值
      newObj[key] = renderTemplate(template[key], row);//触发【递归-字符串】判断
    }
    return newObj;
  }
  return template;
}

function createJsonTemplate(){
  return {
    "url": "http://localhost:3259/sys/add",
    "method": "POST",
    "headers": {
      "Content-Type": "application/json",
      "Authorization": "Bearer your-token"
    },
    "bodyTemplate": {
      "userNo": "{{id}}",
      "name": "{{姓名}}",
      "userName": "{{姓名}}",
      "date":"2026-05-09",
      "dateType":"el-theme-dp2",
      "value1":"12",
      "title": "{{类型}}"
    },
    "delay": 200
  }
}

function createXlsxTemplate(outputPath){
  // 定义列名，与 config.json 中 bodyTemplate 里的 {{key}} 保持一致
  const headers = ['id', '姓名', '类型'];

  // 示例数据（可选，你也可以只创建带表头的空文件）
  const sampleData = [
    { id: '1001', '姓名': '张三', '类型': '个人' },
    { id: '1002', '姓名': '李四', '类型': '企业' },
    { id: '1003', '姓名': '王五', '类型': '个人' }
  ];

  // 创建工作簿
  const workbook = xlsx.utils.book_new();
  const worksheet = xlsx.utils.json_to_sheet(sampleData, { header: headers });
  xlsx.utils.book_append_sheet(workbook, worksheet, 'Sheet1');

  // 写入文件
  xlsx.writeFile(workbook, outputPath);
}

async function writingRules(inputArray, outputNodeTemplate) {
  const outputDir = outputNodeTemplate.path // 临时目录绝对路径
  const inputPath = path.join(outputDir, '../inputDir');
  const outputPath = path.join(inputPath, 'data.xlsx') // 临时目录绝对路径

  // 过滤出xlsx文件
  const xlsxFile = inputArray.find(item => item.normExt === 'xlsx' && item.name === 'data');

  const configFile = inputArray.find(item => item.normExt === 'json' && item.name === 'config');

  if (!xlsxFile) {
    createXlsxTemplate(outputPath)
    return [{ ...outputNodeTemplate, content: '错误: 未找到 data.xlsx 文件,示例文件已创建' }];
  }

  if (!configFile) {
    const jsonTemplate = createJsonTemplate();
    return [
      { ...outputNodeTemplate, content: '错误: 未找到 config.json 文件,示例文件已创建' },
      {...outputNodeTemplate, path: inputPath, fileName: 'config',normExt:'json', content: JSON.stringify(jsonTemplate, null, 2)}
    ];
  }

  const jsonData = readExcel(xlsxFile);
  console.log(`已加载 ${jsonData.length} 条记录（来自 ${xlsxFile.path}）\n`);

  const config = JSON.parse(configFile.content);
  const { url, method, headers, bodyTemplate, delay = 200 } = config;

  let success = 0, fail = 0;

  for (let i = 0; i < jsonData.length; i++) {
    const row = jsonData[i];
    const body = renderTemplate(bodyTemplate, row);

    const axiosConfig = {
      url,
      method: method.toLowerCase(),
      headers: {...headers},
      data: method.toLowerCase() !== 'get' ? body : null,
      params: method.toLowerCase() === 'get' ? body : null,
      timeout: 60000
    };

    try {
      const response = await axios(axiosConfig);   // 直接发送，不重试
      success++;
      // 打印成功详细日志
      console.log(`[${i + 1}/${jsonData.length}] 成功 (状态: ${response.status})`);

      const responseData = response.data;
      console.log('返回数据：');
      console.dir(responseData, { depth: null, colors: true });
      console.log('---------------------------------------');
    } catch (err) {
      fail++;
      const status = err.response?.status || err.code || '网络错误';
      console.error(`[${i + 1}/${jsonData.length}] 失败: ${err.message} (状态: ${status})`);
    }

    await sleep(delay);
  }

  console.log(`\n\n批量处理完成！成功: ${success}, 失败: ${fail}`);

}

// module.exports = writingRules; // 导出主处理函数

module.exports = {
  name: 'batch2api',
  version: '1.0.0',
  process: writingRules,
  description:'读取 Excel 数据，按配置模板循环调用 HTTP 接口，批量新增数据',
  notes:{
    node:'18.20.4',
  },
  input: {
    normExt: 'xlsx文件+json配置文件'
  },
  output: {
    normExt: '',
  },
  rely:{//默认 latest
    'xlsx': '0.18.0',
    'axios': '0.27.2',
  }
};