const Jimp = require('jimp');

// 图片转声音（图像数据嵌入音频）：仅替换图片加载逻辑，其余不变
async function imageToAudio(imagePath) {
  // 步骤1：用jimp加载图片（替代canvas的loadImage）
  const image = await Jimp.read(imagePath); // jimp自动处理PNG格式
  const width = image.bitmap.width;        // 获取图片宽度
  const height = image.bitmap.height;      // 获取图片高度
  const pixelData = image.bitmap.data;     // 提取RGBA像素数据（Uint8Array，与canvas格式一致）

  // 步骤2：保留原逻辑：添加尺寸头部（4字节宽度+4字节高度）
  const header = Buffer.alloc(8);
  header.writeUInt32LE(width, 0);    // 4字节存储宽度
  header.writeUInt32LE(height, 4);   // 4字节存储高度

  // 步骤3：合并头部和像素数据（与原逻辑一致）
  const combinedData = Buffer.concat([
    header,
    Buffer.from(pixelData) // pixelData已是Uint8Array，直接转Buffer
  ]);

  // 步骤4：保留原逻辑：生成标准WAV文件头
  const sampleRate = 44100; // 44.1kHz采样率
  const numChannels = 1;   // 单声道
  const bitDepth = 8;      // 8位采样深度
  const wavHeaderSize = 44;
  const dataSize = combinedData.length;
  const fileSize = wavHeaderSize + dataSize;

  const wavHeader = Buffer.alloc(wavHeaderSize);
  // RIFF头
  wavHeader.write('RIFF', 0);
  wavHeader.writeUInt32LE(fileSize - 8, 4);
  wavHeader.write('WAVE', 8);
  // fmt子块
  wavHeader.write('fmt ', 12);
  wavHeader.writeUInt32LE(16, 16);
  wavHeader.writeUInt16LE(1, 20);  // PCM格式
  wavHeader.writeUInt16LE(numChannels, 22);
  wavHeader.writeUInt32LE(sampleRate, 24);
  wavHeader.writeUInt32LE(sampleRate * numChannels * bitDepth / 8, 28); // 字节率
  wavHeader.writeUInt16LE(numChannels * bitDepth / 8, 32); // 块对齐
  wavHeader.writeUInt16LE(bitDepth, 34); // 位深度
  // data子块
  wavHeader.write('data', 36);
  wavHeader.writeUInt32LE(dataSize, 40);

  // 步骤5：生成完整WAV Buffer（与原逻辑一致）
  return Buffer.concat([wavHeader, combinedData]);
}

// 主处理函数：完全保留原逻辑，无任何修改
async function writingRules(inputArray, outputNodeTemplate) {
  // 过滤PNG图片
  const pngFiles = inputArray.filter(info => info.path.endsWith('.png'));

  if (pngFiles.length === 0) {
    return [{
      ...outputNodeTemplate,
      fileName: 'result',
      content: '错误: 未找到有效的图片。请提供.png文件。'
    }];
  }

  const result = [];
  const contents = [];
  for (const file of pngFiles) {
    try {
      const audioBuffer = await imageToAudio(file.path);
      // 生成WAV输出（文件名保留原图片名，后缀改为wav）
      result.push({
        ...outputNodeTemplate,
        fileName: file.name,
        normExt: 'wav',
        content: audioBuffer
      });
      contents.push({ fileName: file.name, massage: `生成成功` });
    } catch (err) {
      contents.push({ fileName: file.name, massage: `生成失败:${err.message}` });
    }
  }

  // 生成结果汇总JSON
  result.push({
    ...outputNodeTemplate,
    fileName: 'result',
    content: JSON.stringify(contents, null, 2) // 格式化JSON，可读性更强
  });

  return result;
}

// 模块导出：修正依赖声明（仅需jimp）
module.exports = {
  name: 'img2audio',
  version: '1.0.0',
  process: writingRules,
  description: '将PNG图片转换为WAV音频文件',
  notes: {
    node: '18.20.4' // 兼容主流Node版本
  },
  input: {
    normExt: ['png'],
    format: 'png音频文件'
  },
  output: {
    normExt: ['wav', 'json'],
    format: 'WAV音频文件（嵌入图片数据） + 转换结果JSON'
  },
  rely: {
    'jimp': '0.22.12' // 仅需这一个依赖，纯JS无系统依赖
  }
};