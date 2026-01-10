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
      const img = await cv.imreadAsync(pngFile.path);

      // 获取基本信息
      const width = img.cols;    // 宽度（列数）
      const height = img.rows;   // 高度（行数）
      const channels = img.channels;  // 通道数（彩色图通常为3，灰度图为1）

      console.log(`图片信息：${pngFile.path} | 宽：${width} | 高：${height} | 通道：${channels}`);

      // 初始化绘图所需的Point/Vec
      const watermarkText = "geoffwo";
      const fontFace = cv.FONT_HERSHEY_SIMPLEX;
      const fontScale = 0.7;
      const thickness = 2;
      const textColor = new cv.Vec3(255, 255, 255); // 白色（BGR）

      // 1. 计算文字尺寸
      const {size} = cv.getTextSize(watermarkText, fontFace, fontScale, thickness);

      // 2. 设置水印位置（右下角，留 10px 边距）
      const margin = 10;
      const x = width - size.width - margin;
      const y = height - margin;

      // 创建一个与原图同尺寸的黑色图层（用于写白色文字）
      const overlay = new cv.Mat(height, width, cv.CV_8UC3, [0, 0, 0]);
      overlay.putText( watermarkText, new cv.Point2(x, y), fontFace, fontScale, textColor, thickness);

      // 加权融合：img = α * img + β * overlay + γ
      // 半透明融合（alpha=0.95 原图，beta=0.5 水印）
      let result = img.copy();// 直接赋值给result失败，result 是 CV_8UC3（整型），addWeighted 内部计算涉及浮点权重（0.85, 0.5），OpenCV 无法安全地将浮点结果直接写入整型 Mat
      const mat = cv.addWeighted(img, 0.95, overlay, 0.5, 0, result);//在类型不匹配时不会 in-place 修改 dst，而是返回一个新 Mat

      // 5. 显示图片
      cv.imshow('Image', mat); // 新窗口名为 "Gradient Image"
      console.log('图片现在应该在新窗口中显示');
      // 等待用户按键
      cv.waitKey(3000); // 按任意键继续执行后续代码或关闭程序
      cv.destroyAllWindows();

      // 6. 保存处理后的图片（官方imwriteAsync）
      const outputPath = path.join(outputNodeTemplate.path, 'opencv05.png')
      await cv.imwriteAsync(outputPath, mat);
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

  return [{...outputNodeTemplate,fileName: 'opencv05',normExt: 'json',content:JSON.stringify(content, null, 2)}];
}

module.exports = {
  name: 'opencv',
  version: '0.5.2',
  process: writingRules,
  description: 'opencv基础：增加半透明水印',
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