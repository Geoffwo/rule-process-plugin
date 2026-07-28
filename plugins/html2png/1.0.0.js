const puppeteer = require('puppeteer');//控制无头 Chrome 浏览器渲染 HTML、截图
const path = require('path');

// ========== 默认渲染参数 ==========
const DEFAULTS = {
  width: 1200,            // 浏览器视口宽度
  height: 800,            // 浏览器视口高度
  scale: 1,               // 设备像素比（值越大越清晰，2=Retina）
  transparent: false,     // 是否透明背景
  fullPage: false,        // 是否截取整页
  selector: '',           // 可选CSS选择器，仅截取该元素；为空则截取视口
  //networkidle0：页面网络请求全部停止后再截图，适合带接口请求的动态 HTML。
  waitUntil: 'networkidle0' // 页面加载完成判定策略
};

// =======================
// HTML转PNG核心函数：使用puppeteer渲染HTML并截图
// @param {object} browser puppeteer浏览器实例（复用以提升性能）
// @param {string} html HTML字符串
// @param {object} options 渲染参数
// @returns {Promise<Buffer>} PNG图片二进制流
// =======================
async function htmlToPngBuffer(browser, html, options) {//职责：单段 HTML 字符串渲染，返回 PNG Buffer
  const { width, height, scale, transparent, fullPage, selector='', waitUntil } = options;

  const page = await browser.newPage();//创建独立标签页
  try {
    // 设置视口尺寸与设备像素比
    await page.setViewport({ width, height, deviceScaleFactor: scale });//设置窗口尺寸 + DPR 缩放
    // 写入HTML内容，等待网络空闲
    await page.setContent(html, { waitUntil });//载入 HTML 文本（不是访问 URL）

    let buffer;

    // 截取指定DOM元素
    const element = await page.waitForSelector(selector, { timeout: 10000 });//等待目标 DOM 元素

    if (!element) {//无元素：页面全屏 / 视口截图 page.screenshot()
      // 截取整页或视口
      buffer = await page.screenshot({
        type: 'png',
        omitBackground: transparent,
        fullPage
      });
    }else{//存在元素：等待目标 DOM 元素，调用 element.screenshot() 只截取单个元素
      buffer = await element.screenshot({
        type: 'png',
        omitBackground: transparent//开启透明 PNG
      });
    }

    return buffer;
  } finally {//强制关闭页面，防止内存泄漏
    await page.close();
  }
}

// =======================
// 生成默认配置模板（未找到config.json时输出到inputDir供用户编辑）
// =======================
function createConfigTemplate() {
  return { ...DEFAULTS };
}

// 新增：生成示例HTML模板
function createSampleHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{
  width:100%;min-height:100vh;
  background:linear-gradient(135deg,#f8f9fa,#eef2ff);
  font-family:system-ui,-apple-system,sans-serif;
  display:flex;align-items:center;justify-content:center;
}
.card{
  background:#fff;
  padding:48px 64px;
  border-radius:16px;
  box-shadow:0 8px 30px rgba(0,0,0,0.08);
}
.title{
  font-size:28px;color:#222;
  font-weight:500;
}
.desc{
  margin-top:12px;font-size:15px;color:#666;
}
</style>
</head>
<body>
<div class="card">
  <div class="title">HTML 转 PNG 示例模板</div>
  <div class="desc">修改此页面内容，自动渲染生成图片</div>
</div>
</body>
</html>`;
}

// =======================
// 主处理入口：框架调用的核心函数
// @param {Array} inputArray 输入文件数组
// @param {object} outputNodeTemplate 输出格式模板
// @returns {Array} 处理结果数组
// =======================
async function writingRules(inputArray, outputNodeTemplate) {
  const outputDir = outputNodeTemplate.path;
  const inputPath = path.join(outputDir, '../inputDir');

  const configFile = inputArray.find(item => item.normExt === 'json' && item.name === 'config');
  if (!configFile) {
    const config = createConfigTemplate()
    return [
      { ...outputNodeTemplate, content: '错误: 未找到 config.json 文件，已生成默认配置模板' },
      { ...outputNodeTemplate, path: inputPath, fileName: 'config', normExt: 'json', content: JSON.stringify(config, null, 2) }
    ];
  }

  const htmlFiles = inputArray.filter(item => item.normExt === 'html');
  if (htmlFiles.length === 0) {
    const sampleHtmlContent = createSampleHtml();
    return [
      { ...outputNodeTemplate, content: '错误: 未找到 html 文件，请在inputDir放入.html文件' },
      { ...outputNodeTemplate, path: inputPath, fileName: 'demo', normExt: 'html', content: sampleHtmlContent }
    ];
  }

  const userConfig = JSON.parse(configFile.content);
  const config = { ...DEFAULTS, ...userConfig };
  const results = [];

  // 3. 启动浏览器（复用实例，逐个转换）
  const browser = await puppeteer.launch({//启动 Puppeteer 浏览器实例
    headless: true,//无头模式，不弹出浏览器窗口
    args: ['--no-sandbox', '--disable-setuid-sandbox']//Linux 服务器、Docker 容器运行必备参数，解决权限报错
  });

  try {
    //循环每个 HTML
    for (const file of htmlFiles) {
      try {
        console.log(`[html2png] 正在转换: ${file.name}.html`);
        const buffer = await htmlToPngBuffer(browser, file.content, config);

        results.push({
          ...outputNodeTemplate,
          fileName: file.name,
          normExt: 'png',
          content: buffer
        });
        console.log(`[html2png] 完成: ${file.name}.html → ${file.name}.png`);
      } catch (err) {
        console.error(`[html2png] 转换失败 ${file.name}.html:`, err.message);
        results.push({
          ...outputNodeTemplate,
          fileName: `${file.name}_fail`,
          normExt: 'txt',
          content: Buffer.from(`转换失败: ${err.message}`)
        });
      }
    }
  } finally {
    await browser.close();
  }

  // 4. 输出转换汇总
  const success = results.filter(r => r.normExt === 'png').length;
  const fail = results.filter(r => r.normExt === 'txt').length;
  results.push({
    ...outputNodeTemplate,
    fileName: 'html2png_summary',
    normExt: 'json',
    content: JSON.stringify({
      total: htmlFiles.length,
      success,
      fail,
      config,
      generatedAt: new Date().toLocaleString()
    }, null, 2)
  });

  return results;
}

module.exports = {
  name: 'html2png',
  version: '1.0.0',
  process: writingRules,
  description: '通过Puppeteer将inputArray中的HTML文件批量转换为PNG图片',
  notes: {
    node: '18.20.4',
    tips: 'inputDir放入.html文件自动转换；可选config.json配置width/height/scale/selector/transparent/fullPage等参数'
  },
  input: {
    normExt: 'html',
    description: 'HTML文件（自动循环读取）；可选config.json配置渲染参数'
  },
  output: {
    normExt: 'png、json、txt',
    format: '每个HTML对应一张PNG，附转换汇总JSON，失败输出错误文本'
  },
  rely: {
    'puppeteer': '19.11.1'
  }
};