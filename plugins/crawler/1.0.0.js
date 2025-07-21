const axios = require('axios');
const cheerio = require('cheerio');

// 配置UA和超时时间（绕过基础反爬）
const config = {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
  },
  timeout: 8000
};

// 爬取单页数据的函数
async function crawlPage(page) {
  try {
    // 计算起始位置（每页25条，第1页start=0，第2页start=25，以此类推）
    const start = (page - 1) * 25;
    const url = `https://movie.douban.com/top250?start=${start}`;

    console.log(`正在爬取第${page}页: ${url}`);
    const response = await axios.get(url, config);
    const $ = cheerio.load(response.data);
    const pageMovies = [];

    // 提取当前页电影数据
    $('.item').each((index, element) => {
      const title = $(element).find('.title').first().text().trim();
      const rating = $(element).find('.rating_num').text().trim();
      const comment = $(element).find('.quote span').text().trim() || '暂无短评';
      const link = $(element).find('.hd a').attr('href'); // 新增电影详情页链接
      const imgUrl = $(element).find('.pic img').attr('src'); // 新增电影海报

      pageMovies.push({
        id: start + index + 1, // 全局唯一ID（1-250）
        title,
        rating,
        comment,
        link,
        imgUrl
      });
    });

    console.log(`第${page}页爬取完成，获取${pageMovies.length}条数据`);
    return pageMovies;
  } catch (error) {
    console.error(`❌ 第${page}页爬取失败:`, error.message);
    return [];
  }
}

// 主处理函数 - 爬取所有页面
async function writingRules(inputArray, outputNodeTemplate) {
  const allMovies = [];
  const totalPages = 10; // 总共10页

  try {
    // 循环爬取所有页面
    for (let page = 1; page <= totalPages; page++) {
      const pageData = await crawlPage(page);
      allMovies.push(...pageData);

      // 非最后一页时添加延迟，避免请求过于频繁被反爬
      if (page < totalPages) {
        await new Promise(resolve => setTimeout(resolve, 1500)); // 1.5秒延迟
      }
    }

    console.log(`✅ 所有页面爬取完成，共获取${allMovies.length}条电影数据`);
  } catch (error) {
    console.error('❌ 整体爬取过程出错:', error.message);
  }

  const outputNode = {
    ...outputNodeTemplate,
    fileName: 'douban_top250_results',
    normExt: 'json',
    content: JSON.stringify(allMovies, null, 2)
  };

  return [outputNode];
}

// module.exports = writingRules;

module.exports = {
  name: 'crawler',
  version: '1.0.0',
  process: writingRules,
  disable: true,
  description: '获取豆瓣电影Top250榜单数据，包括电影名称、评分、短评、详情链接和海报地址', // 准确描述功能
  notes: {
    node: '14.18.0', // 明确支持的Node版本
  },
  input: {
    //无需输入参数，直接运行即可生成包含Top250电影信息的JSON文件
  },
  output: {
    normExt: 'json文件',
    format: "[{id,title,rating,comment,link,imgUrl}]"
  },
  rely: { // 明确指定兼容的依赖版本
    'axios': '0.27.2', // 兼容Node 14的版本
    'cheerio': '1.0.0-rc.11' // 兼容Node 14的版本，避免使用??=运算符的版本
  }
};
