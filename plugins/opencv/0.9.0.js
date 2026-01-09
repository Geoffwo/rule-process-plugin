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

            // 形态学处理：
            // - 它主要针对二值图（黑白图，像素值只有 0 和 255），也可用于灰度图，是边缘检测、目标识别的重要前置步骤。
            // - 形态学处理的核心是【腐蚀】和【膨胀】，这两个是基础操作；【开运算】和【闭运算】是它们的组合操作。
            // - 所有操作都遵循一个规则：用结构元素扫描图像的每个像素，根据邻域内的像素值决定当前像素的最终值。

            // 掩码运算的核心：处理【颜色筛选】，在彩色图可以肉眼分辨颜色
            // 形态学的核心：处理【形状修正】，在二值图里形状缺陷会被放大

            // 1. 生成一个“脏”的红色掩膜
            const hsv = bgrImg.cvtColor(cv.COLOR_BGR2HSV);
            const mask1 = hsv.inRange(new cv.Vec(0, 50, 100), new cv.Vec(10, 255, 255));
            const mask2 = hsv.inRange(new cv.Vec(170, 50, 100), new cv.Vec(180, 255, 255));
            const noisyRedMask = mask1.bitwiseOr(mask2);

            //noisyRedMask 是一张二值图（白色 = 苹果红色区域，黑色 = 背景），图里有：
            // 背景里的「白色小噪点」（你要去掉的）
            // 苹果区域里的「黑色小洞」（你要填充的）

            // 2. 创建结构元素（椭圆，5x5）
            // 一个白色的小点，到底算不算「噪点」？如果你的尺子是 5x5，这个小点只有 1x1，就会被判定为噪点、被去掉
            const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));

            // 3. 【关键修正】使用 Mat.prototype.morphologyEx
            // 腐蚀：用结构元素扫描图像，当前像素值 = 邻域内的最小值；消除小的亮区域（白色噪点），收缩物体边界；像用橡皮擦 “擦除” 物体的边缘，让物体变小
            // 膨胀：用结构元素扫描图像，当前像素值 = 邻域内的最大值；填充物体内部的小黑洞，扩张物体边界；像给物体 “描边加粗”，让物体变大
            // 开运算：先腐蚀 → 后膨胀；消除小的亮噪点，同时保持物体的整体大小不变；先擦除噪点，再还原物体大小，不改变形状
            // 闭运算：先膨胀 → 后腐蚀；填充物体内部的小黑洞，同时保持物体的整体大小不变；先填补缺口，再还原物体大小，不改变形状
            const cleanRedMask = noisyRedMask.morphologyEx(kernel,cv.MORPH_OPEN);   // 去噪 cv.MORPH_OPEN 开运算 先腐蚀 → 后膨胀
            const finalMask = cleanRedMask.morphologyEx(kernel,cv.MORPH_CLOSE);     // 填洞 cv.MORPH_CLOSE 闭运算 先膨胀 → 后腐蚀

            // 6. 保存过程图片
            const outputPath_noisy = path.join(outputNodeTemplate.path, 'opencv09_noisy.png')
            const outputPath_clean = path.join(outputNodeTemplate.path, 'opencv09_clean.png')
            const outputPath_final = path.join(outputNodeTemplate.path, 'opencv09_final.png')
            await cv.imwriteAsync(outputPath_noisy, noisyRedMask);
            await cv.imwriteAsync(outputPath_clean, cleanRedMask);
            await cv.imwriteAsync(outputPath_final, finalMask);
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

    return [{...outputNodeTemplate,fileName: 'opencv09',normExt: 'json',content:JSON.stringify(content, null, 2)}];
}

module.exports = {
    name: 'opencv',
    version: '0.9.0',
    process: writingRules,
    description: 'opencv基础：图片去除噪声，连接断裂（适用于二值图观察）',
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