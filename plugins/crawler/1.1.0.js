const { chromium } = require('playwright'); // 引入Playwright的Chromium模块[1,3](@ref)

// 主处理函数
async function writingRules(inputArray, outputNodeTemplate) {
  const browser = await chromium.launch({ headless: true }); // 启动无头Chromium浏览器(无UI)[3](@ref)
  const page = await browser.newPage(); // 创建新页面实例[4](@ref)
  const allMovies = []; // 存储所有电影数据的数组

  try {
    // 1. 导航到目标页面
    await page.goto('https://movie.douban.com/top250', {
      waitUntil: 'domcontentloaded', // 等待基础DOM加载完成[4](@ref)
      timeout: 60000 // 设置60秒超时防止卡死[1](@ref)
    });

    // 2. 分页抓取逻辑
    let pageCount = 1;
    while (pageCount <= 10) { // 豆瓣Top250共10页
      console.log(`⏳ 正在抓取第 ${pageCount} 页...`);

      // 等待电影列表渲染
      await page.waitForSelector('.grid_view', {
        state: 'attached', // 确保元素已附加到DOM[1](@ref)
        timeout: 15000    // 15秒超时
      });

      // 提取当前页数据
      const pageMovies = await page.$$eval('.item', (items) => // 获取所有.item元素[4](@ref)
          items.map(item => ({
            title: item.querySelector('.title')?.innerText || '未知标题', // 获取标题
            rating: item.querySelector('.rating_num')?.innerText || '无评分', // 获取评分
            comment: item.querySelector('.quote span')?.innerText || '暂无短评', // 获取评论数并提取数字
            link: item.querySelector('.hd a')?.getAttribute('href') || '暂无', // 新增电影详情页链接
            imgUrl: item.querySelector('.pic img')?.getAttribute('src')|| '暂无', // 新增电影海报
          }))
      );
      allMovies.push(...pageMovies); // 合并当前页数据到总数组

      // 3. 翻页处理
      const nextButton = await page.$('.next a'); // 定位"下一页"按钮[4](@ref)
      if (nextButton && pageCount < 10) {
        await Promise.all([ // 并行执行两个异步操作
          page.waitForLoadState('domcontentloaded'), // 等待新页面加载[4](@ref)
          nextButton.click() // 点击下一页[4](@ref)
        ]);
        await page.waitForTimeout(2000); // 模拟人工浏览间隔(防反爬)[3](@ref)
        pageCount++;
      } else {
        break; // 最后一页退出循环
      }
    }
  }catch (error) {
    console.error('处理文件出错:', error); // 错误处理
  } finally {
    await browser.close(); // 确保浏览器关闭[1](@ref)
    console.log('浏览器已关闭');
  }

  const outputNode = {
    ...outputNodeTemplate,
    fileName: 'douban_top250_result',
    normExt: 'json',
    content: JSON.stringify(allMovies, null, 2)
  };

  return [outputNode];
}

// module.exports = writingRules;

module.exports = {
  name: 'crawler',
  version: '1.0.1',
  process: writingRules,
  disable: true,
  description: '获取豆瓣电影Top250榜单数据，包括电影名称、评分、短评、详情链接和海报地址', // 准确描述功能
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
    'playwright': '1.54.2', // 兼容Node 18的版本
  },
  command:{//增加额外指令
    //.cmd 当前只适配windows平台
    "npx.cmd":"playwright install" //安装playwright需要的插件
  }
};
