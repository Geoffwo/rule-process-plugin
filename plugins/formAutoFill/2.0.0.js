const robot = require('robotjs');
const xlsx = require('xlsx');
const path = require("path");

// ====================== 配置加载与合并层 ======================
const DEFAULT_CONFIG = {
  globals: {
    initialWait: 8000,        // 启动前等待时间
    stepDelay: 200,        // 步骤间默认延迟
    clickDelay: 300,          // 点击操作前延迟
    typeCharDelay: 180,       // 打字字符间隔
  },
};

// ====================== 工具函数层（完全通用，无需修改） ======================
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 鼠标移动+点击（可配置点击前延迟）
 */
async function clickPos(pos, delay = 300,option={}) {
  const {button='left',double=false} = option
  robot.moveMouse(pos.x, pos.y);
  await sleep(delay);
  robot.mouseClick(button,double);
}

/**
 * 模拟人工打字（可配置字符间隔）
 */
async function typeText(text, delay = 180) {
  for (const char of text) {
    robot.typeString(char);
    await sleep(delay);
  }
}
// ====================== 核心执行引擎（配置驱动） ======================
/**
 * 单条数据录入（通用流程）
 */
async function processOneRecord(record, index, config) {
  console.log(`\n===== 第 ${index + 1} 条 =====`);

  for (const step of config.workflow) {
    try {
      await executeStep(step, record, config);
    } catch (err) {
      console.error(`第 ${index + 1} 条数据录入失败，步骤: ${JSON.stringify(step)}`);
      console.error(`错误信息: ${err.message}`);
      throw err; // 抛出错误终止整个流程，避免后续数据出错
    }
  }

  console.log(`第 ${index + 1} 条录入完成`);
}

/**
 * 执行单个步骤
 */
async function executeStep(step, currentData, config) {
  const { globals, positions } = config;
  const stepDelay = step.stepDelay || globals.stepDelay;

  switch (step.type) {
      // 点击操作
    case 'click':
      if (!positions[step.displace]) {
        throw new Error(`步骤错误：未找到坐标点 "${step.displace}"`);
      }
      const delayClick = step.delay || globals.clickDelay
      const option = {
        button:step.button || 'left',
        double:step.double || false
      }
      await clickPos(positions[step.displace],delayClick,option);
      break;

      // 输入操作
    case 'input':
      const text = currentData[step.displace] ||  step.value;
      const delayInput = step.delay || globals.typeCharDelay
      await typeText(text, delayInput);
      break;

      // 按键操作（支持组合键）
    case 'keyTap':
      if(step.action){
        robot.keyTap(step.value, step.action);
      }else{
        robot.keyTap(step.value);
      }
      break;

    case 'keyToggle':
      robot.keyToggle(step.value, step.action);
      break;

      // 等待操作
    case 'wait':
      await sleep(step.delay);
      break;

    default:
      console.log(`步骤错误：不支持的操作类型 "${step.type}"`);
  }

  // 步骤执行后延迟
  await sleep(stepDelay);
}

function createJsonTemplate(){
  return {
    "globals":{
      "initialWait": 8000,
      "stepDelay": 200,
      "clickDelay": 300,
      "typeCharDelay": 180
    },
    "positions": {
      "addBtn": { "x": 1185, "y": 277 },
      "saveBtn": { "x": 988, "y": 568 }
    },
    "workflow": [
      { "type": "click", "displace": "addBtn", "delay": 1000 },

      { "type": "input", "value": "111111111111111111" },
      { "type": "input", "displace": "id" },

      { "type": "keyTap", "value": "tab" },
      { "type": "input", "value": "111111111111111111" },

      { "type": "keyTap", "value": "a", "action":"control" },
      { "type": "keyTap", "value": "c", "action":"control" },
      { "type": "input", "displace": "姓名", "value": "未命名"},

      { "type": "keyToggle", "value": "control", "action":"down" },
      { "type": "keyTap", "value": "v" },
      { "type": "keyToggle", "value": "control", "action":"up" },

      { "type": "wait", "delay": 1000 },

      { "type": "click", "displace": "saveBtn", "delay": 1500, "button":"left","double":false }
    ]
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

// ====================== 规则引擎插件入口 ======================
async function writingRules(inputArray, outputNodeTemplate) {
  const outputDir = outputNodeTemplate.path // 临时目录绝对路径
  const inputPath = path.join(outputDir, '../inputDir');
  const outputPath = path.join(inputPath, 'data.xlsx') // 临时目录绝对路径

  console.log('表单自动录入工具启动');

  // 1. 加载配置文件
  const xlsxFile = inputArray.find(item => item.normExt === 'xlsx' && item.name === 'data');//数据源
  const configFile = inputArray.find(item => item.normExt === 'json' && item.name === 'config');//配置源

  if (!xlsxFile) {
    createXlsxTemplate(outputPath)
    return [{ ...outputNodeTemplate, content: '错误: 未找到 data.xlsx 文件,示例文件已创建' }];
  }

  if (!configFile) {
    const jsonTemplate = createJsonTemplate();
    return [
      { ...outputNodeTemplate, content: '错误: 未找到配置文件 config.json 文件,示例文件已创建' },
      {...outputNodeTemplate, path: inputPath, fileName: 'config',normExt:'json', content: JSON.stringify(jsonTemplate, null, 2)}
    ];
  }

  const userConfig=JSON.parse(configFile.content)
  const config = {
    ...DEFAULT_CONFIG,
    ...userConfig,
    globals: { ...DEFAULT_CONFIG.globals, ...userConfig.globals },
  };

  // 2. 初始等待（让用户切换到目标页面）
  console.log(`等待 ${config.globals.initialWait / 1000} 秒，请切换到目标表单页面...`);
  await sleep(config.globals.initialWait);

  // 3. 加载并解析数据文件
  const jsonData = readExcel(xlsxFile);
  if (jsonData.length === 0) {
    console.log('无数据可录入，程序退出');
    return;
  }

  // 4. 批量录入数据
  console.log(`已加载 ${jsonData.length} 条记录（来自 ${xlsxFile.path}）\n`);
  for (let i = 0; i < jsonData.length; i++) {
    await processOneRecord(jsonData[i], i, config);
  }

  console.log('\n 所有数据录入完成！');
}

// ====================== 插件导出（保持原有接口不变） ======================
module.exports = {
  name: 'formAutoFill',
  version: '2.0.0',
  process: writingRules,
  description: '基于json配置的自动录入工具',
  notes: {
    node: '18.20.4',
    tips: [
      '1. 所有配置均在config.json中完成，无需修改代码',
      '2. 运行前确保表单页面无遮挡，不要移动鼠标键盘',
      '3. 可通过坐标工具获取屏幕坐标，注意浏览器缩放比例'
    ]
  },
  input: {
    normExt: ['json', 'xlsx'],
    format: '上传两个文件：config.json(配置文件) 和 data.xlsx(数据文件)'
  },
  output: {
    normExt: 'none'
  },
  rely: {
    xlsx:'0.18.0',
    robotjs:'0.6.0'
  }
};