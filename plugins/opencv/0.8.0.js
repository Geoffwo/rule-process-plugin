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

    // 保留指定颜色，其余变灰
    // H 色调 红=0°, 绿=120°, 蓝=240°
    // S 饱和度 S=0 → 灰色；S=255 → 最鲜艳
    // V 明度 V=0 → 黑色；V=255 → 最亮
    const lower1 = new cv.Vec(0, 50, 100);   //H=0 S=50 V=100 下限
    const upper1 = new cv.Vec(10, 255, 255);  //H=10 S=255 V=255 上限
    // 如果想要减少粉红 就将s从50变为100
    const lower2 = new cv.Vec(170, 50, 100); //H=170 S=50 V=100 下限
    const upper2 = new cv.Vec(180, 255, 255); //H=180 S=255 V=255 上限

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

            // 1. 转 HSV 并生成红色掩膜
            const hsv = bgrImg.cvtColor(cv.COLOR_BGR2HSV);
            const mask1 = hsv.inRange(lower1, upper1);
            const mask2 = hsv.inRange(lower2, upper2);
            const colorMask = mask1.bitwiseOr(mask2); // 合并两个红色区间

            // 2. 原图 → 灰度图 → 再转回 BGR（三通道）
            const gray = bgrImg.cvtColor(cv.COLOR_BGR2GRAY);
            const grayBgr = gray.cvtColor(cv.COLOR_GRAY2BGR); // 关键：让灰度图有3通道

            // 3. 【核心】用掩膜把原图的彩色区域“复制”到灰度背景上
            const result = new cv.Mat(bgrImg.rows, bgrImg.cols, cv.CV_8UC3);
            grayBgr.copyTo(result); // 先填满灰度
            bgrImg.copyTo(result, colorMask); // 再把彩色区域覆盖上去

            // 6. 保存处理后的图片（官方imwriteAsync）
            const outputPath = path.join(outputNodeTemplate.path, 'opencv08.png')
            await cv.imwriteAsync(outputPath, result);
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

    return [{...outputNodeTemplate,fileName: 'opencv08',normExt: 'json',content:JSON.stringify(content, null, 2)}];
}

module.exports = {
    name: 'opencv',
    version: '0.8.0',
    process: writingRules,
    description: 'opencv基础：保留红色，其余变灰',
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