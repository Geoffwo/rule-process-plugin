const robot = require('robotjs');
const clipboardy = require('clipboardy');

/**
 * 延迟函数
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ====================== 【你只需要改这里】鼠标坐标 ======================
const POSITION = {
  addBtn:      { x: 1185, y: 277 },    // 新增按钮
  saveBtn:     { x: 988, y: 568 },    // 保存按钮
  confirmBtn:  { x: 630, y: 445 },    // 确认按钮
  localLine:  { x: 909, y: 702 },    // 本地底部栏
  remoteLine:  { x: 911, y: 662 },    // 远程底部栏
  inputDot:  { x: 845, y: 263 },    // 失去焦点位置
  inputDot1:  { x: 464, y: 322 },    // 标记点
};
// ======================================================================

/**
 * 鼠标移动 + 点击
 */
async function clickPos(pos) {
  robot.moveMouse(pos.x, pos.y);
  await sleep(300);
  robot.mouseClick();
}

/**
 * 模拟人工打字
 */
async function typeText(text) {
  for (const char of text) {
    robot.typeString(char);
    await sleep(180);
  }
}

/**
 * 【新增】使用剪贴板粘贴文本（解决中文输入问题）
 */
async function pasteText(text,inputDot) {
  // 1. 使用异步方式写入剪贴板（比 writeSync 更稳定）
  await clipboardy.write(text);
  //经测试，在当前电脑正常
  // 在向日葵连接的远程电脑无法及时更新粘贴板
  await sleep(1000);

  //添加中间过渡
  await remoteProcess(inputDot)

  // 2. 模拟按下 Ctrl + V 粘贴
  // robot.keyTap('v', 'control'); // 粘贴
  robot.keyToggle('control', 'down');
  robot.keyTap('v');
  robot.keyToggle('control', 'up');
  await sleep(1000);
}

async function remoteProcess(inputDot){
  //本地强制更新
  await clickPos(POSITION.localLine);
  await sleep(1000);

  robot.keyTap('v', 'command');
  await sleep(3000);

  //远程强制失去焦点
  await clickPos(POSITION.inputDot);
  await sleep(1000);

  //指定远程获取焦点位置
  await clickPos(POSITION[inputDot]);
  await sleep(1000);
}

/**
 * 单条数据录入
 */
async function addOneData(data) {
  console.log(`正在录入：${data.id} → ${data.name}`);

  // 1. 点击新增
  await clickPos(POSITION.addBtn);
  await sleep(1000);

  // 2. 输入ID → Tab
  await typeText(data.id);
  await sleep(200);

  robot.keyTap('tab');
  await sleep(200);
  await typeText(data.id);
  await sleep(200);

  robot.keyTap('tab');
  await sleep(200);
  await pasteText(data.name,'inputDot1');
  await sleep(200);

  robot.keyTap('tab');
  await sleep(200);

  robot.keyTap('tab');
  await sleep(200);
  await typeText('111111111111111111');
  await sleep(200);

  robot.keyTap('tab');
  await sleep(200);
  await typeText('123456');
  await sleep(200);

  robot.keyTap('tab');
  await sleep(200);
  await typeText('123456');
  await sleep(200);

  // 4. 保存
  await clickPos(POSITION.saveBtn);
  await sleep(1500);

  // 5. 确认
  await clickPos(POSITION.confirmBtn);
  await sleep(1000);
}

/**
 * 将数据库直接复制的tsv的txt转化为对象数组
 */
function tsv2Json(tsvData) {
  const lines = tsvData.split(/\r?\n/);

  const formDataList = lines.map(line => {
    const [id, name] = line.trim().split(/\s+/);
    return { id, name };
  });

  console.log('✅ 读取 data.txt 成功，共', formDataList.length, '条数据');
  return formDataList;
}

/**
 * 批量维护医院新增用户
 * @param {array} inputArray 输入文件元信息数组（[{path: '文件路径', normExt: 'xlsx'}]）
 * @param {object} outputNodeTemplate 输出节点模板
 * @returns {array} 合并结果节点
 */
async function writingRules(inputArray, outputNodeTemplate) {
  console.log('静默等待8秒，让页面进入需要调控页面');
  await sleep(8000);

  // 筛选出目标文件
  const dataFile = inputArray.find(item => item.normExt === 'txt' && item.name === 'data');
  if (!dataFile) {
    throw new Error('未找到目标文件：请从数据库拷贝到data.txt文件');
  }

  console.log('表单自动维护插件启动');

  // 自动读取 data.txt 并转换
  const formDataList = tsv2Json(dataFile.content);

  if (formDataList.length === 0) {
    console.log('⚠️ data.txt 无数据，退出');
    return;
  }

  // 循环录入所有数据
  for (let i = 0; i < formDataList.length; i++) {
    console.log(`\n===== 第 ${i + 1} 条 =====`);
    await addOneData(formDataList[i]);
  }

  console.log('所有数据录入完成！');
}

// ====================== 规则引擎插件导出 ======================
module.exports = {
  name: 'formAutoFill',
  version: '1.0.0',
  process: writingRules,
  description: '读取data.txt自动执行表单录入-添加用户信息',
  notes: {
    node: '18.20.4',
    tips: [
      '向日葵远程登陆后，最大化，但不要全屏（用于固定屏幕按钮坐标）',
      '可以通过坐标小工具，获取对应按钮的屏幕坐标，当前浏览器缩放比例为80%',
      '运行前打开表单页面，去掉遮挡，不要动鼠标键盘'
    ]
  },
  input: {
    normExt: 'data.txt',
    format: '格式：每行一条 id name(0001 张三)，用Tab/空格分隔（直接从远程数据库复制）'
  },
  output: {
    normExt: 'none'
  },
  rely: {
    'robotjs': '0.6.0',
    'clipboardy': '2.3.0',
  }
};