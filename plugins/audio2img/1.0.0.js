const Jimp = require('jimp');

/**
 * 音频转图片核心函数：从WAV音频中提取图像数据，用Jimp重建PNG
 * 不依赖canvas，纯JS实现，无需额外系统依赖
 * @param {Buffer} audioBuffer - 输入WAV音频的内存Buffer
 * @returns {Promise<Buffer>} 生成的PNG图片Buffer
 */
async function audioToImage(audioBuffer) {
  // 验证WAV数据有效性（至少包含44字节头+8字节尺寸信息）
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length < 52) {
    throw new Error('无效的WAV数据：长度不足（至少需52字节）');
  }

  // 跳过WAV标准头（44字节），提取图像尺寸信息
  const wavHeaderSize = 44;
  const width = audioBuffer.readUInt32LE(wavHeaderSize);       // 宽度（4字节，小端模式）
  const height = audioBuffer.readUInt32LE(wavHeaderSize + 4); // 高度（4字节，小端模式）

  // 验证图像尺寸合理性
  if (width <= 0 || height <= 0 || width > 10000 || height > 10000) {
    throw new Error(`无效尺寸：宽=${width}, 高=${height}（范围需1~10000）`);
  }

  // 提取像素数据（跳过WAV头+尺寸信息，共44+8=52字节）
  const pixelDataStart = wavHeaderSize + 8;
  const pixelData = audioBuffer.slice(pixelDataStart);

  // 验证像素数据长度（RGBA格式：每个像素4字节，总长度需=宽×高×4）
  const expectedSize = width * height * 4;
  if (pixelData.length < expectedSize) {
    throw new Error(`像素数据不完整：需${expectedSize}字节，实际${pixelData.length}字节`);
  }

  // 用Jimp创建空白图像（RGBA格式，8位深度）
  const image = new Jimp(width, height, 0x00000000, (err, image) => {
    if (err) throw new Error(`创建图像失败：${err.message}`);
  });

  // 将提取的像素数据写入Jimp图像（直接操作底层像素数组）
  // Jimp的bitmap.data是Uint8Array，与RGBA像素格式完全兼容
  for (let i = 0; i < expectedSize; i++) {
    image.bitmap.data[i] = pixelData[i];
  }

  // 将Jimp图像转为PNG格式的Buffer
  return await image.getBufferAsync(Jimp.MIME_PNG);
}

/**
 * 主处理函数：批量处理WAV文件，生成PNG和结果汇总
 * @param {Array} inputArray - 输入文件信息数组
 * @param {Object} outputNodeTemplate - 输出模板配置
 * @returns {Promise<Array>} 处理结果数组
 */
async function writingRules(inputArray, outputNodeTemplate) {
  // 过滤出WAV文件
  const wavFiles = inputArray.filter(info => info.path.endsWith('.wav'));

  // 无WAV文件时返回错误
  if (wavFiles.length === 0) {
    return [{...outputNodeTemplate,fileName: 'result',content: '错误：未找到.wav文件，请检查输入'}];
  }

  const result = [];
  const contents = [];

  // 批量处理每个WAV文件
  for (const file of wavFiles) {
    try {
      // 验证输入内容是否为Buffer
      if (!Buffer.isBuffer(file.content)) {
        return [{...outputNodeTemplate,fileName: 'result',content: '文件内容不是有效的Buffer'}];
      }

      // 调用核心转换函数
      const pngBuffer = await audioToImage(file.content);

      // 添加PNG结果到输出
      result.push({
        ...outputNodeTemplate,
        fileName: file.name,
        normExt: 'png', // 输出格式为PNG
        content: pngBuffer
      });

      contents.push({ fileName: file.name, message: '转换成功' });

    } catch (err) {
      contents.push({ fileName: file.name, message: `转换失败：${err.message}` });
    }
  }

  // 添加结果汇总JSON
  result.push({
    ...outputNodeTemplate,
    fileName: 'result',
    content: JSON.stringify(contents, null, 2)
  });

  return result;
}

// 模块导出配置（仅依赖jimp）
module.exports = {
  name: 'audio2img',
  version: '1.0.0',
  process: writingRules,
  description: '将嵌入图像数据的WAV音频还原为PNG图片',
  notes: {
    node: '18.20.4'
  },
  input: {
    normExt: ['wav'],
    format: '嵌入图像数据的WAV音频文件'
  },
  output: {
    normExt: ['png', 'json'],
    format: 'PNG图片 + 转换结果JSON'
  },
  rely: {
    'jimp': '0.22.12' // 仅需jimp一个依赖，无需canvas
  }
};
