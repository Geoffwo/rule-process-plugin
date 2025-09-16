const axios = require('axios');

// 配置UA和超时时间（绕过基础反爬）
const config = {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
  },
  timeout: 8000,
  responseType: 'arraybuffer' // 关键：设置二进制响应类型
};

// 下载单张图片
async function downloadImg(imgUrl) {
  try {
    console.log(`正在下载: ${imgUrl}`);
    const response = await axios.get(imgUrl, config);

    // 获取图片类型（从响应头推测）
    const contentType = response.headers['content-type'] || '';
    let ext = 'png' //contentType.includes('png')或默认
    if(contentType.includes('jpeg')){
      ext = 'jpg'
    }
    return {
      data: response.data,
      ext: ext
    };
  } catch (error) {
    console.error(`下载失败 [${imgUrl}]:`, error.message);
    return null;
  }
}

// 处理文件名（过滤特殊字符）
function sanitizeFileName(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim();
}

// 主处理函数
async function writingRules(inputArray, outputNodeTemplate) {
  // 过滤出json文件
  const jsonFiles = inputArray.filter(item => item.normExt === 'json');

  if (jsonFiles.length === 0) {
    return [{
      ...outputNodeTemplate,
      content: '错误: 未找到图片下载配置文件'
    }];
  }

  const result = [];
  for (const file of jsonFiles) {
    try {
      const content = file.content;
      const parse = JSON.parse(content); // 解析配置信息

      // 支持单张图片和多张图片数组
      const images = Array.isArray(parse) ? parse : [parse];

      for (const imgConfig of images) {
        const name = imgConfig.name || `img_${Date.now()}`;
        const imgName = sanitizeFileName(name);//过滤特殊字符
        const imgUrl = imgConfig.imgUrl;

        if (!imgUrl) {
          console.log(`${imgName} 缺少图片URL，跳过`);
          continue;
        }

        const imgData = await downloadImg(imgUrl);
        if (imgData) {
          result.push({
            ...outputNodeTemplate,
            fileName: imgName,
            normExt: imgData.ext, // 使用实际图片扩展名
            content: imgData.data
          });
        }

        // 控制下载速度，避免被反爬
        await new Promise(resolve => setTimeout(resolve, 1000));//await阻塞等待1s后resolve放行
      }
    } catch (error) {
      console.error(`处理文件出错:`, error.message);
    }
  }
  return result;
}

// module.exports = writingRules;

module.exports = {
  name: 'download-img', // 插件名称：明确为图片批量下载器
  version: '1.0.0',
  process: writingRules,
  description: '通过JSON配置文件批量下载图片，支持单张或多张图片配置，自动处理文件名特殊字符并识别图片格式', // 匹配实际功能
  notes: {
    node: '18.20.4', // 保持支持的Node版本
  },
  input: {
    normExt: 'json文件',
    format:"[{name:'图片名称',imgUrl:'图片下载地址'}]"
  },
  output: {
    normExt: 'img文件'
  },
  rely: {
    'axios': '0.27.2', // 兼容Node 14的版本
  }
};
