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

            // BGR → HSV
            const hsvImg = img.cvtColor(cv.COLOR_BGR2HSV);
            console.log('已转换为 HSV 色彩空间');

            // 获取 (50,50) 像素的 HSV 值
            const [h, s, v] = hsvImg.atRaw(50, 50);
            console.log(`(50,50) 处 HSV 值: H=${h}, S=${s}, V=${v}`);

            // 分离 HSV 三个通道（用于学习）
            // const [hChannel, sChannel, vChannel] = hsvImg.splitChannels();
            const [hChannel, sChannel, vChannel] = cv.split(hsvImg);

            // 6. 保存处理后的图片（官方imwriteAsync）
            const outputPath = path.join(outputNodeTemplate.path, 'opencv07_hsv.png')
            const outputPath_H = path.join(outputNodeTemplate.path, 'opencv07_h.png')
            const outputPath_S = path.join(outputNodeTemplate.path, 'opencv07_s.png')
            const outputPath_V = path.join(outputNodeTemplate.path, 'opencv07_v.png')
            await cv.imwriteAsync(outputPath, hsvImg);
            await cv.imwriteAsync(outputPath_H, hChannel);
            await cv.imwriteAsync(outputPath_S, sChannel);
            await cv.imwriteAsync(outputPath_V, vChannel);
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

    return [{...outputNodeTemplate,fileName: 'opencv07',normExt: 'json',content:JSON.stringify(content, null, 2)}];
}

module.exports = {
    name: 'opencv',
    version: '0.7.0',
    process: writingRules,
    description: 'opencv基础：hsv颜色识别更优秀，Hue（色调）- Saturation（饱和度）- Value（明度）',
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