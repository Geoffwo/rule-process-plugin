const xlsx = require('xlsx');
const path = require("path");

function writingRules(inputArray, outputNodeTemplate) {
  // 过滤出json文件
  const jsonFiles = inputArray.filter(item => item.normExt === 'json');

  if (!jsonFiles) {
    console.log('未找到 json文件，正在生成默认 json模板...');
    const defaultJsonTemplate = createDefaultJsonTemplate();
    return [
      {...outputNodeTemplate, normExt:'json', content: '错误: 未找到json文件,已创建示例文件'},
      {...outputNodeTemplate, normExt:'json', content: JSON.stringify(defaultJsonTemplate,null,2)}
    ];
  }

  const contents = []
  jsonFiles.forEach(jsonFile=>{
    generateXlsx(jsonFile,outputNodeTemplate,contents);
  })


  // 处理每个文件并生成输出节点
  return [
    {...outputNodeTemplate, normExt:'json', content: JSON.stringify(contents,null,2)}
  ];
}

function generateXlsx(jsonFile,outputNodeTemplate,contents){
  const outputDir = outputNodeTemplate.path // 临时目录绝对路径
  const fileName = `${jsonFile.name}.xlsx`
  const outputPath = path.join(outputDir, fileName) // 临时目录绝对路径

  // 创建新的Excel工作簿
  const workbook = xlsx.utils.book_new();

  try {

    const jsonData = JSON.parse(jsonFile.content)
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
    xlsx.writeFile(workbook, outputPath);

    contents.push({
      name:fileName,
      path:outputPath,
      success:true,
    })
  } catch (writeError) {
    console.log(`XLSX文件写入失败：${writeError.message}`);
    contents.push({
      name:fileName,
      path:'',
      success:false,
      msg:writeError.message
    })
  }
}

function createDefaultJsonTemplate(){
  return [
    {
      "name": "市南",
      "data": {
        "序号": 71,
        "行业": "    24.汽车制造业",
        "用电客户数-本月": 0,
        "用电客户数-同期": 0,
        "运行容量-本月": 0,
        "运行容量-同期": 0,
        "售电量-本月": 0,
        "售电量-同期": 0,
        "售电量-本月同比增速（%）": 0,
        "售电量-本年累计": 0,
        "售电量-同期累计": 0,
        "售电量-累计同比增速（%）": 0,
        "用电增长指数": 0,
        "规模增长指数": 0,
        "电力景气指数": 0
      }
    },
    {
      "name": "市北",
      "data": [{
        "序号": 71,
        "行业": "    24.汽车制造业",
        "用电客户数-本月": 0,
        "用电客户数-同期": 1,
        "运行容量-本月": 0,
        "运行容量-同期": 315,
        "售电量-本月": 0,
        "售电量-同期": 30421,
        "售电量-本月同比增速（%）": -100,
        "售电量-本年累计": 0,
        "售电量-同期累计": 30421,
        "售电量-累计同比增速（%）": -100,
        "用电增长指数": 0,
        "规模增长指数": 0,
        "电力景气指数": 0
      }]
    },
    {
      "name": "李沧",
      "data": [
        {
          "序号": 71,
          "行业": "    24.汽车制造业",
          "用电客户数-本月": 14,
          "用电客户数-同期": 15,
          "运行容量-本月": 12219,
          "运行容量-同期": 11819,
          "售电量-本月": 1879536,
          "售电量-同期": 1346038,
          "售电量-本月同比增速（%）": 39.634690848252426,
          "售电量-本年累计": 1879536,
          "售电量-同期累计": 1346038,
          "售电量-累计同比增速（%）": 39.634690848252426,
          "用电增长指数": 139.63,
          "规模增长指数": 103.38,
          "电力景气指数": 132.38
        },
        {
          "序号": 71,
          "行业": "    24.汽车制造业",
          "用电客户数-本月": 1,
          "用电客户数-同期": 1,
          "运行容量-本月": 400,
          "运行容量-同期": 400,
          "售电量-本月": 41251,
          "售电量-同期": 38204,
          "售电量-本月同比增速（%）": 7.975604648727883,
          "售电量-本年累计": 41251,
          "售电量-同期累计": 38204,
          "售电量-累计同比增速（%）": 7.975604648727883,
          "用电增长指数": 107.98,
          "规模增长指数": 100,
          "电力景气指数": 106.38
        }
      ]
    },
  ];
}

// module.exports = writingRules; // 导出主处理函数

module.exports = {
  name: 'json2xlsx',
  version: '1.0.0',
  process: writingRules,
  description:'主要用于将json文件转化为xlsx',
  notes:{
    node:'18.20.4',
  },
  input: {
    normExt: 'json文件',
    format: "[{name:sheet页名称,data:[{这一行的数据}]}]"
  },
  output: {
    normExt: 'xlsx文件'
  },
  rely:{//默认 latest
    'xlsx': '0.18.0'
  }
};