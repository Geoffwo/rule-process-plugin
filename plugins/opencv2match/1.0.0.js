const robot = require('robotjs');
const cv = require('@u4/opencv4nodejs');
const screenshot = require('screenshot-desktop');
const path = require('path');
const { execSync} = require('child_process');
const fs = require('fs');

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

/**
 * 获取屏幕缩放比例
 * 解决高DPI屏幕缩放导致的坐标偏差
 */
function getScreenScaleFactor() {
  const regVal = execSync(
      `reg query "HKCU\\Control Panel\\Desktop\\WindowMetrics" /v AppliedDPI`,
      { encoding: 'utf8', windowsHide: true }
  );
  // 注册表返回的DPI是十六进制，如 0x60 (96) 或 0x90 (144)
  const hexMatch = regVal.match(/0x([0-9a-fA-F]+)/);
  if (!hexMatch) return 1;
  const dpi = parseInt(hexMatch[1], 16);
  const toFixed = (dpi / 96).toFixed(2);
  return Number(toFixed);
}

/**
 * 生成等步长数组（包含起始值和结束值）
 */
function generateRange(start, end, step=0.05, decimalPlaces = 2) {
  // 1. 严格参数校验
  if (step === 0) {
    throw new Error('步长不能为0');
  }

  // 2. 处理方向不匹配的情况（直接返回空数组，友好不报错）
  if ((step > 0 && start > end) || (step < 0 && start < end)) {
    return [];
  }

  // 3. 计算数组长度（核心：用epsilon修正浮点数精度导致的长度计算错误）
  const epsilon = 1e-10;
  const count = Math.floor((end - start + epsilon) / step) + 1;

  // 4. 生成数组（用乘法代替累加，彻底避免精度累积）
  return Array.from({ length: count }, (_, i) => {
    const value = start + step * i;
    // 四舍五入到指定小数位数，消除浮点噪声
    return Number(value.toFixed(decimalPlaces));
  });
}

//判断并生成dir
function judgeDir(outputDir){
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
    console.log("已创建调试目录：" + outputDir);
  }
}

/**
 * 保存标注了识别位置的截图用于调试
 */
async function saveAnnotatedScreenshot(desktopImage, bestMatch,option) {
  try {
    const {matchsInfo,templatesInfo,debugPath}=option
    const annotated = desktopImage.copy();
    // 绘制矩形框标记找到的图标
    annotated.drawRectangle(
        new cv.Point(bestMatch.x, bestMatch.y),
        new cv.Point(bestMatch.x + bestMatch.cols, bestMatch.y + bestMatch.rows),
        new cv.Vec(0, 255, 0), // 绿色边框
        2 // 线宽
    );
    const debugFile = path.join(debugPath, `debug_${matchsInfo.name}_${templatesInfo.name}.png`);

    judgeDir(debugPath);//判断并处理目录
    cv.imwrite(debugFile, annotated);//imwrite 遇到不存在的目录 直接失败，不抛错，不提示
    console.log(`已保存调试截图: ${debugPath}`);
  } catch (err) {
    console.error('保存调试截图失败:', err);
  }
}

/**
 * 从模板中识别浏览器图标
 */
async function findBrowserIcon(option={}) {
  const {matchsInfo,templatesInfo,config}=option
  const matchsImage = cv.imdecode(matchsInfo.buffer)
  // 转为灰度图提高匹配稳定性
  const desktopGray = matchsImage.cvtColor(cv.COLOR_BGR2GRAY);

  // 多尺度因子，控制模板缩放范围
  // const scales = [0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4];
  const scales = generateRange(0.5, 1.5);

  // 记录全局最佳匹配
  let bestMatch = null;
  let bestConfidence = 0;

  console.log(`正在匹配: ${templatesInfo.name}`);
  try {
    // 读取模板并转为灰度图
    const templatesImage = cv.imdecode(templatesInfo.buffer)
    const templateGray = templatesImage.cvtColor(cv.COLOR_BGR2GRAY);

    // 遍历所有尺度
    for (const scale of scales) {
      // 缩放模板（比缩放原图高效得多） resize精度需要是整数
      // const scaledTemplate = templateGray.resize(Math.round(templateGray.rows * scale),Math.round(templateGray.cols * scale));

      // 缩放模板 (直接使用 fx, fy 缩放)
      const scaledTemplate = templateGray.resize(0, 0, scale, scale);

      // 确保缩放后的模板不会比桌面图像大
      if (scaledTemplate.rows > desktopGray.rows || scaledTemplate.cols > desktopGray.cols) {
        console.log(`${templatesInfo.name}模板尺寸过大，跳过`);
        continue;
      }

      // 执行模板匹配
      // matchTemplate 对尺度（大小）非常敏感。
      // 模板图片如果比桌面图标小（或大），哪怕只是几个像素，匹配度都会急剧下降。
      const matched = desktopGray.matchTemplate(scaledTemplate, cv.TM_CCOEFF_NORMED);//cv.TM_CCOEFF_NORMED 综合效果最好，对光照和对比度变化都有很好的鲁棒性
      const { maxLoc, maxVal } = matched.minMaxLoc();

      // 正确写法：一个console.log = 一个换行符
      console.log(`${templatesInfo.name} 尺度${scaledTemplate.rows}/${scaledTemplate.cols}: 匹配度${maxVal.toFixed(2)}\x1B[1A\x1B[K`);

      // 匹配度判断
      if (maxVal > bestConfidence && maxVal >= config.matchThreshold) {
        // 更新全局最佳匹配
        bestConfidence = maxVal;

        bestMatch = {
          name: templatesInfo.name,
          x: maxLoc.x,
          y: maxLoc.y,
          confidence: maxVal,
          cols: scaledTemplate.cols,
          rows: scaledTemplate.rows,
          scale: scale // 记录当前匹配使用的尺度
        };
      }
    }

    console.log(' '.repeat(100));
  } catch (err) {
    console.error(`识别${templatesInfo.name}时出错:`, err);
  }

  if (bestMatch) {
    console.log(`找到最佳匹配: ${bestMatch.name}，匹配度: ${bestMatch.confidence.toFixed(2)}，尺度: ${bestMatch.scale.toFixed(1)}`);

    // 获取系统缩放比例（修正最终点击坐标）
    const screenScale = await getScreenScaleFactor();
    console.log(`系统缩放比: ${screenScale}`);

    // 计算图标中心位置（截图坐标）
    // 需要除以系统缩放，从而获取正确的底层坐标
    // 图标宽高 也需要按照缩放比处理，从而确认真实坐标定位
    const centerX = (bestMatch.x + bestMatch.cols / 2) / screenScale;
    const centerY = (bestMatch.y + bestMatch.rows / 2) / screenScale;

    console.log(`修正后中心坐标: (${centerX.toFixed(1)}, ${centerY.toFixed(1)})`);

    // 保存调试信息
    if (config.debugMode) {
      await saveAnnotatedScreenshot(matchsImage, bestMatch,option);
    }

    return {
      ...bestMatch,
      x: Math.round(centerX),
      y: Math.round(centerY),
    };
  }

  return null;
}

function createJsonTemplate(){
  return {
    mappings: [//配置模板和匹配图路径
      {
        templates: 'chrome.png',
        matchs: 'auto',
      },
    ],
    matchThreshold: 0.65,//模板匹配阈值
    // 新增：调试模式，保存标注了识别位置的截图
    debugMode: true
  }
}

async function writingRules(inputArray, outputNodeTemplate) {
  const outputDir = outputNodeTemplate.path // 临时目录绝对路径
  const inputPath = path.join(outputDir, '../inputDir');
  const debugPath = path.join(outputDir, '/debug');

  const mappingFile = inputArray.find(item => item.normExt === 'json' && item.name === 'mapping');

  if (!mappingFile) {
    const jsonTemplate = createJsonTemplate();
    return [
      { ...outputNodeTemplate, content: '错误: 未找到 mapping.json 文件,示例文件已创建' },
      {...outputNodeTemplate, path: inputPath, fileName: 'mapping',normExt:'json', content: JSON.stringify(jsonTemplate, null, 2)}
    ];
  }
  const configInfo = JSON.parse(mappingFile.content)

  const content = []

  try {
    console.log('开始识别匹配页面...');

    const mappings = configInfo.mappings;
    for (const mapping of mappings) {
      let  matchsBuffer=null;
      //截图将决定用户实际点击位置
      if(mapping.matchs==='auto'){//使用实时自动截图
        matchsBuffer = await screenshot({ format: 'png' });
      }else{//使用用户提供截图
        const matchsItem = inputArray.find(item => item.dir.endsWith('matchs') && item.base === mapping.matchs);
        matchsBuffer = matchsItem && matchsItem.content;
      }

      if (!matchsBuffer) {
        return [
          { ...outputNodeTemplate, content: `错误: 未找到 需要匹配的页面,请在 matchs 目录下存放${mapping.matchs}截图 或 更改为auto实时截图` }
        ];
      }

      const templatesItem = inputArray.find(item => item.dir.endsWith('templates') && item.base === mapping.templates);
      const templatesBuffer = templatesItem && templatesItem.content;
      if (!templatesBuffer) {
        return [
          { ...outputNodeTemplate, content: `错误: 未找到 模板图片,请在 templates 目录下存放${mapping.templates}截图，图片名需要与 mapping.json 匹配` }
        ];
      }

      const browser = await findBrowserIcon({
        matchsInfo:{
          name: mapping.matchs,
          buffer:matchsBuffer
        },
        templatesInfo:{
          name: mapping.templates,
          buffer:templatesBuffer
        },
        config:configInfo,
        debugPath:debugPath
      });

      if (browser) {
        const pos={
          x:browser.x,
          y:browser.y
        }
        console.log(`鼠标移动到（处理后）: (${pos.x}, ${pos.y})`);
        await clickPos(browser, 300, {double: true})

        console.log('已模拟双击');

        // 浏览器打开后自动输入搜索内容
        await sleep(2000);
        await typeText('需要搜索的内容');
        robot.keyTap('enter');
      } else {
        console.log('未找到任何浏览器图标');
      }

      content.push({
        success:true,
        name:templatesItem.name
      })
    }
  } catch (err) {
    console.error('程序出错:', err);

    content.push({
      success:false,
      msg:err
    })
  }

  return [
    {...outputNodeTemplate, fileName: 'result', normExt:'json', content: JSON.stringify(content, null, 2)}
  ];
}

// module.exports = writingRules; // 导出主处理函数

module.exports = {
  name: 'opencv2match',
  version: '1.0.0',
  process: writingRules,
  description:'基于opencv的图像匹配应用点击',
  notes:{
    node:'18.20.4',
  },
  input: {
    normExt: 'json配置文件+matchs目录的识别图片+templates目录的模板图片'
  },
  output: {
    normExt: 'matchs目录的匹配图片',
  },
  rely:{//默认 latest
    'robotjs': '0.6.0',
    '@u4/opencv4nodejs':'7.1.2',
    'screenshot-desktop':'1.15.4'
  }
};