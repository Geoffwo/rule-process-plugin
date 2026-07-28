const puppeteer = require('puppeteer');
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
  waitUntil: 'networkidle0', // 页面加载完成判定策略
  pageTimeout: 30000,     // 页面访问超时 ms
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36',          // 自定义UA
  urlList: ["https://www.baidu.com"]             // 需要截图的URL数组
};

// =======================
// URL转PNG核心函数：访问网页截图
// @param {object} browser puppeteer浏览器实例（复用提升性能）
// @param {string} url 目标网址
// @param {object} options 渲染参数
// @returns {Promise<Buffer>} PNG图片二进制流
// =======================
async function urlToPngBuffer(browser, url, options) {
  const {
    width, height, scale, transparent, fullPage, selector,
    waitUntil, pageTimeout, userAgent
  } = options;

  const page = await browser.newPage();//创建独立标签页
  try {
    await page.setViewport({ width, height, deviceScaleFactor: scale });//设置窗口尺寸 + DPR 缩放

    // 配置UA
    if (userAgent) {
      await page.setUserAgent(userAgent);
    }

    // 访问远程URL
    await page.goto(url, {//访问 URL
      waitUntil,
      timeout: pageTimeout
    });

    let buffer;
    let targetElement = null;
    if (selector) {//存在元素：等待目标 DOM 元素
      try {
        targetElement = await page.waitForSelector(selector, { timeout: ELEMENT_WAIT_TIMEOUT });
      } catch {
        console.log(`[url2png提示] 地址:${url} 选择器【${selector}】未找到，降级截取整页`);
      }
    }

    if (targetElement) {//存在元素：等待目标 DOM 元素，调用 element.screenshot() 只截取单个元素
      buffer = await targetElement.screenshot({
        type: 'png',
        omitBackground: transparent//开启透明 PNG
      });
    } else {//无元素：页面全屏 / 视口截图 page.screenshot()
      buffer = await page.screenshot({
        type: 'png',
        omitBackground: transparent,
        fullPage
      });
    }
    return buffer;
  } finally {
    await page.close();
  }
}

// =======================
// 生成默认配置模板（未找到config.json时输出到inputDir供用户编辑）
// =======================
function createConfigTemplate() {
  return { ...DEFAULTS };
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
    const config = createConfigTemplate();
    return [
      { ...outputNodeTemplate, content: '错误: 未找到 config.json 文件，已生成默认配置模板' },
      { ...outputNodeTemplate, path: inputPath, fileName: 'config', normExt: 'json', content: JSON.stringify(config, null, 2) }
    ];
  }

  const userConfig = JSON.parse(configFile.content);
  const config = { ...DEFAULTS, ...userConfig };
  const results = [];

  // 提取URL列表，过滤空值
  const urlList = Array.isArray(config.urlList) ? config.urlList.filter(Boolean) : [];
  if (urlList.length === 0) {
    return [
      { ...outputNodeTemplate, content: '错误: config.json 内 urlList 为空，请填入需要截图的网址数组' }
    ];
  }

  // 启动浏览器
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    for (const url of urlList) {
      try {
        console.log(`[url2png] 正在访问截取: ${url}`);
        const buffer = await urlToPngBuffer(browser, url, config);

        // 使用域名生成文件名，替换小数点避免路径异常
        const urlObj = new URL(url);
        const fileName = urlObj.hostname.replace(/\./g, '_');

        results.push({
          ...outputNodeTemplate,
          fileName,
          normExt: 'png',
          content: buffer
        });
        console.log(`[url2png] 完成: ${url} → ${fileName}.png`);
      } catch (err) {
        console.error(`[url2png] 截取失败 ${url}:`, err.message);
        results.push({
          ...outputNodeTemplate,
          fileName: `url_fail_${Date.now()}`,
          normExt: 'txt',
          content: Buffer.from(`URL: ${url}\n错误信息: ${err.message}`)
        });
      }
    }
  } finally {
    await browser.close();
  }

  // 输出转换汇总
  const success = results.filter(r => r.normExt === 'png').length;
  const fail = results.filter(r => r.normExt === 'txt').length;
  results.push({
    ...outputNodeTemplate,
    fileName: 'url2png_summary',
    normExt: 'json',
    content: JSON.stringify({
      total: urlList.length,
      success,
      fail,
      config,
      generatedAt: new Date().toLocaleString()
    }, null, 2)
  });

  return results;
}

module.exports = {
  name: 'url2png',
  version: '1.0.0',
  process: writingRules,
  description: '通过Puppeteer访问远程URL网页批量截图导出PNG图片',
  notes: {
    node: '18.20.4',
    tips: 'inputDir放置config.json，配置urlList网址数组；支持width/height/scale/selector/userAgent等参数'
  },
  input: {
    normExt: 'json',
    description: '仅依赖 config.json，内部配置 urlList 截图任务列表'
  },
  output: {
    normExt: 'png、json、txt',
    format: '每个URL对应一张PNG，附转换汇总JSON，失败输出错误文本'
  },
  rely: {
    'puppeteer': '19.11.1'
  }
};