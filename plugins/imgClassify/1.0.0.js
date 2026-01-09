const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const ort = require('onnxruntime-node');
const sharp = require('sharp');
const axios = require('axios');

// =======================
// 配置区
// =======================
const configUtils = {
  mirrorUrl: 'https://hf-cdn.sufy.com/', // 快但不稳定
  // mirrorUrl: 'https://hf-mirror.com/', // 慢但稳定
  modelPath: path.join(process.cwd(), './examples/model'), // 本地模型根目录
  repoName: 'onnxmodelzoo/resnet50-v1-12-int8',//仓库地址
  lfsFiles: [
    'resnet50-v1-12-int8.onnx', // 要下载的 LFS 文件模式（支持通配符）
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
// 指定网络路径下载
// =======================
async function getUrlInfo(url,option={}) {
  console.log(`正在从网络下载...`);
  const config = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    },
    timeout: 30000,
    ...option
    // 移除 responseType 配置，axios默认会解析JSON
  };
  // axios 自动将响应解析为JSON数组，直接返回 response.data 即可
  const response = await axios.get(url, config);
  console.log(`网络下载结束...`);
  return response.data;
}

// =======================
// 下载 ImageNet 的 1000 个类别标签
// =======================
async function getLabels() {
  console.log(`本地标签文件不存在...`);
  const fileUrl = 'https://raw.githubusercontent.com/anishathalye/imagenet-simple-labels/master/imagenet-simple-labels.json';
  // const fileUrl = 'https://cdn.jsdelivr.net/gh/anishathalye/imagenet-simple-labels@master/imagenet-simple-labels.json';
  try {
    const urlInfo = await getUrlInfo(fileUrl);
    return urlInfo;
  }catch (error) {
    console.error(`获取标签失败：${error.message}`);
    return [];
  }

}

/**
 * 实现 Softmax 函数：将 logits 转换为概率分布
 * 公式：softmax(x_i) = exp(x_i - max(x)) / sum(exp(x_j - max(x)))
 * 减去最大值是为了防止指数溢出（数值稳定性）
 * @param {Float32Array} logits - 模型原始输出（长度 1000）
 * @returns {Array<number>} - 每个类别的概率（总和为 1）
 */
function softmax(logits) {
  const maxLogit = Math.max(...logits); // 找到最大 logit
  const exps = logits.map(x => Math.exp(x - maxLogit)); // 减去 max 后取指数
  const sumExps = exps.reduce((a, b) => a + b, 0);     // 求和
  return exps.map(exp => exp / sumExps);                // 归一化为概率
}

/**
 * 图像预处理函数：将原始图片转换为 ResNet50 模型所需的输入张量
 * 预处理流程严格遵循 ImageNet 训练时的标准：
 *   1. 缩放到 256x256（保持宽高比，多余部分裁掉）
 *   2. 从中心裁剪出 224x224 区域（ResNet 输入尺寸）
 *   3. 转换为 RGB 像素 Buffer（HWC 格式：Height × Width × Channel）
 *   4. 归一化：(pixel / 255 - mean) / std （ImageNet 统计参数）
 *   5. 重排为 CHW 格式（Channel × Height × Width），适配 ONNX 模型输入
 * @param {string} imagePath - 输入图片的本地路径
 * @returns {Promise<Float32Array>} - 形状为 [3*224*224] 的归一化浮点数组，可直接传入模型
 */
async function preprocessImage(imagePath) {
  console.log(`正在预处理图片: ${imagePath}`);
  try {
    // 使用 sharp 进行高效图像处理
    const imageBuffer = await sharp(imagePath)
        .resize(256, 256, { fit: 'cover', position: 'center' }) // 缩放至 256x256，保持比例，居中裁剪
        .extract({ left: 16, top: 16, width: 224, height: 224 }) // 从 (16,16) 开始裁剪 224x224（即中心区域）
        .raw() // 输出原始像素数据（不编码为 JPEG/PNG，而是纯 Buffer）
        .toBuffer(); //转为纯字节流 Buffer，存储规则是：按「像素」存储 → 先存完一个像素的 R、G、B，再存下一个像素，一行存完存下一行

    // ImageNet 数据集训练时使用的 RGB 通道均值和标准差（固定值）
    const mean = [0.485, 0.456, 0.406]; // R, G, B 各通道均值
    const std = [0.229, 0.224, 0.225];   // R, G, B 各通道标准差

    // 创建目标张量：CHW 格式，共 3×224×224 = 150,528 个浮点数
    const input = new Float32Array(3 * 224 * 224);

    // HWC 格式：H = Height (行)、W = Width (列)、C = Channel (通道，R/G/B)
    // 核心特点：一个像素的 3 个颜色值是挨在一起的，比如第 1 个像素的 R、G、B 在 Buffer 里是连续的 3 个字节，第 2 个像素的 R、G、B 紧接着也是连续 3 个字节...
    // CHW 格式：C = Channel (通道)、H = Height (行)、W = Width (列)
    // 核心特点：同一个通道的所有像素值是挨在一起的，比如数组前 50176（224*224） 个元素全是「所有像素的 R 值」，中间 50176 个全是「所有像素的 G 值」，最后 50176 个全是「所有像素的 B 值」

    // 遍历每个像素位置 (y, x)，进行归一化并重排维度
    for (let y = 0; y < 224; y++) {// y 代表：图片的【行】，从第0行 → 第223行
      for (let x = 0; x < 224; x++) {// x 代表：每行的【列】，从第0列 → 第223列
        // 在 HWC 格式中，每个像素占 3 字节（R, G, B）
        const hwIndex = (y * 224 + x) * 3;//一个像素的 3 个颜色值是挨在一起的

        // 读取原始像素值（0~255 的整数）
        const r = imageBuffer[hwIndex];
        const g = imageBuffer[hwIndex + 1];
        const b = imageBuffer[hwIndex + 2];

        // 归一化公式：先除以 255 转为 [0,1]，再减均值、除标准差
        // 同时将 HWC 转为 CHW：R 通道放在前 224×224，G 在中间，B 在最后
        // RGB通道：存入input数组 → 公式：（0|1|2） * 像素总数 + 像素的位置序号
        input[0 * 224 * 224 + y * 224 + x] = (r / 255.0 - mean[0]) / std[0]; // R → 第0通道
        input[1 * 224 * 224 + y * 224 + x] = (g / 255.0 - mean[1]) / std[1]; // G → 第1通道
        input[2 * 224 * 224 + y * 224 + x] = (b / 255.0 - mean[2]) / std[2]; // B → 第2通道
      }
    }

    return input; // 返回符合模型输入要求的张量数据
  } catch (err) {
    // 若图像损坏、格式不支持等，抛出明确错误
    throw new Error(`图像预处理失败: ${err.message}`);
  }
}

// 主处理函数
async function writingRules(inputArray, outputNodeTemplate) {
  const outputPath = outputNodeTemplate.path;
  const inputPath = path.join(outputPath, '../inputDir');

  // 筛选测试图片
  const imgFiles = inputArray.filter(info => info.path.endsWith('.png') || info.path.endsWith('.jpg'));
  if (imgFiles.length === 0) {
    return [{...outputNodeTemplate, content: '错误: 未找到png/jpg文件'}];
  }

  // 筛选标签文件
  const labelFile = inputArray.find(info => info.path.endsWith('imagenet-simple-labels.json'));
  // 先检查本地是否有标签文件
  if (!labelFile) {
    const labelData = await getLabels();
    return [
        {...outputNodeTemplate, path: inputPath, fileName: 'imagenet-simple-labels',normExt: 'json',content: JSON.stringify(labelData, null, 2)},
        {...outputNodeTemplate, content: '错误: 未找到标签imagenet-simple-labels.json文件'}
    ];
  }

  const contents = []

  //下载模型
  const modelReady = await cloneAndPrepareModel();
  //ImageNet 的 1000 个类别标签
  const labelsReady = JSON.parse(labelFile.content);

  if (modelReady && labelsReady) {
    const fullModelPath = configUtils.getFullModelPath();
    const onnxMode = path.join(fullModelPath, 'resnet50-v1-12-int8.onnx');
    const session = await ort.InferenceSession.create(onnxMode) // 初始化 ONNX Runtime 推理会话

    for (const imgFile of imgFiles) {
      // 预处理输入图像
      const inputData = await preprocessImage(imgFile.path);
      console.log('正在进行图像分类推理...');

      // 执行模型推理
      // 注意：该 ResNet50 ONNX 模型的输入节点名为 'data'（可通过 Netron 工具查看模型结构确认）
      const outputs = await session.run({
        data: new ort.Tensor('float32', inputData, [1, 3, 224, 224]) // [batch=1, channel=3, height=224, width=224]
      });

      // 获取输出 logits（未归一化的分数）
      const outputName = Object.keys(outputs)[0]; // 获取第一个（也是唯一）输出节点名
      const logits = outputs[outputName].data;    // Float32Array，长度为 1000

      // 应用 softmax 得到概率
      const probs = softmax(logits);

      // 步骤6：找出概率最高的前 3 个类别
      const top3 = [...probs]
          .map((prob, idx) => ({ prob, idx })) // 构造 {概率, 索引} 对象数组
          .sort((a, b) => b.prob - a.prob)     // 降序排序
          .slice(0, 3);                        // 取前三

      // 格式化并打印结果
      console.log(`${imgFile.name} 图像分类结果（前3名）：`);
      // 图像分类结果（前3名）
      const top3ClassDetails = [];
      top3.forEach((item, i) => {
        // 从ImageNet固定训练的1000标签和最高概率对应的索引映射图片类型
        const className = labelsReady[item.idx] || `类别 #${item.idx}`; // 防止标签缺失
        const probability = (item.prob * 100).toFixed(2); // 格式化概率为百分比，保留2位小数
        console.log(`${i + 1}. 类别：${className.padEnd(20, ' ')} 概率：${probability}%`);
        // 保存当前排名的类别详情到数组中
        top3ClassDetails.push({
          rank: i + 1,        // 排名（1/2/3）
          className: className, // 类别名称
          probability: probability, // 对应概率
          probRaw: item.prob, // 原始概率值（可选，便于后续计算）
          classIndex: item.idx // 类别索引（可选，便于映射标签）
        });
      });

      // 存储完整的图片信息和前3分类结果
      contents.push({
        "name": imgFile.name,
        "normExt": imgFile.normExt,
        "top3Classes": top3ClassDetails, // 存储前3个类别详情（替代原单一className，更实用）
      });
    }
  } else {
    console.log('模型准备失败');
  }

  return [{...outputNodeTemplate,fileName: 'result',normExt:'json',content:JSON.stringify(contents,null,2)}];
}

// module.exports = writingRules;

// 修正后的导出配置
module.exports = {
  name: 'imgClassify',
  version: '1.0.0',
  process: writingRules,
  description: '基于ONNX Runtime的ResNet50图像分类插件（int8量化版），支持对本地PNG/JPG图片进行ImageNet 1000类别分类',
  notes:{
    node:'18.20.4',
    model: 'onnxmodelzoo/resnet50-v1-12-int8', // 对应实际使用的图像分类模型
    tips: '需提前安装Git和Git LFS，否则无法自动下载模型文件'
  },
  error:{
    'model-download':{
      description:'模型下载失败可能是由于网络问题或镜像地址不可用',
      process:'解决方案：尝试切换configUtils中的mirrorUrl，或手动从Hugging Face Hub下载模型并放置到指定目录',
      other:'确保Git和Git LFS已正确安装并配置'
    }
  },
  input: {
    normExt: 'png、jpg、json（可选标签文件）',
    description: '1. 必选：待分类的PNG/JPG格式图片文件，支持多个图片批量处理；2. 可选：imagenet-simple-labels.json（本地标签文件，无则自动从网络下载）'
  },
  output: {
    normExt: 'json',
    format: '包含所有图片分类结果的JSON文件，每个图片对应名称、格式及前3高概率类别信息（排名、类别名称、概率百分比、原始概率、类别索引）'
  },
  rely: {
    'sharp': '0.34.5',
    'onnxruntime-node': '1.23.2',
    'axios': '0.27.2',
  }
};
