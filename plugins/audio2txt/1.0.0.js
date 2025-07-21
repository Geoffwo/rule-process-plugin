const fs = require('fs');
const path = require('path');
const vosk = require('vosk');
const MODEL_PATH = path.join(process.cwd(), './examples/model'); // Vosk模型路径

// 校验WAV文件格式
function validateWavFormat(fileBuffer) {
  // 简单的WAV文件头校验 (RIFF标识 + WAVE格式)
  if (fileBuffer.length < 12) {
    return false;
  }

  const riff = fileBuffer.toString('ascii', 0, 4);
  const wave = fileBuffer.toString('ascii', 8, 12);

  if (riff !== 'RIFF' || wave !== 'WAVE') {
    return false;
  }

  // 校验采样率 (第24-27字节为采样率)
  const sampleRate = fileBuffer.readUInt32LE(24);
  if (sampleRate !== 16000) {
    return false;
  }

  // 校验声道数 (第22-23字节为声道数)
  const channels = fileBuffer.readUInt16LE(22);
  if (channels !== 1) {
    return false;
  }

  return true;
}

// 初始化Vosk模型
async function initVoskModel() {
  if (!fs.existsSync(MODEL_PATH)) {
    console.error(`Vosk模型不存在，请下载模型到 ${MODEL_PATH}`);
    console.log('下载地址: https://alphacephei.com/vosk/models');
    return null;
  }

  try {
    vosk.setLogLevel(0); // 关闭日志输出
    return new vosk.Model(MODEL_PATH);
  } catch (error) {
    console.error('Vosk模型加载失败:', error);
    return null;
  }
}

// 识别音频Buffer中的语音内容（修复JSON解析问题）
async function recognizeAudio(model, audioBuffer) {
  return new Promise((resolve, reject) => {
    if (!model) return reject(new Error('Vosk模型未初始化'));

    const recognizer = new vosk.Recognizer({ model, sampleRate: 16000 });
    recognizer.setWords(true); // 启用单词级输出

    try {
      // 识别音频数据（直接传入整个buffer）
      recognizer.acceptWaveform(audioBuffer);

      // 获取最终识别结果（不需要JSON.parse）
      const result = recognizer.finalResult();

      // 返回识别文本
      resolve(result.text || "");
    } catch (error) {
      reject(new Error(`语音识别失败: ${error.message}`));
    } finally {
      recognizer.free(); // 确保释放资源
    }
  });
}

// 主处理函数
async function writingRules(inputArray, outputNodeTemplate) {
  // 筛选WAV文件
  const audioFiles = inputArray.filter(info =>
      info.path.endsWith('.wav')
  );

  if (audioFiles.length === 0) {
    return [{...outputNodeTemplate, content: '错误: 未找到WAV音频文件'}];
  }

  // 初始化Vosk模型
  const model = await initVoskModel();
  if (!model) {
    return [{
      ...outputNodeTemplate,
      content:
          `错误: Vosk语音识别模型初始化失败\n 
          1.Vosk模型不存在，请下载模型到 ${MODEL_PATH}\n 
          2.下载地址: https://alphacephei.com/vosk/models\n 
          3.按需选择Vosk模型（常用vosk-model-small-cn-0.22）\n 
          4.下载的Vosk模型解压后，需将解压后的内容（am、conf、graph、ivector、README等）放到${MODEL_PATH}目录下`
    }];
  }

  // 处理每个音频文件
  const contents = [];
  for (const file of audioFiles) {
    try {
      // 1. 校验WAV格式
      if (!validateWavFormat(file.content)) {
        contents.push({
          fileName: file.name,
          content: `WAV文件格式不正确，需要16kHz采样率、单声道，建议使用audio2wav插件处理`
        });
        continue;
      }

      // 2. 语音识别
      const transcription = await recognizeAudio(model, file.content);

      // 3. 生成结果
      contents.push({
        fileName: file.name,
        content: transcription
      });
    } catch (error) {
      contents.push({
        fileName: file.name,
        content: `处理失败: ${error.message}`
      });
    }
  }

  return [{...outputNodeTemplate,content:JSON.stringify(contents)}];
}

// module.exports = writingRules;

// 修正后的导出配置
module.exports = {
  name: 'audio2txt',
  version: '1.0.0',
  process: writingRules,
  description: '基于Vosk的离线语音识别插件 - 支持将16kHz单声道WAV音频文件转换为文本，无需网络连接，适用于语音转文字场景',
  notes:{
    node:'14.18.0',
    python:'3.9.13',
    'vosk-model':'vosk-model-small-cn-0.22' // 推荐使用的模型 需要手动下载
  },
  input: {
    normExt: 'wav文件'
  },
  output: {
    normExt: 'json文件',
    format: "[{fileName:'原音频文件名',content:'识别出的文本内容'}]"
  },
  rely: {
    'vosk': '0.3.39' // 兼容Node 14的稳定版本
  }
};