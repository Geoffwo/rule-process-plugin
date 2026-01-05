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

/**
 * 生成一个不会重复的文件名
 * @returns {string}
 */
function getUniqueFileName() {
  const prefix = 'result'
  const now = new Date();
  const pad = n => n.toString().padStart(2, '0');
  const dateStr = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const randomStr = Math.random().toString(36).slice(2, 6); // 6位随机字符串
  return `${prefix}_${dateStr}_${randomStr}`;
}

// 主处理函数 - 爬取所有页面
async function* writingRules(inputArray, outputNodeTemplate) {
  const totalPages = 10; // 总共10页

  try {
    // 循环爬取所有页面
    for (let page = 1; page <= totalPages; page++) {
      const pageData = await crawlPage(page);

      // 构造当前页的outputNode（改为追加模式：仅包含当前页数据，方便后续追加写入文件）
      const outputNode = {
        ...outputNodeTemplate,
        fileName: getUniqueFileName(),
        normExt: 'json',
        content: JSON.stringify(pageData, null, 2), // 仅序列化当前页数据，而非所有数据
      };

      // 按页面导出：产出当前页的outputNode数组（保持原有返回格式一致）
      yield [outputNode];

      // 非最后一页时添加延迟，避免请求过于频繁被反爬
      if (page < totalPages) {
        await new Promise(resolve => setTimeout(resolve, 1500)); // 1.5秒延迟
      }
    }

    console.log(`所有页面爬取并迭代产出完成，共${totalPages}页`);
  } catch (error) {
    console.error('整体爬取过程出错:', error.message);
    // 出错时产出空数据，保证迭代不中断
    yield [{ ...outputNodeTemplate, content: `整体爬取过程出错:${error.message}`}];
  }
}

// module.exports = writingRules;

module.exports = {
  name: 'crawler',
  version: '1.0.1',
  process: writingRules,
  disable: true,
  description: '获取豆瓣电影Top250榜单数据，包括电影名称、评分、短评、详情链接和海报地址(使用迭代生成器逐步生成，减少内存)', // 准确描述功能
  notes: {
    node: '18.20.4', // 明确支持的Node版本
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
