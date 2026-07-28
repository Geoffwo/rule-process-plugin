const axios = require('axios');
const cheerio = require('cheerio');
const path = require("path");

/**
 * 图片信息提取处理函数
 * 读取输入的PNG/图片文件，使用OpenCV提取图片的基本信息（宽度、高度、通道数等）
 */
async function writingRules(inputArray, outputNodeTemplate) {
  const outputPath = outputNodeTemplate.path;
  const inputPath = path.join(outputPath, '../inputDir');

  // 检查文件是否存在
  const jsonFile = inputArray.find(file => file.normExt === 'json' && file.name === 'config');

  if (!jsonFile) {
    console.log('未找到 jsonFiles 数据');
    const jsonTemplate = createDefaultConfig();
    return [
      { ...outputNodeTemplate, path: inputPath, fileName: 'config', normExt: 'json', content: JSON.stringify(jsonTemplate, null, 2) },
      { ...outputNodeTemplate, content: '错误: 未找到jsonFiles数据' },
    ];
  }

  const content = []

  const configs = JSON.parse(jsonFile.content);
  for (const config of configs) {
    const weatherList = await crawlWeather(config) || [];
    content.push(...weatherList)
  }

  return [{...outputNodeTemplate,fileName: 'result',normExt: 'json',content:JSON.stringify(content, null, 2)}];
}

function createDefaultConfig(){
  return [
    {
      // 城市拼音（对应网站URL：https://www.tianqihoubao.com/lishi/[城市拼音]/month/[年月].html）
      cityPinyin: 'beijing', // 济南：jinan，北京：beijing，上海：shanghai，可自行替换
      yearMonth: '202512' // 爬取2026年1月数据，格式：YYYYMM
    },
    {
      // 城市拼音（对应网站URL：https://www.tianqihoubao.com/lishi/[城市拼音]/month/[年月].html）
      cityPinyin: 'jinan', // 济南：jinan，北京：beijing，上海：shanghai，可自行替换
      yearMonth: '202601', // 爬取2026年1月数据，格式：YYYYMM
      delay: 1000 // 1秒延迟，避免频繁请求被封
    },
    {
      // 城市拼音（对应网站URL：https://www.tianqihoubao.com/lishi/[城市拼音]/month/[年月].html）
      cityPinyin: 'jinan', // 济南：jinan，北京：beijing，上海：shanghai，可自行替换
      yearMonth: '202602', // 爬取2026年1月数据，格式：YYYYMM
      delay: 1000 // 1秒延迟，避免频繁请求被封
    }
  ]
}

/**
 * 核心：爬取天气数据
 */
async function crawlWeather(config) {
  // 目标URL
  const TARGET_URL = `https://www.tianqihoubao.com/lishi/${config.cityPinyin}/month/${config.yearMonth}.html`;

  try {
    console.log(`🔍 开始爬取 ${config.cityPinyin} ${config.yearMonth} 的天气数据...`);

    // 1. 延迟请求（反爬）
    const delay = config.delay || 1000
    await new Promise(resolve => setTimeout(resolve, config.delay));

    // 2. 获取页面HTML
    const response = await axios.get(TARGET_URL, {
      // 反爬：设置请求头（模拟浏览器）、请求延迟
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.tianqihoubao.com/',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      },
      timeout: 10000 // 超时时间10秒
    });
    const html = response.data;

    // 3. 用cheerio解析HTML（类似jQuery操作DOM）
    const $ = cheerio.load(html);
    const weatherList = [];

    // 4. 定位天气表格（网站表格结构：<table class="weather-table"> → <tr> → <td>）
    $('table.weather-table tr').each((index, element) => {
      // 跳过表头行（第一行是标题）
      if (index === 0) return;

      const tds = $(element).find('td');
      // 确保td数量正确（日期、天气状况、气温、风力）
      if (tds.length < 4) return;

      // 提取并清洗数据（去除空格、换行）
      const city = config.cityPinyin
      const date = $(tds[0]).text().replace(/\s+/g, ''); // 日期
      const weather = $(tds[1]).text().replace(/\s+/g, ''); // 天气状况（晴/雨等）
      const temp = $(tds[2]).text().replace(/\s+/g, ''); // 气温
      const wind = $(tds[3]).text().replace(/\s+/g, ''); // 风力风向

      if (date) { // 过滤空数据
        weatherList.push({ city, date, weather, temp, wind });
      }
    });

    // 5. 检查是否爬取到数据
    if (weatherList.length === 0) {
      console.log('❌ 未爬取到数据：可能城市拼音/年月错误，或网站结构变更');
      return;
    }

    // 6. 保存数据到本地JSON文件
    return weatherList
  } catch (error) {
    console.error('❌ 爬取失败：', error.message);
    if (error.response) {
      console.error('🔍 响应状态码：', error.response.status);
    }
  }
}

module.exports = {
  name: 'crawler2weather',
  version: '1.0.0',
  process: writingRules,
  disable: true,
  description: '获取历史天气数据，包括日期、天气状况、气温、风力风向的json数据', // 准确描述功能
  notes: {
    node: '18.20.4', // 明确支持的Node版本
  },
  input: {
    normExt: 'json文件',
  },
  output: {
    normExt: 'json文件',
    format: "[{xxx}]"
  },
  rely: { // 明确指定兼容的依赖版本
    'axios': '0.27.2', // 兼容Node 14的版本
    'cheerio': '1.0.0-rc.11' // 兼容Node 14的版本，避免使用??=运算符的版本
  }
};