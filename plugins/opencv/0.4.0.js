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

            console.log('图片信息：');
            console.log(`文件路径：${pngFile.path}`);
            console.log(`宽度：${width}px`);
            console.log(`高度：${height}px`);
            console.log(`通道数：${channels}（${channels === 3 ? '彩色图（BGR）' : '灰度图'}）`);

            // 3. 加深红色分量（仅处理彩色图，灰度图无通道区分）
            if (channels === 3) {
                // 3. 分离BGR通道（严格匹配官方splitChannels API）
                const [matB, matG, matR] = img.splitChannels();

                // const matR_Ratio = matR;// 红色增强系数
                // 步骤3：逐像素处理（核心：只用at/set，绝对支持）
                // for (let y = 0; y < height; y++) {
                //     for (let x = 0; x < width; x++) {
                //         // 读取浮点型红色值（at是最基础的像素读取方法）
                //         let rVal = matR.at(y, x);
                //         // 用JS原生Math做增强+截断
                //         rVal = rVal * 5; // 增强
                //         rVal = Math.min(Math.max(rVal, 0), 255); // 截断0-255
                //         // 写回8位通道（set是最基础的像素设置方法）
                //         matR_Ratio.set(y, x, rVal);
                //     }
                // }

                const matR_Ratio = matR.mul(1.5);// 红色增强系数

                // 5. 合并通道
                const enhancedImg = new cv.Mat([matB, matG, matR_Ratio]);

                // 6. 保存处理后的图片（官方imwriteAsync）
                const outputPath = path.join(outputNodeTemplate.path, 'opencv04.png')
                await cv.imwriteAsync(outputPath, enhancedImg);
                console.log(`红色加深后的图片已保存：${outputPath}`);
            } else {
                console.log(`文件${pngFile.path}是灰度图，无需处理红色通道`);
            }

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

    return [{...outputNodeTemplate,fileName: 'opencv04',normExt: 'json',content:JSON.stringify(content, null, 2)}];
}

module.exports = {
    name: 'opencv',
    version: '0.4.0',
    process: writingRules,
    description: 'opencv基础：强化图片红色区域',
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