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
      const bgrImg = await cv.imreadAsync(pngFile.path);//默认读取方式 BGR

      // 获取基本信息
      const width = bgrImg.cols;    // 宽度（列数）
      const height = bgrImg.rows;   // 高度（行数）
      const channels = bgrImg.channels;  // 通道数（彩色图通常为3，灰度图为1）

      console.log(`图片信息：${pngFile.path} | 宽：${width} | 高：${height} | 通道：${channels}`);

      // 图像滤波: 对图像进行局部像素运算，以达到增强、平滑、锐化或提取特征的目的。
      // - 均值滤波: 对局部区域像素取算术平均，实现简单模糊与去噪，但会明显模糊边缘和细节。图像类型：灰度图
      // - 高斯滤波: 使用高斯权重对邻域像素加权平均，更自然地模糊图像，有效抑制高斯型噪声，同时比均值滤波更好地保留结构。图像类型：灰度图、彩色图
      // - 中值滤波: 用邻域像素的中位数代替中心像素，极擅长去除椒盐噪声（黑白孤立噪点），且能较好保留边缘。图像类型：灰度图
      // - 双边滤波: 同时考虑空间距离和像素值相似性，在去噪的同时强力保留边缘，常用于美颜、卡通化等场景。图像类型：灰度图、彩色图

      // 转为灰度图（也可直接对彩色图滤波）
      const gray = bgrImg.cvtColor(cv.COLOR_BGR2GRAY);

      // 1. 高斯滤波（核大小为奇数，标准差设为1）
      // 参数一: ksize（高斯核）宽高（必须是正奇数，如 3, 5, 7…），核越大，模糊范围越广，太大会导致图像过度模糊，常用值：3（轻度）、5（中等）、7+（重度）
      // 参数二: sigmaX（X方向标准差） sigma 越大，高斯核中心与高斯核边缘像素权重差异越小 → 模糊越强，若设为 0，OpenCV 会根据 ksize 自动计算：sigma = 0.3 * ((ksize - 1) * 0.5 - 1) + 0.8
      // 参数三: sigmaY（Y方向标准差）（可选） 默认 = sigmaX	通常设为相同值，保持各向同性
      // const gaussianBlur = gray.gaussianBlur(new cv.Size(3, 3), 0.5);//模糊较弱
      const gaussianBlur = gray.gaussianBlur(new cv.Size(5, 5), 1);//模糊越强

      // 2. 双边滤波（降噪同时保留边缘，适合彩色图）
      // 只有空间上近 且 颜色上相似的像素，才对中心像素有贡献。
      // 参数一:d（像素范围邻域直径）控制每个像素受多大范围邻居影响；-1表示由 sigmaSpace 自动计算；值越大，计算越慢（推荐 5～15）
      // 参数二:sigmaColor（颜色相似性标准差）决定颜色权重的“衰减速度”；值越大，颜色差异容忍度越高 → 更多像素参与平均 → 去噪更强但边缘可能弱化；小值（如 10～30）能强力保留边缘（适合人脸磨皮）
      // 参数三:sigmaSpace（空间距离标准差）决定空间权重的“衰减速度”；值越大，远处像素也参与 → 模糊范围更大；通常与 sigmaColor 设为相近值
      // const bilateralBlur = bgrImg.bilateralFilter(5, 30, 30);//模糊较弱
      const bilateralBlur = bgrImg.bilateralFilter(9, 75, 75);//75 即使角落像素也有较高权重 → 模糊较强

      // 6. 保存过程图片
      const outputPath_gray = path.join(outputNodeTemplate.path, 'opencv11_gray.png')
      const outputPath_gaussian = path.join(outputNodeTemplate.path, 'opencv11_gaussian.png')
      const outputPath_bilateral = path.join(outputNodeTemplate.path, 'opencv11_bilateral.png')
      await cv.imwriteAsync(outputPath_gray, gray);
      await cv.imwriteAsync(outputPath_gaussian, gaussianBlur);
      await cv.imwriteAsync(outputPath_bilateral, bilateralBlur);
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

  return [{...outputNodeTemplate,fileName: 'opencv11',normExt: 'json',content:JSON.stringify(content, null, 2)}];
}

module.exports = {
  name: 'opencv',
  version: '0.11.0',
  process: writingRules,
  description: 'opencv基础：图片滤波（均值滤波、高斯滤波、中值滤波、双边滤波）用于去噪、模糊、锐化或增强细节',
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