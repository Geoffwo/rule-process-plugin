const fs = require('fs');
const path = require('path');
const vosk = require('vosk');
const axios = require('axios');
const AdmZip = require('adm-zip');
const MODEL_PATH = path.join(process.cwd(), './examples/model/vosk'); // Vosk模型下载路径
const MODEL_URL = 'https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip';

// 自动下载并解压模型
async function downloadModel() {
  console.log('开始下载Vosk模型...');
  console.log('下载地址: https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip');
  console.log(`当前模型下载速度缓慢（预计2-4小时），建议科学上网下载`);
  console.log(`下载的Vosk模型解压后，需将解压后的内容（am、conf、graph、ivector、README等）放到${MODEL_PATH}目录下`);
  // 【新增1：仅3个变量，用于统计和控制日志频率】
  let downloadedBytes = 0; // 已下载字节数
  let lastPrintTime = 0;   // 上次打印日志时间（防刷屏）
  const formatSize = (b) => (b / 1024 / 1024).toFixed(2) + 'MB'; // 字节转MB

  try {
    // 确保模型目录存在，如果不存在则创建
    if (!fs.existsSync(MODEL_PATH)) {
      fs.mkdirSync(MODEL_PATH, { recursive: true });
    }

    // 设置ZIP文件的保存路径
    const zipPath = path.join(MODEL_PATH, 'vosk_model.zip');

    // 使用axios发送GET请求下载模型文件
    // responseType设置为'stream'以便处理大文件
    const response = await axios({
      method: 'GET',
      url: MODEL_URL, // 模型下载地址
      responseType: 'stream', // 以流的形式接收响应数据
      timeout: 0, // 禁用客户端超时
      headers: {
        'Connection': 'keep-alive',
        'Keep-Alive': 'timeout=600' // 保持连接活跃
      }
    });

    // 【新增2：监听数据流，统计已下载大小并打印日志】
    response.data.on('data', (chunk) => {
      downloadedBytes += chunk.length; // 累加当前数据块大小
      const now = Date.now();
      // 每1000ms打印一次（避免刷屏），或首次下载时打印
      if (now - lastPrintTime > 1000 || downloadedBytes === chunk.length) {
        console.log(`${new Date().toLocaleString()} 已下载：${formatSize(downloadedBytes)}`);
        lastPrintTime = now;
      }
    });

    // 创建文件写入流，将下载的数据保存到本地ZIP文件
    const writer = fs.createWriteStream(zipPath);
    response.data.pipe(writer);// 将响应数据管道传输到文件写入流

    // 等待下载完成（等待写入流完成）
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve); // 写入完成时解析Promise
      writer.on('error', reject);   // 写入出错时拒绝Promise
    });

    console.log('下载完成，开始解压...');

    // 使用AdmZip库读取并解压ZIP文件
    const zip = new AdmZip(zipPath);
    // 将ZIP文件中的所有内容解压到模型目录
    // 第二个参数true表示覆盖已存在的文件
    zip.extractAllTo(MODEL_PATH, true);

    // 3. 同步读取MODEL_PATH下的根目录内容(目的：根目录上移一级文件)
    const rootItems = fs.readdirSync(MODEL_PATH, { withFileTypes: true });

    // 过滤出根目录下的文件夹（只处理单个根文件夹的情况）
    const rootFolders = rootItems.filter(item => item.isDirectory());

    for (let rootFolder of rootFolders) {
      const rootContentPath = path.join(MODEL_PATH, rootFolder.name);

      // 4. 同步获取根文件夹内的所有内容
      const contentItems = fs.readdirSync(rootContentPath);

      // 5. 同步移动内容到MODEL_PATH（上移一级）
      for (const item of contentItems) {
        const from = path.join(rootContentPath, item);
        const to = path.join(MODEL_PATH, item);

        // 若目标已存在，先同步删除
        if (fs.existsSync(to)) {
          fs.rmSync(to, {recursive: true, force: true});
        }

        fs.renameSync(from, to); // 同步移动
      }

      // 6. 同步删除空的原根文件夹
      fs.rmdirSync(rootContentPath);
    }

      // 删除下载的临时ZIP文件以节省空间
      // fs.unlinkSync(zipPath);

      console.log('模型安装完成');
      return true;// 返回成功状态
  } catch (error) {
    console.error('模型下载失败:', error.message);
    return false;// 返回失败状态
  }
}

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
    //通过有没有conf目录判断是否存在vosk模型
    const confDir = `${MODEL_PATH}/conf`
    if (!fs.existsSync(confDir)) {
      console.log('未找到Vosk模型，尝试自动下载...');
      const success = await downloadModel();
      if (!success) {
        console.error(`Vosk模型不存在，请下载模型到 ${MODEL_PATH}`);
        console.log('下载地址: https://alphacephei.com/vosk/models');
        return null;
      }
    }

    try {
      vosk.setLogLevel(0); // 关闭日志输出
      return new vosk.Model(MODEL_PATH);
    } catch (error) {
      console.log('Vosk模型加载失败:', error);
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
            content: `WAV文件格式不正确，需要16kHz采样率、单声道，建议使用ffmpeg2process插件处理`
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

    return [{...outputNodeTemplate,content:JSON.stringify(contents,null,2)}];
  }

// module.exports = writingRules;

// 修正后的导出配置
  module.exports = {
    name: 'audio2txt',
    version: '1.0.0',
    process: writingRules,
    description: '基于Vosk的离线语音识别插件 - 支持将16kHz单声道WAV音频文件转换为文本，无需网络连接，适用于语音转文字场景',
    notes:{
      node:'14.18.0 -> 18.20.4',
      python:'3.9.13',
      'vosk-model':'vosk-model-small-cn-0.22' // 推荐使用的模型 建议手动下载
    },
    error:{
      'vosk':{
        description:'当node版本在16+时，下载vosk异常，因为vosk下载依赖的ffi，ffi不兼容高版本node',
        process:'解决方案：降低node版本16-下载，然后切换回高版本运行（已测试高版本无法下载但可运行）',
        other:'项目打包需要保留当前vosk版本一同打包'
      }
    },
    input: {
      normExt: 'wav文件'
    },
    output: {
      normExt: 'json文件',
      format: "[{fileName:'原音频文件名',content:'识别出的文本内容'}]"
    },
    rely: {
      'vosk': '0.3.39', // 兼容Node 14的稳定版本
      "adm-zip": "0.5.16",
      "axios": "0.27.2",//兼容 1.12.2
    }
  };