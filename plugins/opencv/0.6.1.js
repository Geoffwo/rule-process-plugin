const cv = require('@u4/opencv4nodejs');
const path = require("path");

/**
 * 图片信息提取处理函数
 * 读取输入的PNG/图片文件，使用OpenCV提取图片的基本信息（宽度、高度、通道数等）
 */
async function writingRules(inputArray, outputNodeTemplate) {
  // 检查文件是否存在
  const pngFiles = inputArray.filter(file => file.normExt === 'png');

  if (pngFiles.length === 0) {
    console.log('未找到 pngFiles 数据');
    return [
      { ...outputNodeTemplate, content: '错误: 未找到pngFiles数据' }
    ];
  }

  const content = []
  for (const pngFile of pngFiles) {
    try {
      // 读取图片（支持JPG、PNG等格式）
      // imreadAsync是异步方法，返回图像矩阵对象
      // const img = cv.imread(pngFile.path);//同步
      const img = await cv.imreadAsync(pngFile.path);//默认读取方式 BGR

      // 获取基本信息
      const width = img.cols;    // 宽度（列数）
      const height = img.rows;   // 高度（行数）
      const channels = img.channels;  // 通道数（彩色图通常为3，灰度图为1）

      console.log(`图片信息：${pngFile.path} | 宽：${width} | 高：${height} | 通道：${channels}`);

      // 2. 同位置获取像素
      const [b, g, r] = img.atRaw(50, 50); // 取中间像素
      //计算灰度值 Gray = 0.299*R + 0.587*G + 0.114*B
      const bgr2gray = 0.299*r + 0.587*g + 0.114*b

      console.log('\n=== BGR空间信息 ===');
      console.log('通道数：', img.channels); // 输出1
      console.log('(50,50)灰度值：', bgr2gray); // （公式：0.299*R + 0.587*G + 0.114*B）

      // 3. 灰度图
      const grayImg = img.cvtColor(cv.COLOR_BGR2GRAY);
      // 读取灰度值（单个数值）
      const grayVal = grayImg.at(50, 50);

      console.log('\n=== 灰度空间信息 ===');
      console.log('通道数：', grayImg.channels); // 输出1
      console.log('(50,50)灰度值：', grayVal);

      // 3. 黑白反色：255 - 原像素值（白色变黑色，黑色变白色）
      // const invertGray = grayImg.bitwiseNot();
      // 灰度图反色 正确写法【新手理解原理】 适配所有版本
      const invertGray = grayImg.copy(); // 克隆原图，不修改原图像（重要！）
      // 遍历所有行(y轴：高度)
      for (let y = 0; y < invertGray.rows; y++) {
        // 遍历所有列(x轴：宽度)
        for (let x = 0; x < invertGray.cols; x++) {
          const pixelVal = invertGray.at(y, x); // 读取当前像素灰度值
          invertGray.set(y, x, 255 - pixelVal); // 写入反色值：核心公式
        }
      }

      // 5. 显示图片
      cv.imshow('Image', invertGray); // 新窗口名为 "Gradient Image"
      console.log('图片现在应该在新窗口中显示');
      // 优化写法：等待3秒，期间按任意键立即关闭
      cv.waitKey(3000) & 0xFF;// 按任意键继续执行后续代码或关闭程序
      cv.destroyAllWindows();

      // 6. 保存处理后的图片（官方imwriteAsync）
      const outputPath = path.join(outputNodeTemplate.path, 'opencv06.png')
      await cv.imwriteAsync(outputPath, invertGray);
      console.log(`在图片上绘制图形已保存：${outputPath}`);

      content.push({
        filePath: pngFile.path,
        success:true,
        width: width,
        height: height,
        channels: channels,
        type: channels === 3 ? '彩色图（BGR）' : '灰度图'
      })
    } catch (err) {
      // 处理错误（如文件不存在、格式错误）
      console.error('处理失败：', err.message);
      content.push({
        filePath: pngFile.path,
        success:false,
        message: err.message,
      })
    }
  }

  return [{...outputNodeTemplate,fileName: 'opencv06',normExt: 'json',content:JSON.stringify(content, null, 2)}];
}

module.exports = {
  name: 'opencv',
  version: '0.6.1',
  process: writingRules,
  description: 'opencv基础：反色图（灰度图取反）',
  notes: {
    node: '18.20.4',
    msg:'0.x.x代表学习分支，实际插件价值偏低',
    environment: {
      step1:[
        '安装OpenCV系统依赖:',
        '下载 Windows 版 OpenCV（官网，选择 4.x 版本）,解压后添加以下系统环境变量：',
        '(目的是npm install @u4/opencv4nodejs远程下载opencv访问国外地址，网络不稳定极易报错；手动指定本地opencv)',
        'OPENCV4NODEJS_DISABLE_AUTOBUILD = 1 ',
        'OPENCV_INCLUDE_DIR  = E:\\opencv-4.5.5-vc16\\build\\include ',
        'OPENCV_LIB_DIR  = E:\\opencv-4.5.5-vc16\\build\\x64\\vc16\\lib ',
        'OPENCV_BIN_DIR  = E:\\opencv-4.5.5-vc16\\build\\x64\\vc16\\bin ',
      ],
      step2:[
        '确认VS2022的C++编译工具已安装:',
        '打开 Visual Studio Installer',
        '勾选 "使用 C++ 的桌面开发"',
      ]
    }
  },
  input: {
    normExt: 'png',
    format: '图片文件（支持PNG、JPG等格式）'
  },
  output: {
    normExt: 'json',
    format: "包含图片信息的JSON文件，包含文件名、宽度、高度、通道数等信息"
  },
  rely: {
    '@u4/opencv4nodejs': '7.1.2',
  }
};