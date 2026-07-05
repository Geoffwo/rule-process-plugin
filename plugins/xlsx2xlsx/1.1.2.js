const { execSync } = require('child_process');
const robot = require('robotjs');
const path = require('path');
const fs = require('fs');
const xlsx = require('xlsx');

/**
 * 基础延迟函数（Promise版），适配不同电脑响应速度
 * @param {number} ms 延迟毫秒数
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 创建合法的空Excel文件（核心修复：替代fs.writeFileSync）
 * @param {string} outputPath Excel文件输出路径
 */
function writeEmptyExcel(outputPath) {
  // 创建新的Excel工作簿
  const workbook = xlsx.utils.book_new();
  // 添加一个空的默认Sheet（避免工作簿无Sheet导致Excel报错）
  const emptySheet = xlsx.utils.json_to_sheet([]); // 空数据的Sheet
  xlsx.utils.book_append_sheet(workbook, emptySheet, '汇总Sheet');
  // 写入合法的Excel文件（同步）
  xlsx.writeFile(workbook, outputPath);
  console.log(`→ 已创建合法空Excel文件：${outputPath}`);
}


/**
 * 核心：合并单个Excel的所有Sheet到新Excel的第一个Sheet
 * @param {array} inputArray 输入文件元信息数组（[{path: '文件路径', normExt: 'xlsx'}]）
 * @param {object} outputNodeTemplate 输出节点模板
 * @returns {array} 合并结果节点
 */
async function writingRules(inputArray, outputNodeTemplate) {
  // 1. 变量初始化（修复未定义问题）
  const outputDir = outputNodeTemplate.path;
  const inputPath = path.join(outputDir, '../inputDir');

  // 筛选出目标Excel文件（取第一个xlsx文件）
  const xlsxFile = inputArray.find(item => item.normExt === 'xlsx' && item.name === '原始数据-出-格式化');
  if (!xlsxFile) {
    throw new Error('未找到目标Excel文件：原始数据-出-格式化.xlsx');
  }

  const fileName = `${xlsxFile.name}-汇总.xlsx`
  const outputPath = path.join(outputDir, fileName) // 临时目录绝对路径

  // 3. 提前创建空的新Excel文件（避免打开不存在的文件）
  if (!fs.existsSync(outputPath)) {
    console.log('→ 创建空的汇总Excel文件');
    // 用echo创建空文件（Windows），如果需要真实空Excel，可提前放模板
    // fs.writeFileSync(outputPath, '');
    writeEmptyExcel(outputPath)
  }

  // 5.3 打开/切换到汇总Excel文件
  console.log('→ 打开汇总Excel文件');
  execSync(`start "" "${outputPath}"`, { stdio: 'ignore' });
  await sleep(5000);

  // 4. 打开源Excel文件（待复制的Sheet）
  console.log(`→ 打开源Excel文件：${xlsxFile.path}`);
  execSync(`start "" "${xlsxFile.path}"`, { stdio: 'ignore' });
  await sleep(5000); // 等待Excel完全加载（根据电脑性能调整）

  // 5. 遍历所有Sheet（核心：模拟切换Sheet+复制）
  let sheetNum = 10;

  for (let sheetIndex = 0; sheetIndex < sheetNum; sheetIndex++) {
    try {

      console.log(`→ 处理第 ${sheetIndex+1} 个Sheet`);
      // 第一步：跳到当前Sheet的A1单元格
      robot.keyToggle('control', 'down');
      robot.keyTap('home');
      robot.keyToggle('control', 'up');
      await sleep(500);

      // 选择sheet页
      console.log('   → 选择sheet页');
      if(sheetIndex!==0){
        robot.keyToggle('control', 'down');
        robot.keyTap('pagedown');
        robot.keyToggle('control', 'up');
        await sleep(1000);
      }

      // 第二步：选中从A1到最后一个有内容的单元格
      console.log('   → 全选当前Sheet内容');
      robot.keyToggle('control', 'down');
      robot.keyToggle('shift', 'down');
      robot.keyTap('end');
      robot.keyToggle('shift', 'up');
      robot.keyToggle('control', 'up');
      await sleep(1000);

      // 5.2 复制选中内容（Ctrl+C）
      console.log('   → 复制内容');
      robot.keyToggle('control', 'down');
      robot.keyTap('c');
      robot.keyToggle('control', 'up');
      await sleep(1500);

      console.log('   → 切换excel文件-汇总');
      robot.keyToggle('control', 'down');
      robot.keyToggle('shift', 'down');
      robot.keyTap('tab');
      robot.keyToggle('shift', 'up');
      robot.keyToggle('control', 'up');
      await sleep(1500);

      //切换到第一个元素
      robot.keyToggle('control', 'down');
      robot.keyTap('home');
      robot.keyToggle('control', 'up');
      await sleep(500);

      // 5.4 粘贴内容（追加到第一个Sheet末尾）
      console.log('   → 粘贴内容到汇总文件');
      // 跳到已有内容最后一行（Ctrl+End）
      robot.keyToggle('control', 'down');
      robot.keyTap('end');
      robot.keyToggle('control', 'up');
      await sleep(500);

      if(sheetIndex!==0){
        // 下移两格（避免粘连）
        robot.keyTap('down');
        await sleep(500);
        robot.keyTap('down');
        await sleep(500);
      }

      // 跳到行首（Home）
      robot.keyTap('home');
      await sleep(1000);

      // 粘贴
      robot.keyToggle('control', 'down');
      robot.keyTap('v');
      robot.keyToggle('control', 'up');
      await sleep(2000);

      // 5.5 保存汇总文件
      console.log('   → 保存汇总文件');
      robot.keyToggle('control', 'down');
      robot.keyTap('s');
      robot.keyToggle('control', 'up');
      await sleep(1000);

      console.log('   → 切换excel文件-原始');
      robot.keyToggle('control', 'down');
      robot.keyToggle('shift', 'down');
      robot.keyTap('tab');
      robot.keyToggle('shift', 'up');
      robot.keyToggle('control', 'up');
      await sleep(1500);
    } catch (err) {
      // 报错退出
      console.log(`→ 第 ${sheetIndex+1} 个Sheet报错：${err.message}`);
      continue;
    }
  }

  console.log('   → 保存原始文件');
  robot.keyToggle('control', 'down');
  robot.keyTap('s');
  robot.keyToggle('control', 'up');
  await sleep(1000);

  // 5.6 关闭汇总文件，切回源Excel
  console.log('→ 关闭所有文件');
  robot.keyToggle('alt', 'down');
  robot.keyTap('f4');
  robot.keyToggle('alt', 'up');
  await sleep(2000);

  console.log(`→ 已处理完所有 ${sheetNum} 个Sheet`);
}

// 插件导出（修正格式/依赖）
// 插件导出
module.exports = {
  name: 'xlsx2xlsx',
  version: '1.1.2',
  process: writingRules,
  description: '基于robotjs的Excel Sheet合并插件：将单个Excel的所有Sheet复制到新Excel的第一个Sheet',
  notes: {
    node: '18.20.4',
    tips: [
      '运行前请确保Excel是默认打开程序（WPS/Office均可）',
      '延迟时间（sleep）需根据电脑性能调整（建议8000-15000ms）',
      '运行时请勿操作键鼠，避免干扰模拟操作',
      'Excel中切换Sheet用Ctrl+PageDown，选中内容用Ctrl+Shift+End'
    ]
  },
  input: {
    normExt: 'xlsx',
    format: '文件元信息数组：[{path: "Excel绝对路径", normExt: "xlsx", isDirectory: false}]'
  },
  output: {
    normExt: 'xlsx',
    format: '合并后的Excel文件，所有Sheet内容追加到第一个Sheet'
  },
  rely: {
    'robotjs': '0.6.0',
    'xlsx': '0.18.0' // 新增xlsx依赖
  }
};