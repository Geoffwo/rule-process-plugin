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
    // 创建Mat对象：300x200，8位无符号3通道，BGR颜色(255,0,0)是纯蓝色
    const image = new cv.Mat(height, width, cv.CV_8UC3, [255, 0, 0]);

    console.log('图片创建成功！');
    console.log('图片宽度:', image.cols, '像素');
    console.log('图片高度:', image.rows, '像素');
    console.log('颜色通道:', image.channels, '个通道');
    console.log('(3个通道是彩色图片，1个通道是黑白图片)');


    // 获取(0,0)位置像素的颜色值
    const pixelColor = image.at(0, 0); // 或者使用 image.at<Vec3b>(0, 0)
    console.log('第一个像素的颜色:',pixelColor);
    console.log('蓝色分量:', pixelColor.x, '(B)'); // 应该输出 255
    console.log('绿色分量:', pixelColor.y, '(G)'); // 应该输出 0
    console.log('红色分量:', pixelColor.z, '(R)'); // 应该输出 0

    // 保存图片
    const outputPath = path.join(outputNodeTemplate.path, 'opencv02.jpg')
    cv.imwrite(outputPath, image);

    return [{...outputNodeTemplate,fileName: 'opencv02',content:'蓝色图片创建成功'}];
}

module.exports = {
    name: 'opencv',
    version: '0.2.0',
    process: writingRules,
    description: 'opencv基础：创建一张简单的蓝色测试图片，并保存到指定路径',
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