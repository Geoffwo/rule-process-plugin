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

      //RGB 图像 → 滤波降噪 → 转换为 HSV 空间 → 颜色阈值筛选（得到灰度掩码） → 二值化 → 形态学优化 → 轮廓检测

      // ==================== 滤波降噪 ====================
      const bilateralBlur = bgrImg.bilateralFilter(9, 75, 75);// 双边滤波（降噪同时保留边缘，适合彩色图）

      // ==================== 颜色分割 ====================
      const hsv = bilateralBlur.cvtColor(cv.COLOR_BGR2HSV);
      const mask1 = hsv.inRange(new cv.Vec(0, 30, 30), new cv.Vec(10, 255, 255));
      const mask2 = hsv.inRange(new cv.Vec(170, 30, 30), new cv.Vec(180, 255, 255));
      const noisyRedMask = mask1.bitwiseOr(mask2);//生成一个“脏”的红色掩膜

      // ==================== 形态学优化 ====================
      const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));//创建结构元素
      const cleanRedMask = noisyRedMask.morphologyEx(kernel,cv.MORPH_OPEN);   // 去噪 cv.MORPH_OPEN 开运算 先腐蚀 → 后膨胀
      const finalMask = cleanRedMask.morphologyEx(kernel,cv.MORPH_CLOSE);     // 填洞 cv.MORPH_CLOSE 闭运算 先膨胀 → 后腐蚀

      // ==================== 轮廓检测====================
      const contourInput = finalMask.copy(); // 安全起见
      const contours = contourInput.findContours(cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

      // 2. 复制原图用于绘制（避免修改原始 bgrImg）
      const imgWithContours = bgrImg.copy();

      // 基于图像总面积的百分比
      const imageArea = width * height;
      const minAreaRatio = 0.001; // 0.1%，可根据效果调整为 0.0005 ～ 0.005
      const minArea = imageArea * minAreaRatio;

      // 3. 遍历每个轮廓，过滤小面积，并绘制边界框
      let objectCount = 0;
      contours.forEach(contour => {
        const area = contour.area; // 计算轮廓包围的像素面积

        // 自动过滤小区域
        if (area < minArea) {
          return; // 跳过
        }

        objectCount++;

        // 计算轮廓的边界矩形（bounding box）
        const rect = contour.boundingRect();
        const pt1 = new cv.Point(rect.x, rect.y);
        const pt2 = new cv.Point(rect.x + rect.width, rect.y + rect.height);

        // 在图上绘制绿色矩形框（B=0, G=255, R=0）
        imgWithContours.drawRectangle(pt1, pt2, new cv.Vec(0, 255, 0), 2);
      });

      // 6. 保存过程图片
      const outputPath_bilateralBlur = path.join(outputNodeTemplate.path, 'opencv01_bilateralBlur.png')
      const outputPath_noisyRedMask = path.join(outputNodeTemplate.path, 'opencv01_noisyRedMask.png')
      const outputPath_cleanRedMask = path.join(outputNodeTemplate.path, 'opencv01_cleanRedMask.png')
      const outputPath_finalMask = path.join(outputNodeTemplate.path, 'opencv01_finalMask.png')
      const outputPath = path.join(outputNodeTemplate.path, 'opencv01.png')
      await cv.imwriteAsync(outputPath_bilateralBlur, bilateralBlur);
      await cv.imwriteAsync(outputPath_noisyRedMask, noisyRedMask);
      await cv.imwriteAsync(outputPath_cleanRedMask, cleanRedMask);
      await cv.imwriteAsync(outputPath_finalMask, finalMask);
      await cv.imwriteAsync(outputPath, imgWithContours);
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

  return [{...outputNodeTemplate,fileName: 'opencv01',normExt: 'json',content:JSON.stringify(content, null, 2)}];
}

module.exports = {
  name: 'opencv',
  version: '1.0.0',
  process: writingRules,
  description: 'opencv系统化红色区域检测',
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