// 引入Jimp库用于图像处理（纯JavaScript实现，无需系统依赖）
const Jimp = require('jimp');

/**
 * 图片转音频核心函数：将PNG图像数据嵌入到WAV音频文件中
 * 原理：将图像的尺寸信息和像素数据按特定格式封装为WAV文件
 * @param {string} imagePath - 输入PNG图片的文件路径
 * @returns {Promise<Buffer>} 生成的WAV音频文件Buffer
 */
async function imageToAudio(imagePath) {
  // 步骤1：使用Jimp加载PNG图片并提取图像数据
  // Jimp会自动处理PNG的解码，返回包含像素信息的图像对象
  const image = await Jimp.read(imagePath);
  const width = image.bitmap.width;         // 获取图像宽度（像素）
  const height = image.bitmap.height;       // 获取图像高度（像素）
  const pixelData = image.bitmap.data;      // 提取RGBA像素数据（Uint8Array格式，每4个元素表示一个像素的R、G、B、A值）

  // 步骤2：创建头部信息，用于存储图像的尺寸（后续从音频还原图片时需要）
  // 头部共8字节：前4字节存储宽度（小端模式），后4字节存储高度（小端模式）
  const header = Buffer.alloc(8);
  header.writeUInt32LE(width, 0);    // 以32位无符号整数、小端模式写入宽度
  header.writeUInt32LE(height, 4);   // 以32位无符号整数、小端模式写入高度

  // 步骤3：合并头部信息和像素数据，形成完整的自定义数据块
  // 这样在后续还原时，可先读取头部获取尺寸，再解析后续的像素数据
  const combinedData = Buffer.concat([
    header,
    Buffer.from(pixelData)  // 将Uint8Array格式的像素数据转换为Buffer
  ]);

  // 步骤4：生成标准WAV文件头（符合WAV格式规范，使音频播放器能识别为有效音频）
  const sampleRate = 44100;  // 音频采样率：44.1kHz（常用的音频采样标准）
  const numChannels = 1;     // 声道数：1（单声道，简化处理）
  const bitDepth = 8;        // 采样深度：8位（每个采样点用8位表示）
  const wavHeaderSize = 44;  // 标准WAV文件头固定大小为44字节
  const dataSize = combinedData.length;  // 自定义数据块的大小
  const fileSize = wavHeaderSize + dataSize;  // 整个WAV文件的总大小

  // 分配44字节缓冲区用于存储WAV头
  const wavHeader = Buffer.alloc(wavHeaderSize);

  // 填充RIFF区块（WAV格式的基础标识）
  wavHeader.write('RIFF', 0);                     // RIFF标识
  wavHeader.writeUInt32LE(fileSize - 8, 4);       // 文件大小（减去RIFF标识和自身的4字节）
  wavHeader.write('WAVE', 8);                     // WAVE标识

  // 填充fmt子区块（描述音频格式参数）
  wavHeader.write('fmt ', 12);                    // fmt子块标识
  wavHeader.writeUInt32LE(16, 16);                // 子块大小（PCM格式固定为16）
  wavHeader.writeUInt16LE(1, 20);                 // 音频格式：1表示PCM（脉冲编码调制，无损格式）
  wavHeader.writeUInt16LE(numChannels, 22);       // 声道数
  wavHeader.writeUInt32LE(sampleRate, 24);        // 采样率
  // 计算字节率：采样率 × 声道数 × 位深度/8（每秒的字节数）
  wavHeader.writeUInt32LE(sampleRate * numChannels * bitDepth / 8, 28);
  // 计算块对齐：声道数 × 位深度/8（每个采样点的字节数）
  wavHeader.writeUInt16LE(numChannels * bitDepth / 8, 32);
  wavHeader.writeUInt16LE(bitDepth, 34);          // 位深度

  // 填充data子区块（标识实际音频数据）
  wavHeader.write('data', 36);                    // data子块标识
  wavHeader.writeUInt32LE(dataSize, 40);          // 数据部分的大小

  // 步骤5：合并WAV头和自定义数据块，生成完整的WAV文件Buffer
  return Buffer.concat([wavHeader, combinedData]);
}

/**
 * 主处理函数：批量处理输入的PNG文件，转换为WAV并生成结果汇总
 * @param {Array} inputArray - 输入文件信息数组，每个元素包含path（路径）、name（文件名）等
 * @param {Object} outputNodeTemplate - 输出节点的模板配置（用于规范输出格式）
 * @returns {Promise<Array>} 处理结果数组，包含生成的WAV文件和汇总JSON
 */
async function writingRules(inputArray, outputNodeTemplate) {
  // 过滤出所有PNG格式的文件（只处理.png后缀的文件）
  const pngFiles = inputArray.filter(info => info.path.endsWith('.png'));

  // 如果没有PNG文件，返回错误信息
  if (pngFiles.length === 0) {
    return [{
      ...outputNodeTemplate,  // 继承输出模板配置
      fileName: 'result',     // 结果文件名
      content: '错误: 未找到有效的图片。请提供.png文件。'  // 错误提示内容
    }];
  }

  const result = [];         // 存储最终输出结果（WAV文件和JSON）
  const contents = [];       // 存储每个文件的处理状态（成功/失败信息）

  // 遍历处理每个PNG文件
  for (const file of pngFiles) {
    try {
      // 调用图片转音频函数，获取WAV文件Buffer
      const audioBuffer = await imageToAudio(file.path);

      // 将生成的WAV文件添加到结果中
      result.push({
        ...outputNodeTemplate,
        fileName: file.name,  // 保留原文件名
        normExt: 'wav',       // 输出文件后缀为wav
        content: audioBuffer  // 文件内容为WAV的Buffer
      });

      // 记录成功信息
      contents.push({ fileName: file.name, message: `生成成功` });
    } catch (err) {
      // 捕获并记录错误信息
      contents.push({ fileName: file.name, message: `生成失败: ${err.message}` });
    }
  }

  // 生成处理结果汇总的JSON文件
  result.push({
    ...outputNodeTemplate,
    fileName: 'result',      // 汇总结果文件名
    content: JSON.stringify(contents, null, 2)  // 格式化JSON，便于阅读
  });

  return result;
}

// 模块导出配置：定义模块的元数据和接口
module.exports = {
  name: 'img2audio',                // 模块名称
  version: '1.0.0',                // 模块版本
  process: writingRules,           // 模块的核心处理函数
  description: '将PNG图片转换为WAV音频文件',  // 模块功能描述
  notes: {
    node: '18.20.4'                // 兼容的Node.js版本
  },
  input: {
    normExt: ['png'],              // 支持的输入文件格式
    format: 'png音频文件'          // 输入格式描述
  },
  output: {
    normExt: ['wav', 'json'],      // 输出的文件格式
    format: 'WAV音频文件（嵌入图片数据） + 转换结果JSON'  // 输出格式描述
  },
  rely: {
    'jimp': '0.22.12'              // 依赖的npm包及版本（Jimp用于图像处理）
  }
};