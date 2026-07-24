const fs = require('fs');// 引入Node.js内置文件系统模块，用于文件读写、目录判断与创建
const path = require('path');// 引入路径处理模块，统一拼接、解析路径，兼容Windows与Linux路径格
const { execSync } = require('child_process');// 引入子进程模块，用于调用Git Bash执行终端命令
const ort = require('onnxruntime-node');// 引入ONNX运行时，负责加载并推理ONNX格式模型
const sharp = require('sharp');// 引入图像处理库，实现图片缩放、格式转换、原始像素解析

// =======================
// 全局配置区：模型地址、推理参数、提示词统一管理
// =======================
const configUtils = {
  // HuggingFace镜像地址，加速国内模型拉取
  mirrorUrl: 'https://hf-cdn.sufy.com/',
  // mirrorUrl: 'https://hf-mirror.com/',
  // 模型本地存储根目录
  modelPath: path.join(process.cwd(), './examples/model'),
  // Hugging Face模型仓库名
  repoName: 'onnx-community/stable-diffusion-v1-5-ONNX',
  // 需要通过Git LFS单独拉取的大体积模型文件列表
  lfsFiles: [
    'text_encoder/model.onnx',  // CLIP文本编码器模型
    'unet/model.onnx',          // SD核心UNet扩散模型
    'unet/weights.pb',          // UNet附加权重文件
    'vae_decoder/model.onnx',   // VAE解码器，将隐空间数据还原为图像
  ],
  /**
   * 拼接模型完整存放路径
   * @returns {string} 模型绝对路径
   */
  getFullModelPath() {
    return path.join(this.modelPath, this.repoName.split('/').pop());
  },
  /**
   * 拼接Git克隆完整地址
   * @returns {string} 模型仓库Git地址
   */
  getGitCloneUrl() {
    return this.mirrorUrl + this.repoName;
  },
  // 推理、提示词相关配置项(默认配置)
  config:{
    prompt: "cute guinea pig, soft fur, natural light, mild color",// 正向提示词：指定生成复古8位像素游戏画风
    negativePrompt: "oversaturated, gray, blurry, cartoon",// 反向提示词：屏蔽写实、模糊、畸形、3D等无效画面
    imgSize: 512,                // 生成图像分辨率 512*512（SD1.5标准尺寸）
    inferenceSteps: 20,          // DDIM采样迭代步数，步数越高画质越好、速度越慢
    guidanceScale: 7.5,         // CFG引导强度，控制画面贴合提示词的程度
    denoisingStrength: 0.7      // 图生图降噪强度（当前文生图暂未启用）
  }
};

// =======================
// 工具函数：查找本地Git Bash可执行文件路径（Windows专用）
// =======================
function getGitBashPath() {
  try {
    // 从系统环境变量检索git-bash位置
    let gitBashPath = execSync('where git-bash.exe', { encoding: 'utf8' }).trim();
    // 存在多个路径时，取第一条
    if (gitBashPath.includes('\n')) {
      gitBashPath = gitBashPath.split('\n')[0].trim();
    }
    return gitBashPath;
  } catch (error) {
    // 环境变量检索失败，遍历Git默认安装目录
    const defaultPaths = [
      'C:\\Program Files\\Git\\git-bash.exe',
      'C:\\Program Files (x86)\\Git\\git-bash.exe',
      'D:\\Program Files\\Git\\git-bash.exe',
    ];
    for (const p of defaultPaths) {
      // 校验文件是否真实存在
      if (fs.existsSync(p)) {
        console.log(`从默认路径找到 Git Bash：${p}`);
        return p;
      }
    }
    // 未找到Git Bash，抛出异常并给出安装提示
    throw new Error(`
      环境变量未找到 Git Bash！请先安装 Git（官网：https://git-scm.com/）
      安装时务必勾选：
      - "Add Git to PATH"
      - 或 "Use Git from Windows Command Prompt"
    `);
  }
}

// =======================
// 工具函数：调用Git Bash执行Shell命令
// @param {string} bashCmd 待执行的bash命令
// @param {string} cwd 命令执行的工作目录，默认为当前目录
// =======================
function runCommand(bashCmd, cwd = process.cwd()) {
  // 获取Git Bash程序路径
  const gitBashPath = getGitBashPath();
  // Windows反斜杠转为Linux正斜杠，适配bash路径规则
  const bashCwd = cwd.replace(/\\/g, '/');

  // 拼接完整执行指令：关闭Git克隆保护、跳过LFS自动下载、切换工作目录、执行目标命令
  const fullCmd = `"${gitBashPath}" -c "export GIT_CLONE_PROTECTION_ACTIVE=false && export GIT_LFS_SKIP_SMUDGE=1 && cd '${bashCwd}' && ${bashCmd}"`;

  console.log(`执行指令：${bashCmd}`);
  try {
    // 同步执行命令，控制台输出命令执行日志
    execSync(fullCmd, { stdio: 'inherit', encoding: 'utf8' });
  } catch (error) {
    // 命令执行异常，封装错误信息抛出
    throw new Error(`指令执行失败：${bashCmd}\n原因：${error.message.slice(0, 200)}`);
  }
}

// =======================
// 模型自动准备函数：克隆仓库 + Git LFS拉取模型大文件
// @returns {Promise<boolean>} 模型准备结果，true=成功 false=失败
// =======================
async function cloneAndPrepareModel() {
  try {
    console.log('开始准备模型...');

    // 获取模型最终存储目录
    const fullModelPath = configUtils.getFullModelPath();
    // 目录已存在，跳过克隆步骤
    if (fs.existsSync(fullModelPath)) {
      console.log('模型目录已存在，跳过克隆\n');
    } else {
      console.log('正在克隆仓库（跳过大文件）...');
      const baseModelPath = configUtils.modelPath;
      const gitCloneUrl = configUtils.getGitCloneUrl();

      // 上级目录不存在则递归创建
      if (!fs.existsSync(baseModelPath)) {
        fs.mkdirSync(baseModelPath, { recursive: true });
      }

      // 执行git clone，仅拉取仓库目录结构，不拉取LFS大文件
      runCommand(`git clone "${gitCloneUrl}"`, baseModelPath);
    }

    console.log('正在拉取必要的模型文件...');
    const includeFiles = configUtils.lfsFiles
    // 遍历需要的模型文件，逐个通过Git LFS下载
    includeFiles.forEach(includeFile => {
      runCommand(`git lfs pull --include="${includeFile}"`, configUtils.getFullModelPath());
    })

    return true;
  } catch (error) {
    console.error('模型准备失败:', error.message);
    return false;
  }
}

// ================================================================
// 零依赖 CLIP BPE 分词器
// 纯JS实现CLIP分词逻辑，读取vocab.json与merges.txt，不依赖第三方分词库
// ================================================================
class ClipBPETokenizer {
  /**
   * 构造函数：加载分词词典、合并规则、字节映射表
   * @param {string} vocabPath 词汇表文件路径
   * @param {string} mergesPath BPE合并规则文件路径
   */
  constructor(vocabPath, mergesPath) {
    // 1. 加载词汇表：token -> 数字ID映射
    this.encoder = JSON.parse(fs.readFileSync(vocabPath, 'utf-8'));
    // 构建反向映射：数字ID -> token
    this.decoder = {};
    for (const [token, id] of Object.entries(this.encoder)) {
      this.decoder[id] = token;
    }

    // 2. 初始化CLIP专用字节转Unicode字符映射
    this.byteEncoder = this._bytesToUnicode();
    this.byteDecoder = {};
    for (const [b, u] of Object.entries(this.byteEncoder)) {
      this.byteDecoder[u] = Number(b);
    }

    // 3. 加载BPE合并规则
    const mergesText = fs.readFileSync(mergesPath, 'utf-8');
    // 按行分割，跳过第一行版本注释
    const mergesLines = mergesText.trim().split('\n').slice(1);
    this.bpeRanks = {};
    // 解析合并规则，存入哈希表
    mergesLines.forEach((line, i) => {
      const [a, b] = line.split(/\s+/);
      this.bpeRanks[`${a},${b}`] = i;
    });

    // 分词结果缓存，重复文本直接读取缓存，提升效率
    this.cache = {};
  }

  /**
   * 生成CLIP标准 字节→Unicode 映射表
   * @returns {object} 字节码对应Unicode字符
   */
  _bytesToUnicode() {
    const bs = [];
    // 录入常规可打印ASCII字符
    for (let i = 33; i < 127; i++) bs.push(i);
    for (let i = 161; i < 173; i++) bs.push(i);
    for (let i = 174; i < 256; i++) bs.push(i);

    const cs = [...bs];
    let n = 0;
    // 补充剩余字节的映射关系
    for (let b = 0; b < 256; b++) {
      if (!bs.includes(b)) {
        bs.push(b);
        cs.push(256 + n);
        n++;
      }
    }
    const result = {};
    bs.forEach((b, i) => {
      result[b] = String.fromCharCode(cs[i]);
    });
    return result;
  }

  /**
   * 提取字符数组中所有相邻字符对
   * @param {string[]} word 字符数组
   * @returns {Set<string>} 字符对集合
   */
  _getPairs(word) {
    const pairs = new Set();
    let prev = word[0];
    for (let i = 1; i < word.length; i++) {
      pairs.add(`${prev},${word[i]}`);
      prev = word[i];
    }
    return pairs;
  }

  /**
   * BPE核心合并算法
   * @param {string} token 待拆分字符单元
   * @returns {string[]} 拆分后的token数组
   */
  _bpe(token) {
    // 命中缓存直接返回结果
    if (this.cache[token]) return this.cache[token];

    let word = token.split('');
    let pairs = this._getPairs(word);

    // 无相邻字符对，直接返回
    if (pairs.size === 0) {
      this.cache[token] = word;
      return word;
    }

    // 循环执行BPE合并，直至无可合并字符
    while (true) {
      let minRank = Infinity;
      let bestPair = null;
      // 查找优先级最高的可合并字符对
      for (const pair of pairs) {
        const rank = this.bpeRanks[pair];
        if (rank !== undefined && rank < minRank) {
          minRank = rank;
          bestPair = pair;
        }
      }

      // 无可合并字符，退出循环
      if (bestPair === null) break;

      const [first, second] = bestPair.split(',');
      const newWord = [];
      let i = 0;
      // 执行字符合并
      while (i < word.length) {
        const j = word.indexOf(first, i);
        if (j === -1) {
          newWord.push(...word.slice(i));
          break;
        }
        newWord.push(...word.slice(i, j));
        if (word[j + 1] === second) {
          newWord.push(first + second);
          i = j + 2;
        } else {
          newWord.push(word[j]);
          i = j + 1;
        }
      }
      word = newWord;
      // 合并为单个单元，结束流程
      if (word.length === 1) break;
      pairs = this._getPairs(word);
    }

    this.cache[token] = word;
    return word;
  }

  /**
   * 文本编码入口：普通文本转为token ID数组
   * @param {string} text 输入文本
   * @returns {number[]} token ID列表
   */
  encode(text) {
    // 文本标准化：转小写、去除多余空格
    const cleanText = text.toLowerCase().trim().replace(/\s+/g, ' ');
    const tokens = [];

    // 文本转二进制字节，再映射为CLIP规定的Unicode字符
    const bytes = Buffer.from(cleanText, 'utf-8');
    let mapped = '';
    for (const b of bytes) {
      mapped += this.byteEncoder[b];
    }

    // 执行BPE分词
    const bpeTokens = this._bpe(mapped);
    // 将分词结果转为对应数字ID
    for (const t of bpeTokens) {
      if (this.encoder[t] !== undefined) {
        tokens.push(this.encoder[t]);
      }
    }

    return tokens;
  }
}

// =======================
// 加载SD推理会话：所有模型实例 + 分词器实例
// @param {string} modelRoot 模型根目录
// @returns {Promise<object>} 模型与分词器集合
// =======================
async function loadSDSessions(modelRoot) {
  // 拼接所有模型、分词配置文件的完整路径
  const paths = {
    textEncoder: path.join(modelRoot, 'text_encoder/model.onnx'),//将提示词转为向量
    unet: path.join(modelRoot, 'unet/model.onnx'),//扩散模型核心，预测噪声
    vaeDecoder: path.join(modelRoot, 'vae_decoder/model.onnx'),//将隐空间数据解码为像素
    vocab: path.join(modelRoot, 'tokenizer/vocab.json'),
    merges: path.join(modelRoot, 'tokenizer/merges.txt')
  };

  // 并行加载三个ONNX模型，提升加载速度
  const [textEncoder, unet, vaeDecoder] = await Promise.all([
    ort.InferenceSession.create(paths.textEncoder),
    ort.InferenceSession.create(paths.unet),
    ort.InferenceSession.create(paths.vaeDecoder)
  ]);

  // 实例化本地CLIP分词器
  const tokenizer = new ClipBPETokenizer(paths.vocab, paths.merges);//把文本转为 token ID 序列

  console.log('[LOG] 所有模型和分词器加载完成');
  return { tokenizer, textEncoder, unet, vaeDecoder };
}

// =======================
// CLIP文本编码封装：对齐SD1.5规范，固定77长度、添加首尾特殊Token
// @param {ClipBPETokenizer} tokenizer 分词器实例
// @param {string} text 输入提示词
// @param {number} maxLength 固定长度77（SD标准）
// @returns {number[]} 补齐后的ID数组
// =======================
function encodePrompt(tokenizer, text, maxLength = 77) {
  const CLIP_SOT = 49406; // 文本起始Token ID
  const CLIP_EOT = 49407; // 文本结束Token ID
  const CLIP_PAD = 0;     // 空白填充Token ID

  const tokens = tokenizer.encode(text);
  // 截断内容，预留首尾两个特殊Token位置
  const truncated = tokens.slice(0, maxLength - 2);
  // 拼接起始、内容、结束Token
  const result = [CLIP_SOT, ...truncated, CLIP_EOT];
  // 长度不足77，使用填充Token补全
  while (result.length < maxLength) {
    result.push(CLIP_PAD);
  }
  return result.slice(0, maxLength);
}

// =======================
// 图片预处理：统一尺寸、转为原始像素数据（当前文生图未使用）
// @param {Buffer} imgBuffer 原始图片二进制流
// @returns {Promise<Buffer>} 处理后的原始像素Buffer
// =======================
async function preprocessImage(imgBuffer) {
  const size = configUtils.imgSize;
  return await sharp(imgBuffer)
      // 等比例缩放，超出部分补黑边
      .resize(size, size, { fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .extend({ top: 0, bottom: 0, left: 0, right: 0, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .raw() // 转为无格式原始像素数据
      .toBuffer();
}


// =======================
// SD核心推理函数：标准DDIM采样 + VAE解码，实现文生图
// @param {object} sessions 模型与分词器实例集合
// @returns {Promise<Buffer>} 生成的PNG图片二进制流
// =======================
async function runSDInference(sessions,configFile) {
  const { tokenizer, textEncoder, unet, vaeDecoder } = sessions;
  const config = { ...configUtils.config, ...JSON.parse(configFile.content) };
  // 读取正向、反向提示词
  const {prompt,negativePrompt} = config;
  // 读取图像尺寸、采样步数、CFG强度
  const { imgSize, inferenceSteps, guidanceScale } = config;

  const latentDim = imgSize / 8;                          // 隐空间尺寸 = 原图尺寸 / 8
  const latentShape = [1, 4, latentDim, latentDim];       // 隐空间张量形状 [批次,通道,高度,宽度]
  const totalSteps = 1000;                                // SD原生DDPM总步数，固定为1000
  const VAE_SCALE = 0.18215;                              // SD官方VAE隐空间缩放系数，解码必需

  console.log('[LOG] 正向提示词:', prompt);
  console.log('[LOG] 反向提示词:', negativePrompt);
  console.log('[LOG] 图像尺寸:', imgSize, '隐空间维度:', latentDim);
  console.log('[LOG] 采样步数:', inferenceSteps, 'CFG强度:', guidanceScale);

  // ========== 1. 提示词文本编码 ==========
  const tokens = encodePrompt(tokenizer, prompt);
  const negTokens = encodePrompt(tokenizer, negativePrompt);
  console.log('[LOG] 正向tokens (前10):', tokens.slice(0, 10), '... 总长度:', tokens.length);
  console.log('[LOG] 反向tokens (前10):', negTokens.slice(0, 10), '... 总长度:', negTokens.length);

  // 构造int32类型张量，适配text_encoder模型输入要求
  const inputIds = new ort.Tensor('int32', Int32Array.from(tokens), [1, 77]);
  const negInputIds = new ort.Tensor('int32', Int32Array.from(negTokens), [1, 77]);

  // 文本编码器推理，得到文本特征向量
  const textEmbeds = await textEncoder.run({ input_ids: inputIds });
  const negTextEmbeds = await textEncoder.run({ input_ids: negInputIds });

  const textEmbed = textEmbeds[Object.keys(textEmbeds)[0]];
  const negTextEmbed = negTextEmbeds[Object.keys(negTextEmbeds)[0]];

  // 打印文本嵌入的统计信息
  const textData = textEmbed.data;
  let tMin = Infinity, tMax = -Infinity, tSum = 0;
  for (let i = 0; i < textData.length; i++) {
    const v = textData[i];
    if (v < tMin) tMin = v;
    if (v > tMax) tMax = v;
    tSum += v;
  }
  console.log('[LOG] 正向文本嵌入 shape:', textEmbed.dims, ' min:', tMin, ' max:', tMax, ' mean:', tSum/textData.length);

  // ========== 2. 预计算DDIM调度参数 ==========
  // 生成beta系数数组
  const betas = linspace(0.00085, 0.012, totalSteps);
  // 由beta计算alpha系数
  const alphas = betas.map(b => 1 - b);
  // 计算alpha累积乘积，扩散模型核心参数
  const alphasCumprod = [];
  let product = 1;
  for (let i = 0; i < totalSteps; i++) {
    product *= alphas[i];
    alphasCumprod.push(product);
  }
  console.log('[LOG] alphasCumprod[0]:', alphasCumprod[0], ' last:', alphasCumprod[alphasCumprod.length-1]);

  // 生成采样时间步：从大到小倒序采样
  const timesteps = [];
  for (let i = inferenceSteps - 1; i >= 0; i--) {
    const t = Math.round(totalSteps - 1 - (i / (inferenceSteps - 1)) * (totalSteps - 1));
    timesteps.unshift(t); // unshift 头部插入，保证数组 [999, ... , 0]
  }
  console.log('[LOG] 采样时间步数量:', timesteps.length, ' 首:', timesteps[0], ' 末:', timesteps[timesteps.length-1]);

  // ========== 3. 初始化隐空间随机噪声 ==========
  let latents = new Float32Array(latentShape.reduce((a, b) => a * b, 1));
  for (let i = 0; i < latents.length; i++) {
    // 生成标准高斯噪声（已修正）
    latents[i] = gaussianRandom();
  }
  let latentTensor = new ort.Tensor('float32', latents, latentShape);
  // 统计初始噪声
  let lMin = Infinity, lMax = -Infinity, lSum = 0;
  for (let i = 0; i < latents.length; i++) {
    const v = latents[i];
    if (v < lMin) lMin = v;
    if (v > lMax) lMax = v;
    lSum += v;
  }
  console.log('[LOG] 初始噪声 min:', lMin, ' max:', lMax, ' mean:', lSum/latents.length);

  // ========== 4. DDIM迭代去噪主循环 ==========
  for (let i = 0; i < timesteps.length; i++) {
    const t = timesteps[i];
    const prevT = i < timesteps.length - 1 ? timesteps[i + 1] : 0;

    // UNet推理：预测当前时间步的噪声
    const outputs = await unet.run({
      sample: latentTensor,
      timestep: new ort.Tensor('float32', [t], [1]),
      encoder_hidden_states: textEmbed
    });
    const negOutputs = await unet.run({
      sample: latentTensor,
      timestep: new ort.Tensor('float32', [t], [1]),
      encoder_hidden_states: negTextEmbed
    });

    const noisePred = outputs[Object.keys(outputs)[0]];
    const negNoisePred = negOutputs[Object.keys(negOutputs)[0]];

    // CFG引导：融合正向与反向噪声预测结果
    const guidedNoise = new Float32Array(noisePred.data.length);
    for (let j = 0; j < guidedNoise.length; j++) {
      guidedNoise[j] = negNoisePred.data[j] + guidanceScale * (noisePred.data[j] - negNoisePred.data[j]);
    }

    // 可选：记录每一步的噪声统计（为减少输出，每5步打印一次）
    if (i % 5 === 0 || i === timesteps.length - 1) {
      let gMin = Infinity, gMax = -Infinity, gSum = 0;
      for (let j = 0; j < guidedNoise.length; j++) {
        const v = guidedNoise[j];
        if (v < gMin) gMin = v;
        if (v > gMax) gMax = v;
        gSum += v;
      }
      console.log(`[LOG] 步骤 ${i+1}/${timesteps.length}, t=${t}, 引导噪声 min: ${gMin}, max: ${gMax}, mean: ${gSum/guidedNoise.length}`);
    }

    // DDIM公式计算上一时刻隐空间数据
    const alphaT = alphasCumprod[t];
    const alphaPrev = alphasCumprod[prevT];
    const sqrtAlphaT = Math.sqrt(alphaT);
    const sqrtOneMinusAlphaT = Math.sqrt(1 - alphaT);
    const sqrtAlphaPrev = Math.sqrt(alphaPrev);
    const sqrtOneMinusAlphaPrev = Math.sqrt(1 - alphaPrev);
    const prevLatents = new Float32Array(latentTensor.data.length);
    for (let j = 0; j < prevLatents.length; j++) {
      const xt = latentTensor.data[j];
      const eps = guidedNoise[j];
      const predX0 = (xt - sqrtOneMinusAlphaT * eps) / sqrtAlphaT;
      prevLatents[j] = sqrtAlphaPrev * predX0 + sqrtOneMinusAlphaPrev * eps;
    }

    latentTensor = new ort.Tensor('float32', prevLatents, latentShape);
  }

  // 最终隐空间统计
  const finalLatentData = latentTensor.data;
  let fMin = Infinity, fMax = -Infinity, fSum = 0;
  for (let i = 0; i < finalLatentData.length; i++) {
    const v = finalLatentData[i];
    if (v < fMin) fMin = v;
    if (v > fMax) fMax = v;
    fSum += v;
  }
  console.log('[LOG] 最终隐空间 min:', fMin, ' max:', fMax, ' mean:', fSum/finalLatentData.length);

  // ========== 5. VAE解码：隐空间数据转为像素图像 ==========
  // 执行SD标准隐空间缩放
  const scaledLatents = new Float32Array(latentTensor.data.length);
  for (let i = 0; i < scaledLatents.length; i++) {
    scaledLatents[i] = latentTensor.data[i] / VAE_SCALE;
  }
  const scaledLatentTensor = new ort.Tensor('float32', scaledLatents, latentShape);

  // VAE解码器推理，输入节点名为 latent_sample
  const vaeOut = await vaeDecoder.run({ latent_sample: scaledLatentTensor });
  const pixelData = vaeOut[Object.keys(vaeOut)[0]].data;

  // 统计VAE输出
  let pMin = Infinity, pMax = -Infinity, pSum = 0;
  for (let i = 0; i < pixelData.length; i++) {
    const v = pixelData[i];
    if (v < pMin) pMin = v;
    if (v > pMax) pMax = v;
    pSum += v;
  }
  console.log('[LOG] VAE解码输出 min:', pMin, ' max:', pMax, ' mean:', pSum/pixelData.length);

  // ========== 6. 数据格式转换：CHW -> HWC + 值域映射 [-1,1] => [0,255] ==========
  const outBuffer = Buffer.alloc(imgSize * imgSize * 3);

  for (let h = 0; h < imgSize; h++) {
    for (let w = 0; w < imgSize; w++) {
      for (let c = 0; c < 3; c++) {
        const srcIdx = c * imgSize * imgSize + h * imgSize + w;  // CHW
        const dstIdx = (h * imgSize + w) * 3 + c;                // HWC，每个像素3通道
        let val = (pixelData[srcIdx] + 1) / 2;                  // [-1,1] -> [0,1]
        val = Math.max(0, Math.min(1, val));                    // 截断
        outBuffer[dstIdx] = Math.floor(val * 255);
      }
    }
  }

  // 统计最终像素值分布
  let pixMin = 255, pixMax = 0, pixSum = 0;
  for (let i = 0; i < outBuffer.length; i++) {
    const v = outBuffer[i];
    if (v < pixMin) pixMin = v;
    if (v > pixMax) pixMax = v;
    pixSum += v;
  }
  console.log('[LOG] 最终像素值 min:', pixMin, ' max:', pixMax, ' mean:', pixSum/outBuffer.length);

  // 原始像素数据转为PNG格式并返回二进制流
  return await sharp(outBuffer, { raw: { width: imgSize, height: imgSize, channels: 3 } })
      .png()
      .toBuffer();
}

// =======================
// 工具函数：生成线性等分数组
// @param {number} start 起始值
// @param {number} end 结束值
// @param {number} steps 数组元素个数
// @returns {number[]} 线性递增数组
// =======================
function linspace(start, end, steps) {
  const result = [];
  const step = (end - start) / (steps - 1);
  for (let i = 0; i < steps; i++) {
    result.push(start + step * i);
  }
  return result;
}

// =======================
// 工具函数：Box-Muller算法生成标准正态分布随机数（高斯噪声）
// @returns {number} 正态分布随机数值
// =======================
function gaussianRandom() {
  let u = 0, v = 0;
  // 排除0值，避免对数计算报错
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// 生成时间戳，格式如：2026-07-24_15-30-45
function getTimestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

// ========== 默认配置模板 ==========
function createConfigTemplate() {
  return configUtils.config;
}

// =======================
// 主处理入口：框架调用的核心函数
// @param {Array} inputArray 输入文件数组
// @param {object} outputNodeTemplate 输出格式模板
// @returns {Array} 处理结果数组
// =======================
async function writingRules(inputArray, outputNodeTemplate) {
  const outputDir = outputNodeTemplate.path;
  const inputPath = path.join(outputDir, '../inputDir');

  const configFile = inputArray.find(item => item.normExt === 'json' && item.name === 'config');
  if (!configFile) {
    const template = createConfigTemplate();
    return [
      { ...outputNodeTemplate, content: '错误: 未找到 config.json 文件，示例配置已创建' },
      { ...outputNodeTemplate, path: inputPath, fileName: 'config', normExt: 'json', content: JSON.stringify(template, null, 2) }
    ];
  }

  // 1. 检查并准备模型文件
  const modelReady = await cloneAndPrepareModel();
  if (!modelReady) {
    return [{ ...outputNodeTemplate, content: '错误: 模型下载/加载失败' }];
  }

  // 2. 加载所有推理模型与会话
  const fullModelPath = configUtils.getFullModelPath();
  const sessions = await loadSDSessions(fullModelPath);

  const result = [];

  console.log(`开始生成图片...`);
  const timestamp = getTimestamp(); // 获取时间戳
  try {
    // 3. 执行文生图
    const resultBuffer = await runSDInference(sessions,configFile);

    // 封装成功结果
    result.push({
      ...outputNodeTemplate,
      fileName: `result_${timestamp}`, // 追加到文件名
      normExt: 'png',
      content: resultBuffer
    });
  } catch (err) {
    // 捕获异常，返回错误信息
    console.error(`处理图片失败:`, err.message);
    result.push({
      ...outputNodeTemplate,
      fileName: `fail_${timestamp}`,
      normExt: 'txt',
      content: Buffer.from(`处理失败: ${err.message}`)
    });
  }

  return result;
}

/*
文本提示词 → 分词器 → token IDs (77) → text encoder → 文本嵌入 (1,77,768)
                                                          ↓
随机高斯噪声 (1,4,64,64) → 迭代去噪 (DDIM + UNet) ← 文本嵌入
                                                          ↓
                                          去噪后隐变量 (1,4,64,64)
                                                          ↓
                                      除以 VAE_SCALE → VAE 解码器
                                                          ↓
                                          像素值 (1,3,512,512) [-1,1]
                                                          ↓
                               CHW→HWC, 映射到 [0,255] → PNG buffer
 */

// =======================
// 模块导出配置：供上层框架识别、加载该插件
// =======================
module.exports = {
  name: 'txt2img',
  version: '1.0.0',
  process: writingRules,
  description: '基于 ONNX Runtime + Stable Diffusion v1.5 ONNX 实现文生图，全程离线、零第三方分词依赖',
  notes: {
    node: '18.20.4',
    model: 'onnx-community/stable-diffusion-v1-5-ONNX',
    tips: '需提前安装Git、Git LFS；首次运行自动下载模型，后续离线使用；修改prompt切换风格'
  },
  error: {
    'model-download': {
      description: '模型下载失败可能是由于网络问题或镜像地址不可用',
      process: '解决方案：尝试切换configUtils中的mirrorUrl，或手动从Hugging Face Hub下载模型并放置到指定目录',
      other: '确保Git和Git LFS已正确安装并配置'
    }
  },
  input: {
    normExt: 'json',
    description: '提示词（英文）'
  },
  output: {
    normExt: 'png、txt',
    format: '风格化PNG图片，失败则输出错误文本'
  },
  rely: {
    'sharp': '0.34.5',
    'onnxruntime-node': '1.23.2'
  }
};