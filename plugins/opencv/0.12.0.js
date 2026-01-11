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

      //二值化(将灰度图转换为只有黑白两色（0 和 255）的图像):
      // - 全局阈值，均匀光照实验图，阈值需人工调试
      // - Otsu，自动计算最优全局阈值，仍受全局光照影响
      // - 自适应，自动计算最优全局阈值，不受光照影响（推荐）

      // 0. 灰度图
      const gray = img.cvtColor(cv.COLOR_BGR2GRAY);
      // 1. 全局阈值二值化（超过阈值设为 255，否则 0）
      // 参数一:阈值 T；像素值 > T → 设为 maxval（255）；像素值 ≤ T → 设为 0；范围：0～255（灰度图）
      // 参数二:最大输出值 maxval；通常设为 255（纯白）；若用 THRESH_BINARY_INV，则前景变黑
      // 参数三:阈值类型；THRESH_BINARY：dst = (src > T) ? maxval : 0；THRESH_BINARY_INV：反色；THRESH_TRUNC：截断（保留原值但不超过 T）
      const binaryGlobal = gray.threshold(127, 255, cv.THRESH_BINARY);

      // 2. Otsu 自动阈值
      // 参数一:被忽略！Otsu 会自动计算最优 T，此值无意义（但必须传）
      // 参数二:同上，输出最大值
      // 参数三:组合标志；THRESH_BINARY：指定二值化模式；THRESH_OTSU：启用 Otsu 算法
      const binaryOtsu = gray.threshold(0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);

      // 3. 自适应阈值二值化（适合光照不均的图像）
      const binaryAdaptive = gray.adaptiveThreshold(
          255,                          // maxValue，二值化后的最大值（同全局阈值）
          cv.ADAPTIVE_THRESH_GAUSSIAN_C,       // 方法：高斯加权 or 均值（如何计算局部阈值），阈值 = 邻域内像素的高斯加权平均值 - 常数 C
          cv.THRESH_BINARY,                    // 阈值类型，二值化类型（目前只支持 BINARY 和 BINARY_INV），BINARY：像素值 > 阈值 → 设为最大值，否则 → 0
          15,                         // blockSize，邻域窗口大小（必须是 ≥3 的奇数），文字图：11～15，大物体：21～31
          2                                 // C（常数，从局部均值中减去），C > 0：结果更“黑”（适合浅色文字），C < 0：结果更“白”；通常 2～10，从 2 开始试
      );

      // 6. 保存处理后的图片（官方imwriteAsync）
      const outputPath_binaryGlobal = path.join(outputNodeTemplate.path, 'opencv12_binaryGlobal.png')
      const outputPath_binaryOtsu = path.join(outputNodeTemplate.path, 'opencv12_binaryOtsu.png')
      const outputPath_binaryAdaptive = path.join(outputNodeTemplate.path, 'opencv12_binaryAdaptive.png')
      await cv.imwriteAsync(outputPath_binaryGlobal, binaryGlobal);
      await cv.imwriteAsync(outputPath_binaryOtsu, binaryOtsu);
      await cv.imwriteAsync(outputPath_binaryAdaptive, binaryAdaptive);
      console.log(`在图片上绘制图形已保存`);

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

  return [{...outputNodeTemplate,fileName: 'opencv12',normExt: 'json',content:JSON.stringify(content, null, 2)}];
}

module.exports = {
  name: 'opencv',
  version: '0.12.0',
  process: writingRules,
  description: 'opencv基础：二值化，将灰度图转换为只有黑白两色',
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