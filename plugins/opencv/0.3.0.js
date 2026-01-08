const cv = require('@u4/opencv4nodejs');
const path = require('path');

/**
 * 创建一张简单的蓝色测试图片，并保存到指定路径
 * 获取像素值
 */
async function writingRules(inputArray, outputNodeTemplate) {

    // 1. 先用代码创建一张简单的测试图片
    const width = 300;
    const height = 200;

    // 创建一个 300x200 的蓝色图片
    // 创建一个空白的Mat对象：300x200，8位无符号3通道（BGR）
    const image = new cv.Mat(height, width, cv.CV_8UC3);

    // 3. 逐像素计算渐变颜色并赋值（核心逻辑）
    for (let y = 0; y < height; y++) {  // 遍历高度（行）
        for (let x = 0; x < width; x++) {  // 遍历宽度（列）
            // 计算当前x位置的BGR分量（水平渐变：B从255→0，R从0→255，G固定0）
            const blue = Math.floor((width - x) * 255 / width);   // 蓝分量
            const green = 0;                                    // 绿分量
            const red = Math.floor(x * 255 / width);             // 红分量

            // 用官方cv.Vec构造颜色向量（符合文档Vector示例）
            const colorVec = new cv.Vec(blue, green, red);

            // 方式A：用Mat.set赋值（官方推荐的像素设置方式）
            image.set(y, x, colorVec);

            // 方式B：用Mat.at获取后赋值（备选，部分版本兼容）
            // gradientMat.at(y, x).set(blue, green, red);
        }
    }

    console.log('图片创建成功！');
    console.log('图片宽度:', image.cols, '像素');
    console.log('图片高度:', image.rows, '像素');
    console.log('颜色通道:', image.channels, '个通道');

    // 显示图片
    cv.imshow('Gradient Image', image); // 新窗口名为 "Gradient Image"
    console.log('图片现在应该在新窗口中显示');

    // 等待用户按键
    cv.waitKey(); // 按任意键继续执行后续代码或关闭程序
    cv.destroyAllWindows();

    // 保存图片
    const outputPath = path.join(outputNodeTemplate.path, 'opencv03.jpg')
    cv.imwrite(outputPath, image);

    return [{...outputNodeTemplate,fileName: 'opencv03',content:'蓝色图片创建成功'}];
}

module.exports = {
    name: 'opencv',
    version: '0.3.0',
    process: writingRules,
    description: 'opencv基础：创建一张简单的渐变色测试图片，弹窗显示，并保存到指定路径',
    notes: {
        node: '18.20.4',
        msg:'0.0.x代表学习分支，实际插件价值偏低',
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