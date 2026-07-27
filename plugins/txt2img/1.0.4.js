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
  // 推理、提示词相关配置项
  config:{
    prompt: "cute guinea pig, soft fur, natural light, mild color",// 正向提示词：指定生成复古8位像素游戏画风
    negativePrompt: "oversaturated, gray, blurry, cartoon",// 反向提示词：屏蔽写实、模糊、畸形、3D等无效画面
    imgSize: 512,                // 生成图像分辨率 512*512（SD1.5标准尺寸）
    inferenceSteps: 12,          // DDIM采样迭代步数，步数越高画质越好、速度越慢
    guidanceScale: 7.5,         // CFG引导强度，控制画面贴合提示词的程度
    denoisingStrength: 0.7,     // 图生图降噪强度（当前文生图暂未启用）
    debug: true                 // 调试开关：开启后每步去噪图片保存至debug目录
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
    /*
      vocab.json 结构示例：{"hello": 123, "world": 456}
      this.encoder：编码用，文本片段 → 数字 ID（正向，推理核心）
      this.decoder：解码用，数字 ID → 文本片段（反向，暂时没用到）
     */

    // 1. 加载词汇表：token -> 数字ID映射
    this.encoder = JSON.parse(fs.readFileSync(vocabPath, 'utf-8'));
    // 构建反向映射：数字ID -> token
    this.decoder = {};
    for (const [token, id] of Object.entries(this.encoder)) {
      this.decoder[id] = token;
    }

    /*
      _bytesToUnicode() 生成规则：0~255 原始字节 → 专用 Unicode 字符
      byteEncoder：字节 → 特殊字符（编码流程用）
      byteDecoder：特殊字符 → 原始字节（解码流程用）
     */

    // 2. 初始化CLIP专用字节转Unicode字符映射
    this.byteEncoder = this._bytesToUnicode();
    this.byteDecoder = {};
    for (const [b, u] of Object.entries(this.byteEncoder)) {
      this.byteDecoder[u] = Number(b);
    }

    /*
      merges.txt：BPE 算法的合并优先级列表，每行两个字符 / 子词，代表「优先把这两个拼在一起」。
      .slice(1)：跳过文件第一行的版本注释（无效内容）。
      把 a b 格式的行，转成 a,b 作为键、行号作为优先级分值存入 bpeRanks： 行号越小 = 优先级越高，合并顺序越靠前。
      后续 _bpe 核心算法，就是靠这个表判断先合并哪一组字符。
      举例：
      he ll 在文件靠前位置 → he,ll 分值很小 → 拆分文本时会优先把 hell 拆成 he + ll。
     */

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

    /*
      输入一个陌生单词 → 拆成单个字符 → 按 merges.txt 优先级从高到低合并字符对。

      假设规则里优先级：th > he > in
      输入单词：the
        1. 初始拆分：t , h , e
        2. 查找相邻对：t+h、h+e
        3. t+h 优先级更高，先合并 → th , e
        4. 没有更高优先级的相邻对，停止
        5. 最终分词结果：["th", "e"]
      然后拿着这两个片段去 vocab.json 查表，得到一串数字 [起始符, 123, 456,...,结束符]
      补全到 77 位 Token → 送入 text_encoder.onnx文本编码器

      注意：CLIP训练时就设定了最多只能接收 77 个 token(模型只看前77个,40～60个英文单词)
     */
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
    //原始英文提示词 → 文本清洗 → 字节转 CLIP 专用 Unicode 字符 → BPE 拆分字符片段 → 查表转数字 ID → 输出纯内容 ID 列表（不含起止符、填充符）

    // 1.文本标准化：转小写、去除多余空格
    const cleanText = text.toLowerCase().trim().replace(/\s+/g, ' ');
    const tokens = [];

    // 2.文本转二进制字节，再映射为CLIP规定的Unicode字符
    const bytes = Buffer.from(cleanText, 'utf-8');//把清洗后的字符串转为 UTF-8 原始字节数组（0~255）
    let mapped = '';
    for (const b of bytes) {
      //this.byteEncoder[b] 把普通字节替换成 CLIP 规定的特殊 Unicode 字符
      mapped += this.byteEncoder[b];
    }

    // 3.调用内部 _bpe 方法，依据 merges.txt 规则做字符合并拆分，最终得到模型词表能识别的子词片段数组
    const bpeTokens = this._bpe(mapped);
    // 将分词结果转为对应数字ID
    for (const t of bpeTokens) {
      if (this.encoder[t] !== undefined) {
        //遍历 BPE 拆分后的每一个子词，查 vocab.json 对应的 encoder 映射表，转成数字 ID
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

  // ONNX Runtime CPU优化参数
  const sessionOpts = {
    executionMode: "sequential",          //  串行执行
    graphOptimizationLevel: "basic", // 基础图优化
    enableCpuMemArena: true, // 内存池复用，减少分配开销
    enableMemPattern: true,
    intraOpNumThreads: 1,   // 每个算子内部线程数=1，避免多线程抢占 (可以调小)
    interOpNumThreads: 1    // 算子间线程数=1 (可以调小)
  };

  const textEncoder = await ort.InferenceSession.create(paths.textEncoder,sessionOpts);
  const unet = await ort.InferenceSession.create(paths.unet,sessionOpts);
  const vaeDecoder = await ort.InferenceSession.create(paths.vaeDecoder,sessionOpts);

  // 实例化本地CLIP分词器（文本提示词 → 分词器 → token IDs (77) → text encoder → 文本嵌入 (1,77,768)）
  // - paths.vocab 词表文件（vocab.json），记录 “子词 → 数字 ID” 的映射。
  // - paths.merges 合并规则文件（merges.txt），记录 BPE 怎么把字符拼成子词。
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
  //最终结构：[CLIP_SOT,...,CLIP_EOT] 长度77
  const CLIP_SOT = 49406; // 文本起始Token ID,标记文本开始
  const CLIP_EOT = 49407; // 文本结束Token ID,标记文本结束
  const CLIP_PAD = 0;     // 空白填充Token ID

  const tokens = tokenizer.encode(text);
  // 截断内容，预留首尾两个特殊Token位置， 最多保留75个有效内容token
  const truncated = tokens.slice(0, maxLength - 2);
  // 拼接起始、内容、结束Token
  const result = [CLIP_SOT, ...truncated, CLIP_EOT];
  // 长度不足77，使用填充Token补全
  while (result.length < maxLength) {
    result.push(CLIP_PAD);
  }
  return result.slice(0, maxLength);//最多保留77个
}


// =======================
// 隐变量解码为PNG：VAE缩放 → 解码 → CHW转HWC → 值域映射 → PNG
// @param {ort.Tensor} latentTensor 隐空间张量
// @param {ort.InferenceSession} vaeDecoder VAE解码器实例
// @param {number} imgSize 图像尺寸
// @returns {Promise<Buffer>} PNG图片二进制流
// =======================
async function latentToPng(latentTensor, vaeDecoder, imgSize) {
  // 训练阶段：VAE Encoder 压缩图片得到隐变量后，会 × 0.18215 缩小值域再送入扩散模型训练；
  // 推理阶段（这里）：扩散输出的隐变量，必须 ÷0.18215 还原尺度，再喂给 VAE Decoder。
  const VAE_SCALE = 0.18215;                              // SD官方VAE隐空间缩放系数，解码必需
  const latentShape = latentTensor.dims;

  // 执行SD标准隐空间缩放
  const scaledLatents = new Float32Array(latentTensor.data.length);
  for (let i = 0; i < scaledLatents.length; i++) {
    scaledLatents[i] = latentTensor.data[i] / VAE_SCALE;//对隐空间所有数值反向缩放
  }
  const scaledLatentTensor = new ort.Tensor('float32', scaledLatents, latentShape);//封装成新张量，作为 VAE 的输入

  // VAE解码器推理
  const vaeOut = await vaeDecoder.run({ latent_sample: scaledLatentTensor });
  const pixelData = vaeOut[Object.keys(vaeOut)[0]].data;//取出数据，通道顺序：CHW （通道顺序：R 通道全部数据 → G 通道 → B 通道）

  // 数据格式转换：CHW -> HWC + 值域映射 [-1,1] => [0,255]
  const outBuffer = Buffer.alloc(imgSize * imgSize * 3);
  for (let h = 0; h < imgSize; h++) {
    for (let w = 0; w < imgSize; w++) {
      for (let c = 0; c < 3; c++) {
        const srcIdx = c * imgSize * imgSize + h * imgSize + w;
        const dstIdx = (h * imgSize + w) * 3 + c;
        let val = (pixelData[srcIdx] + 1) / 2;
        val = Math.max(0, Math.min(1, val));
        outBuffer[dstIdx] = Math.floor(val * 255);
      }
    }
  }

  return await sharp(outBuffer, { raw: { width: imgSize, height: imgSize, channels: 3 } })
      .png()
      .toBuffer();
}

// =======================
// SD核心推理函数：标准DDIM采样 + VAE解码，实现文生图
// @param {object} sessions 模型与分词器实例集合
// @param {object} configFile 配置文件节点
// @param {string} outputDir 输出目录
// @yields {{ type: 'debug'|'result', step?: number, totalSteps?: number, buffer: Buffer }}
// =======================
async function* runSDInference(sessions, configFile) {
  const { tokenizer, textEncoder, unet, vaeDecoder } = sessions;
  const config = { ...configUtils.config, ...JSON.parse(configFile.content) };
  // 读取正向、反向提示词
  const {prompt,negativePrompt} = config;
  // 读取图像尺寸、采样步数、CFG强度
  const { imgSize, inferenceSteps, guidanceScale } = config;

  const latentDim = imgSize / 8;                          // 隐空间尺寸 = 原图尺寸 / 8
  const latentShape = [1, 4, latentDim, latentDim];       // 隐空间张量形状 [批次,通道,高度,宽度]
  const totalSteps = 1000;                                // SD原生DDPM总步数，固定为1000（训练的总步骤，禁止修改）

  console.log('[LOG] 正向提示词:', prompt);
  console.log('[LOG] 反向提示词:', negativePrompt);
  console.log('[LOG] 图像尺寸:', imgSize, '隐空间维度:', latentDim);
  console.log('[LOG] 采样步数:', inferenceSteps, 'CFG强度:', guidanceScale);

  // ========== 1. 提示词文本编码 + 【批量TextEncoder一次推理】 ==========
  const tokens = encodePrompt(tokenizer, prompt);
  const negTokens = encodePrompt(tokenizer, negativePrompt);
  console.log('[LOG] 正向tokens (前10):', tokens.slice(0, 10), '... 总长度:', tokens.length);
  console.log('[LOG] 反向tokens (前10):', negTokens.slice(0, 10), '... 总长度:', negTokens.length);

  // ort.Tensor输出文本特征向量；张量是模型统一的数据容器，模型不直接读普通JS数组，必须转成张量
  // - 第一个参数：'int32'，CLIP 文本编码器的输入要求是整数 ID（Netron查看onnx入参）
  // - 第二个参数：Int32Array.from(tokens)，把普通77长度数组 → 纯 int32 二进制数组，适配模型底层读取
  // - 第三个参数：[2, 77] → 张量形状（dims），2=批次大小(batch)，一次只处理2条文本；77=单条文本固定77个Token（这是 CLIP text_encoder 强制要求的输入形状）
  const batchInputIds = new Int32Array([...tokens, ...negTokens]);
  const inputIdsBatchTensor = new ort.Tensor('int32', batchInputIds, [2, 77]);

  // 文本编码器推理，得到文本特征向量
  // textEncoder.run() 返回的是对象：{ 输出节点名: 张量 }
  // 只调用一次 text encoder
  const textEmbedsBatch = await textEncoder.run({ input_ids: inputIdsBatchTensor });
  //加载text_encoder.onnx（CLIP 文本编码器）onnx模型，输入参数（Netron查看onnx入参）
  //把 77 个 Token ID 转换成模型能理解的语义向量（文本嵌入）

  // 取出输出张量
  // Object.keys(textEmbeds)[0]：取返回结果里第一个输出节点（CLIP 文本编码器只有一个主输出）。
  const batchEmbed = textEmbedsBatch[Object.keys(textEmbedsBatch)[0]];

  // batchEmbed shape [2,77,768]
  const batchData = batchEmbed.data;
  const seqLen = 77;
  const hiddenDim = 768;
  const sliceSize = seqLen * hiddenDim;

  // 拆分正向、负向 embedding
  const textEmbedData = batchData.slice(0, sliceSize);
  const negTextEmbedData = batchData.slice(sliceSize);
  const textEmbed = new ort.Tensor('float32', textEmbedData, [1, seqLen, hiddenDim]);
  const negTextEmbed = new ort.Tensor('float32', negTextEmbedData, [1, seqLen, hiddenDim]);

  // 打印文本嵌入的统计信息
  const textData = textEmbed.data;//张量底层的原始浮点数组，直接拿到所有向量数值
  let tMin = Infinity,//整个向量里最小值
      tMax = -Infinity,//整个向量里最大值
      tSum = 0;//所有数值总和，最后除以总数得到 平均值 (mean)
  for (let i = 0; i < textData.length; i++) {
    const v = textData[i];
    if (v < tMin) tMin = v;
    if (v > tMax) tMax = v;
    tSum += v;
  }

  //目的：看向量数值是否正常（不会全 0、不会极端超大 / 超小值）；
  // dims = [1, 77, 768]；1：批次；77 个 Token 位置；768：每个Token对应的向量维度（语义特征）；这组 [1,77,768] 的浮点张量，就是传给 UNet 的画图指令。
  // 768：用768个连续的浮点数，共同描述这一个文字片段的「语义、特征、含义」
  console.log('[LOG] 正向文本嵌入 shape:', textEmbed.dims, ' min:', tMin, ' max:', tMax, ' mean:', tSum/textData.length);

  // ========== 2. 预计算DDIM调度参数 ==========
  // DDIM 是扩散模型 (Diffusion Model) 的一种加速采样算法。
  // 原生 DDPM，训练：把清晰图片连续加噪 1000 步，最终变成纯噪声；推理（画图）：必须反向完整跑 1000 步去噪才能出图。
  // DDIM 是 DDPM 的提速方案，只抽选少量关键时间步做迭代，隐式采样，跳过中间冗余步骤，用数学公式直接推算中间状态，兼顾速度 + 画质

  // 生成beta系数数组
  // 0.00085 / 0.012 是 SD1.5 官方固定超参，不能随意修改
  const betas = linspace(0.00085, 0.012, totalSteps);//linspace(a, b, n)：生成从 a 到 b 均匀分布的 n 个数字
  // 由beta计算alpha系数
  const alphas = betas.map(b => 1 - b);//代表当前步骤保留原图信息的比例
  // 计算alpha累积乘积，扩散模型核心参数
  const alphasCumprod = [];
  let product = 1;
  for (let i = 0; i < totalSteps; i++) {//表示：从第 1 步到第 t 步，整张图累计保留的原始信息占比（扩散模型最核心的参数）
    product *= alphas[i];
    alphasCumprod.push(product);
  }

  //正常结果：首值接近 1，末值趋近于 0；（这是正向加噪的逻辑）
  //第 1 步，原图信息残留最多；最后一位，原图信息几乎为 0（画面变成纯随机噪声）
  console.log('[LOG] alphasCumprod[0]:', alphasCumprod[0], ' last:', alphasCumprod[alphasCumprod.length-1]);

  // 生成采样时间步：从大到小倒序采样
  // 从 0～999 里，均匀挑出 inferenceSteps 个时间点，倒序排成 [999, ..., 0]，给 DDIM 去噪循环用
  const timesteps = [];
  const maxT = totalSteps - 1;
  const delta = maxT / (inferenceSteps - 1);
  //直接生成降序，不再unshift
  for (let i = 0; i < inferenceSteps; i++) {
    const t = Math.round(maxT - i * delta);
    timesteps.push(t);
  }
  console.log('[LOG] 采样时间步数量:', timesteps.length, ' 首:', timesteps[0], ' 末:', timesteps[timesteps.length-1]);

  // ========== 3. 初始化隐空间随机噪声 ==========
  //生成隐空间的纯随机高斯噪声，并封装成 ONNX 可识别的浮点张量，作为 DDIM 迭代的初始输入
  //SD 不直接对原图像素运算，而是在隐空间（Latent Space） 计算：原图尺寸 ÷ 8 = 隐空间尺寸，计算量大幅降低、提速省资源。

  //开辟一块内存空间，暂时是空容器，承载隐空间数据
  //Float32Array：32 位浮点定型数组，和 ONNX 模型输入类型强制匹配。
  //latentShape.reduce(...)：把形状数组累乘，算出总元素个数。例：[1,4,64,64] → 总长度 = 1 * 4 * 64 * 64 = 16384
  let latents = new Float32Array(latentShape.reduce((a, b) => a * b, 1));

  //填充高斯随机噪声
  for (let i = 0; i < latents.length; i++) {
    // 生成标准高斯噪声（已修正）
    latents[i] = gaussianRandom();//标准高斯分布随机数（均值≈0，正负都有）
  }

  //转为 ONNX 张量
  let latentTensor = new ort.Tensor('float32', latents, latentShape);//把一维 Float32Array + 原始形状 latentShape 封装成 ort.Tensor。
  // 统计初始噪声
  let lMin = Infinity, lMax = -Infinity, lSum = 0;
  for (let i = 0; i < latents.length; i++) {//遍历所有噪声值，计算最小值、最大值、平均值
    const v = latents[i];
    if (v < lMin) lMin = v;
    if (v > lMax) lMax = v;
    lSum += v;
  }

  //正常高斯噪声：均值接近 0，数值正负分布均匀。
  console.log('[LOG] 初始噪声 min:', lMin, ' max:', lMax, ' mean:', lSum/latents.length);

  // ========== 4. DDIM迭代去噪主循环 ==========
  // 包含 UNet 预测噪声、CFG 正负引导、DDIM 公式更新隐变量 三大核心逻辑
  for (let i = 0; i < timesteps.length; i++) {
    //取当前 & 上一个时间步(作用：查表 alphasCumprod 计算 DDIM 系数)
    const t = timesteps[i];//t：当前正在处理的原生扩散步数（从 999 逐步降到 0）
    const prevT = i < timesteps.length - 1 ? timesteps[i + 1] : 0;//prevT：DDIM 推演的前一状态时间步；最后一步强制设为 0（对应完全无噪声）

    //优化方案:把两次 UNet 合并成一次批量推理
    //样本维度 batch_size = 2;输入 [latent, latent]，文本 [pos_emb, neg_emb];一次run同时输出 pos噪声、neg噪声;提速接近 1.8～2 倍

    // ========== CFG开启：批量UNet一次推理 ==========
    // 1. 构造batch输入：latent复制两份 [2,4,H,W]
    const latentData = latentTensor.data;
    const batchLatentData = new Float32Array(latentData.length * 2);//分配数组空间
    batchLatentData.set(latentData, 0);//当前隐空间噪声图 第一个的
    batchLatentData.set(latentData, latentData.length);//当前隐空间噪声图 第二个的
    const batchLatentTensor = new ort.Tensor('float32', batchLatentData, [2, ...latentShape.slice(1)]);//拼接 批次[2]

    // 2. 拼接文本embedding [2,77,768]
    const batchEmbedData = new Float32Array(textEmbedData.length * 2);//分配数组空间
    batchEmbedData.set(negTextEmbedData, 0);// 反向文本特征 [1,77,768]
    batchEmbedData.set(textEmbedData, textEmbedData.length);// // 正向文本特征 [1,77,768]
    const batchEmbedTensor = new ort.Tensor('float32', batchEmbedData, [2, 77, 768]);////拼接 批次[2]

    // 仅执行一次UNet推理
    const unetOutBatch = await unet.run({
      sample: batchLatentTensor,// 当前隐空间噪声图
      timestep: new ort.Tensor('float32', [t, t], [2]),// 当前时间步 扩展batch [2]
      encoder_hidden_states: batchEmbedTensor // 文本特征 反向/正向
    });

    const outBatchTensor = unetOutBatch[Object.keys(unetOutBatch)[0]];
    const outBatchData = outBatchTensor.data;
    const singleLen = latentData.length;

    // 拆分：第0份=负向噪声，第1份=正向噪声
    const negNoiseData = outBatchData.slice(0, singleLen);
    const posNoiseData = outBatchData.slice(singleLen);

    // CFG引导：融合正向与反向噪声预测结果
    // 公式: guidedNoise = negNoise + guidanceScale * (posNoise- negNoise)
    // 逻辑：让模型远离反向提示词、靠近正向提示词，是 SD 图文对齐的核心
    guidedNoise = new Float32Array(singleLen);
    for (let j = 0; j < singleLen; j++) {
      guidedNoise[j] = negNoiseData[j] + guidanceScale * (posNoiseData[j] - negNoiseData[j]);
    }

    // 可选：记录每一步的噪声统计（为减少输出，每5步打印一次）
    // if (i % 5 === 0 || i === timesteps.length - 1) {
    let gMin = Infinity, gMax = -Infinity, gSum = 0;
    for (let j = 0; j < guidedNoise.length; j++) {
      const v = guidedNoise[j];
      if (v < gMin) gMin = v;
      if (v > gMax) gMax = v;
      gSum += v;
    }
    console.log(`[LOG] 步骤 ${i+1}/${timesteps.length}, t=${t}, 引导噪声 min: ${gMin}, max: ${gMax}, mean: ${gSum/guidedNoise.length}`);
    // }

    // 更新隐空间数据 (DDIM公式计算上一时刻隐空间数据)
    // 取出预计算的 alpha 累积系数
    const alphaT = alphasCumprod[t];
    const alphaPrev = alphasCumprod[prevT];

    // 预计算平方根，避免重复运算
    const sqrtAlphaT = Math.sqrt(alphaT);
    const sqrtOneMinusAlphaT = Math.sqrt(1 - alphaT);
    const sqrtAlphaPrev = Math.sqrt(alphaPrev);
    const sqrtOneMinusAlphaPrev = Math.sqrt(1 - alphaPrev);

    const prevLatents = new Float32Array(latentTensor.data.length);
    for (let j = 0; j < prevLatents.length; j++) {
      const xt = latentTensor.data[j];// 当前带噪隐变量
      const eps = guidedNoise[j];// CFG 融合后的预测噪声
      // 1. 反推理论干净图 predX0
      const predX0 = (xt - sqrtOneMinusAlphaT * eps) / sqrtAlphaT;
      // 2. 计算上一时刻（噪声更少）的隐变量
      prevLatents[j] = sqrtAlphaPrev * predX0 + sqrtOneMinusAlphaPrev * eps;
    }

    // 把新隐变量封装为张量，作为下一轮循环的输入
    latentTensor = new ort.Tensor('float32', prevLatents, latentShape);

    // 调试模式：yield每步去噪结果
    if (config.debug) {
      //每一步去噪后，用 VAE 解码生成图片预览
      const stepPng = await latentToPng(latentTensor, vaeDecoder, imgSize);
      yield { type: 'debug', step: i + 1, totalSteps: timesteps.length, buffer: stepPng };
      console.log(`[DEBUG] 生成第 ${i + 1}/${timesteps.length} 步去噪图片`);
    }
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

  // ========== 5. VAE解码：隐变量 → PNG（复用 latentToPng） ==========
  const resultPng = await latentToPng(latentTensor, vaeDecoder, imgSize);
  yield { type: 'result', buffer: resultPng };
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
// @returns {AsyncGenerator} 使用 yield 逐步输出处理结果
// =======================
async function* writingRules(inputArray, outputNodeTemplate) {
  const outputDir = outputNodeTemplate.path;
  const inputPath = path.join(outputDir, '../inputDir');
  const debugPath = path.join(outputDir, 'debug');

  const configFile = inputArray.find(item => item.normExt === 'json' && item.name === 'config');
  if (!configFile) {
    const template = createConfigTemplate();
    yield [
      { ...outputNodeTemplate, content: '错误: 未找到 config.json 文件，示例配置已创建' },
      { ...outputNodeTemplate, path: inputPath, fileName: 'config', normExt: 'json', content: JSON.stringify(template, null, 2) }
    ];
    return;
  }

  // 1. 检查并准备模型文件
  const modelReady = await cloneAndPrepareModel();
  if (!modelReady) {
    yield [{ ...outputNodeTemplate, content: '错误: 模型下载/加载失败' }];
    return;
  }

  // 2. 加载所有推理模型与会话
  const fullModelPath = configUtils.getFullModelPath();
  const sessions = await loadSDSessions(fullModelPath);

  console.log(`开始生成图片...`);
  const timestamp = getTimestamp(); // 获取时间戳
  try {
    // 3. 执行文生图（迭代器，逐步产出 debug 和 result）
    const runSD= runSDInference(sessions, configFile)
    for await (const item of runSD) {
      if (item.type === 'debug') {
        yield [{
          ...outputNodeTemplate,
          path: debugPath,
          fileName: `step_${timestamp}_${String(item.step).padStart(2, '0')}`,
          normExt: 'png',
          content: item.buffer
        }];
      } else {
        yield [{
          ...outputNodeTemplate,
          fileName: `result_${timestamp}`,
          normExt: 'png',
          content: item.buffer
        }];
      }
    }
  } catch (err) {
    // 捕获异常，返回错误信息
    console.error(`处理图片失败:`, err.message);
    yield [{
      ...outputNodeTemplate,
      fileName: `fail_${timestamp}`,
      normExt: 'txt',
      content: Buffer.from(`处理失败: ${err.message}`)
    }];
  }
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
  version: '1.0.3',
  process: writingRules,
  description: '基于 ONNX Runtime + Stable Diffusion v1.5 ONNX 实现文生图，全程离线、零第三方分词依赖（减少扩散模型运行2次（正反提示词），降低推理时间，代价内存占用增加）',
  notes: {
    node: '18.20.4',
    model: 'onnx-community/stable-diffusion-v1-5-ONNX',
    tips: '需提前安装Git、Git LFS；首次运行自动下载模型，后续离线使用；修改prompt切换风格',
    process: '可以通过修改interOpNumThreads增加CPU线程，数值越小，生成越慢，对电脑占用越小',
    choise: '如果电脑性能不足，可以使用1.0.3，平衡方案'
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