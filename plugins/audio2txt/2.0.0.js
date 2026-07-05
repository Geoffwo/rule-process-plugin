const { pipeline } = require('@huggingface/transformers');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { WaveFile }  = require('wavefile');

// =======================
// 配置区
// =======================
const configUtils = {
  mirrorUrl: 'https://hf-cdn.sufy.com/', // 快但不稳定
  // mirrorUrl: 'https://hf-mirror.com/', // 慢但稳定
  modelPath: path.join(process.cwd(), './examples/model'), // 本地模型根目录
  repoName: 'onnx-community/whisper-base',//仓库地址
  task:'automatic-speech-recognition',//模型类型
  dtype:'uint8',//默认model是 int8 全精度模型
  lfsFiles: [
    'onnx/decoder_model_uint8.onnx', // 要下载的 LFS 文件模式（支持通配符）
    'onnx/decoder_model_merged_uint8.onnx', // 要下载的 LFS 文件模式（支持通配符）
    'onnx/encoder_model_uint8.onnx', // 要下载的 LFS 文件模式（支持通配符）
  ],
  getFullModelPath() {
    return path.join(this.modelPath, this.repoName.split('/').pop());
  },
  getGitCloneUrl() {
    return this.mirrorUrl + this.repoName;
  },
};

// =======================
// 工具函数：自动查找 git-bash.exe
// =======================
function getGitBashPath() {
  try {
    let gitBashPath = execSync('where git-bash.exe', { encoding: 'utf8' }).trim();
    if (gitBashPath.includes('\n')) {
      gitBashPath = gitBashPath.split('\n')[0].trim();
    }
    return gitBashPath;
  } catch (error) {
    const defaultPaths = [
      'C:\\Program Files\\Git\\git-bash.exe',
      'C:\\Program Files (x86)\\Git\\git-bash.exe',
      'D:\\Program Files\\Git\\git-bash.exe',
    ];
    for (const p of defaultPaths) {
      if (fs.existsSync(p)) {
        console.log(`从默认路径找到 Git Bash：${p}`);
        return p;
      }
    }
    throw new Error(`
      环境变量未找到 Git Bash！请先安装 Git（官网：https://git-scm.com/）
      安装时务必勾选：
      - "Add Git to PATH"
      - 或 "Use Git from Windows Command Prompt"
    `);
  }
}

// =======================
// 执行命令：确保在 Git Bash 环境中设置环境变量
// =======================
function runCommand(bashCmd, cwd = process.cwd()) {
  const gitBashPath = getGitBashPath();
  const bashCwd = cwd.replace(/\\/g, '/'); // Windows → Unix 路径

  // 关键：在 Git Bash 中 export 环境变量
  const fullCmd = `"${gitBashPath}" -c "export GIT_CLONE_PROTECTION_ACTIVE=false && export GIT_LFS_SKIP_SMUDGE=1 && cd '${bashCwd}' && ${bashCmd}"`;

  console.log(`执行指令：${bashCmd}`);
  try {
    execSync(fullCmd, { stdio: 'inherit', encoding: 'utf8' });
  } catch (error) {
    throw new Error(`指令执行失败：${bashCmd}\n原因：${error.message.slice(0, 200)}`);
  }
}

// =======================
// 自动克隆模型并下载指定文件
// =======================
async function cloneAndPrepareModel() {
  try {
    console.log('开始准备模型...');

    const fullModelPath = configUtils.getFullModelPath();
    if (fs.existsSync(fullModelPath)) {
      console.log('模型目录已存在，跳过克隆\n');
    } else {
      console.log('正在克隆仓库（跳过大文件）...');
      const baseModelPath = configUtils.modelPath;
      const gitCloneUrl = configUtils.getGitCloneUrl();

      if (!fs.existsSync(baseModelPath)) {
        fs.mkdirSync(baseModelPath, { recursive: true });
      }

      // 环境变量已在 runCommand 中 export，无需重复写
      runCommand(`git clone "${gitCloneUrl}"`, baseModelPath);
    }

    console.log('正在拉取必要的模型文件...');
    const includeFiles = configUtils.lfsFiles
    includeFiles.forEach(includeFile => {
      runCommand(`git lfs pull --include="${includeFile}"`, configUtils.getFullModelPath());
    })

    return true;
  } catch (error) {
    console.error('模型准备失败:', error.message);
    return false;
  }
}

// =======================
// 执行模型
// =======================
async function runModel(audioBuffer,option={}) {
  try {
    console.log('\n开始运行模型');

    const fullModelPath = configUtils.getFullModelPath();
    console.log(`从本地加载模型: ${fullModelPath}`);

    const analyzer = await pipeline(
        configUtils.task,//'sentiment-analysis'
        fullModelPath,
        {
          local_files_only: true, // 只读本地文件
          dtype:configUtils.dtype
        }
    );

    return await analyzer(audioBuffer,option);
  } catch (error) {
    console.error('模型出错:', error.message);
    return false;
  }
}

// WAV Buffer 转 Whisper 标准 Float32 音频数据
function convertWavToWhisperAudio(buffer) {
  // 用 wavefile 解析 WAV 二进制数据，得到音频对象
  const wav = new WaveFile(buffer);

  // 统一采样率为 16000 Hz
  // Whisper 模型训练时只用 16kHz 音频，非这个采样率会识别出错
  wav.toSampleRate(16000);

  // 取出所有声道的原始采样数据
  // 立体声会返回 [左声道数组, 右声道数组]
  const samples = wav.getSamples();

  // 判断：如果是多声道（立体声/环绕声）
  if (Array.isArray(samples) && samples.length > 1) {
    console.log('检测到音频为多声道');
    console.log('正在进行音频粗略单声道处理...');

    const mono = samples[0];          // 只保留【第一个声道】（左声道）
    wav.setSamples(mono);              // 把音频数据替换成单声道数据
    wav.fmt.numChannels = 1;           // 修改音频头：声道数改为 1（单声道）
    // 修正音频数据块大小，保证 WAV 格式合法
    wav.data.chunkSize = mono.length * (wav.fmt.bitsPerSample / 8);

    console.log('建议使用ffmpeg2process精细处理音频文件后，再运行当前插件');
  }

  // 转为模型接收的 Float32 数组，并做**音量归一化**
  // 原始音频数值范围 -32768 ~ 32767，除以 32768 归一化到 [-1, 1]
  return new Float32Array(wav.getSamples()).map(v => v / 32768);
}

// 主处理函数
async function writingRules(inputArray, outputNodeTemplate) {
  // 筛选WAV文件
  // ========== 改动3：筛选 .wav 音频文件，不再筛选txt ==========
  const wavFiles = inputArray.filter(info =>
      info.path.endsWith('.wav')
  );

  if (wavFiles.length === 0) {
    return [{...outputNodeTemplate, content: '错误: 未找到wav音频文件'}];
  }

  const result = []

  //下载模型
  const modelReady = await cloneAndPrepareModel();
  if (modelReady) {
    for (const file of wavFiles) {
      const pcmFloat = convertWavToWhisperAudio(file.content) //WAV Buffer 转 Whisper 标准 Float32 音频数据
      // const asrText = await runModel(pcmFloat)//默认英文，无论什么语言自动翻译为英文
      const asrText = await runModel(pcmFloat,{
        language: 'zh', // 指定音频语言为 中文
        task: 'transcribe',// 任务类型：纯语音转文字（不翻译）
        chunk_length_s: 30 // 分块长度：按 30 秒为一段拆分长音频识别，避免内存溢出/卡顿
      });

      result.push({...outputNodeTemplate,fileName: `${file.name}-txt`,normExt: 'txt',content: asrText.text || '识别失败'})
    }

  } else {
    console.log('模型准备失败');
  }

  return result;
}

// module.exports = writingRules;

// 修正后的导出配置
// 修正后的导出配置
module.exports = {
  name: 'audio2txt',
  version: '2.0.0',
  process: writingRules,
  description: '基于Hugging Face 的语音转文本模型，支持将16kHz单声道WAV音频文件转换为文本，全程离线运行',
  notes: {
    node: '18.20.4',
    model: 'onnx-community/whisper-base (uint8 量化版)',
    require: '需提前安装 Git、Git LFS 及 wavefile 依赖'
  },
  error: {
    'model-download':{
      description:'模型下载失败可能是由于网络问题或镜像地址不可用',
      process:'解决方案：尝试切换configUtils中的mirrorUrl，或手动从Hugging Face Hub下载模型并放置到指定目录',
      other:'确保Git和Git LFS已正确安装并配置'
    }
  },
  input: {
    normExt: 'wav 文件',
    description: '待识别的 WAV 音频文件，支持单声道/立体声、不同采样率，内部自动转为模型标准格式'
  },
  output: {
    normExt: 'txt 文件',
    format: '输出对应音频识别后的中文文本内容，生成同名 TXT 文档'
  },
  rely: {
    '@huggingface/transformers': '3.7.3',
    'wavefile': '11.0.0'
  }
};
