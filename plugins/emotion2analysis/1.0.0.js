const { pipeline } = require('@huggingface/transformers');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// =======================
// 配置区
// =======================
const configUtils = {
  mirrorUrl: 'https://hf-cdn.sufy.com/', // 快但不稳定
  // mirrorUrl: 'https://hf-mirror.com/', // 慢但稳定
  modelPath: path.join(process.cwd(), './examples/model'), // 本地模型根目录
  repoName: 'Xenova/distilbert-base-uncased-finetuned-sst-2-english',//仓库地址
  task:'sentiment-analysis',//模型类型
  dtype:'fp32',//默认model是fp32 全精度模型
  lfsFiles: [
    'onnx/model.onnx', // 要下载的 LFS 文件模式（支持通配符）
  ],
  getFullModelPath() {
    return path.join(this.modelPath, this.repoName.split('/').pop());
  },
  getIncludeFiles() {
    return this.lfsFiles.map(item => `--include="${item}"`).join(' ');
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
    const includeFiles = configUtils.getIncludeFiles();
    runCommand(`git lfs pull ${includeFiles}`, configUtils.getFullModelPath());

    return true;
  } catch (error) {
    console.error('模型准备失败:', error.message);
    return false;
  }
}

// =======================
// 执行情感分析
// =======================
async function analyzeSentiment(text) {
  try {
    console.log('\n开始情感分析测试');

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

    return await analyzer(text);
  } catch (error) {
    console.error('情感分析出错:', error.message);
    return false;
  }
}

// 主处理函数
async function writingRules(inputArray, outputNodeTemplate) {
  // 筛选WAV文件
  const txtFiles = inputArray.filter(info =>
      info.path.endsWith('.txt')
  );

  if (txtFiles.length === 0) {
    return [{...outputNodeTemplate, content: '错误: 未找到txt文本文件'}];
  }

  const result = []

  //下载模型
  const modelReady = await cloneAndPrepareModel();
  if (modelReady) {
    for (const file of txtFiles) {
      const contents = []
      const testTexts = file.content.split(/\r\n/);
      // const testTexts = [
      //   "I love using Hugging Face Transformers! It's amazing.",
      //   "I hate waiting for models! It's so frustrating.",
      //   "The relationship had been important to me and its loss left me feeling sad and empty."
      // ];

      for (const text of testTexts) {
        const result = await analyzeSentiment(text);
        const dict = {
          POSITIVE:'积极信息',
          NEGATIVE:'消极信息',
        }
        contents.push({
          "text":text,
          "result":`结果: ${dict[result[0].label]} (可信度: ${(result[0].score * 100).toFixed(1)}%)`
        })
      }

      result.push({...outputNodeTemplate,fileName: file.name,content:JSON.stringify(contents,null,2)})
    }

  } else {
    console.log('模型准备失败');
  }

  return result;
}

// module.exports = writingRules;

// 修正后的导出配置
module.exports = {
  name: 'sentiment-analysis',
  version: '1.0.0',
  process: writingRules,
  description: '基于Hugging Face Transformers的情感分析插件 - 支持分析TXT英文文本文件的情感倾向（积极/消极），使用本地模型运行，自动下载所需模型文件',
  notes:{
    node:'18.20.4',
    model: 'Xenova/distilbert-base-uncased-finetuned-sst-2-english', // 当前使用的情感分析模型
  },
  error:{
    'model-download':{
      description:'模型下载失败可能是由于网络问题或镜像地址不可用',
      process:'解决方案：尝试切换configUtils中的mirrorUrl，或手动从Hugging Face Hub下载模型并放置到指定目录',
      other:'确保Git和Git LFS已正确安装并配置'
    }
  },
  input: {
    normExt: 'txt文件',
    description: '包含待分析英文文本的TXT文件，每行视为一个独立的分析单元'
  },
  output: {
    normExt: 'data文件',
    format: "[{text:'行文本内容',result:'分析结果'}]"
  },
  rely: {
    '@huggingface/transformers': '3.7.3',
  }
};
