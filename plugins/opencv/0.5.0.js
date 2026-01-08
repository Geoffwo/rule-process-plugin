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

            // 3. 初始化绘图所需的Point/Vec
            // 1. 坐标点（Point）：文档里的 pt2 = new cv.Point(100, 100)
            const lineStart = new cv.Point(50, 50);    // 直线起点
            const lineEnd = new cv.Point(200, 50);     // 直线终点
            const rectTopLeft = new cv.Point(50, 80);  // 矩形左上角
            const rectBottomRight = new cv.Point(200, 180); // 矩形右下角
            const circleCenter = new cv.Point(125, 130); // 圆心
            const textStart = new cv.Point(50, 220);   // 文字起点

            // 2. 颜色（Vec）：文档里的 vec3 = new cv.Vec(100, 100, 0.5)，BGR格式
            const redColor = new cv.Vec(0, 0, 255);    // 红色（BGR）
            const greenColor = new cv.Vec(0, 255, 0);  // 绿色（BGR）
            const blueColor = new cv.Vec(255, 0, 0);   // 蓝色（BGR）

            // ============= 步骤4：绘制图形 =============
            // 1. 绘制直线：imgMat.drawLine(起点Point, 终点Point, 颜色Vec, 线宽)
            img.drawLine(lineStart, lineEnd, redColor, 2);

            // 2. 绘制矩形：img.drawRectangle(左上角Point, 右下角Point, 颜色Vec, 线宽)
            // 线宽=-1表示填充，参考OpenCV原生接口规则
            img.drawRectangle(rectTopLeft, rectBottomRight, greenColor, 2);

            // 3. 绘制圆形：img.drawCircle(圆心Point, 半径, 颜色Vec, 线宽)
            img.drawCircle(circleCenter, 40, blueColor, 2);

            // 4. 绘制文字：img.putText(文字, 起点Point, 字体, 字号, 颜色Vec, 线宽)
            // 字体参数参考OpenCV原生接口，使用cv.FONT_HERSHEY_SIMPLEX
            img.putText("OpenCV Draw (Official API)", textStart, cv.FONT_HERSHEY_SIMPLEX, 0.8, redColor, 2);

            // 5. 显示图片
            cv.imshow('Image', img); // 新窗口名为 "Gradient Image"
            console.log('图片现在应该在新窗口中显示');
            // 等待用户按键
            cv.waitKey(); // 按任意键继续执行后续代码或关闭程序
            cv.destroyAllWindows();

            // 6. 保存处理后的图片（官方imwriteAsync）
            const outputPath = path.join(outputNodeTemplate.path, 'opencv05.png')
            await cv.imwriteAsync(outputPath, img);
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
    version: '0.5.0',
    process: writingRules,
    description: 'opencv基础：在图片上绘制图形或文字',
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