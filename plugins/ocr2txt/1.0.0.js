/**
 * rule-ocr-paddleocrv5（stream）：基于飞桨 PP-OCRv5（ONNX, onnxruntime-node）的图片文字识别规则 · 流式 yield 版
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 【与 examples/ruleDir/rule-ocr.js（全量版）的差异 —— 只改了 3 处】
 *   1) module.exports 增加 `mode: 'stream'`：框架不预读图片 content（为 null），逐张按需读流；
 *   2) 新增 `readImageBuffer()`：逐张用 node.stream() 读入图片并合并为 Buffer（单张驻留，不预载全部图片）；
 *   3) 输出粒度改为「每张图 yield 一批」：识别完一张**立即 yield** 该图的输出节点数组，引擎收到即同步
 *      落盘（边识别边出结果；中途中断，已落盘的不丢），不再用 `results` 累加到全部跑完才一次性 yield。
 *   模型准备 / 下载（cloneAndPrepareModel / downloadWithAxios）与全量版**逐行同构**：同样「先收完流再 yield
 *   一个模型文件节点」、由引擎落盘。识别算法 / 模型 / 配置 / 输出 schema 与全量版**完全一致**，下游 robotjs 无缝切换。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 【这是什么】
 * 用 onnxruntime-node 本地推理 HuggingFace 仓库 x3zvawq/paddleocr-js-onnx 中的
 * PP-OCRv5 mobile ONNX 模型，做"图片 → 文本 + 坐标"。
 * 每张图片产出 3 个文件（与 rule-ocr.js / rule-ocr-onnx.js 同 schema，robotjs 规则可无缝切换）：
 *   <图片名>.txt            —— 纯文本（按检测框顺序拼接）
 *   <图片名>_ocr_report.json —— 识别报告（耗时/框数/错误）
 *   <图片名>_ocr_coords.json —— 坐标（每个检测框的文本 + 像素包围盒，供 robotjs 消费）
 *
 * 【模型来源（x3zvawq/paddleocr-js-onnx）】
 * 该仓库是 paddleocr.js 的模型集，本规则取其中完整可运行的通用文本 OCR 三件套：
 *   ppocr_v5_mobile/PP-OCRv5_mobile_det_infer.onnx   —— 文本检测（DB 概率图）
 *   ppocr_v5_mobile/PP-OCRv5_mobile_rec_infer.onnx   —— 文本识别（SVTR + CTC）
 *   ppocr_v5_mobile/ppocrv5_dict.txt                 —— 中文词表（一行一字，blank=0）
 *
 * 【PP-OCRv5 流水线】
 *   1) 文本检测  det  —— 输入 [1,3,H,W]，输出 [1,1,scoreH,scoreW] 概率图
 *                       → sigmoid + 阈值(boxThreshold) + 4 连通域取轴对齐框 → 映射回原图像素坐标
 *   2) 文本识别  rec  —— 裁剪每个框 → resize 到 48×W → 归一化 → CTC 贪心解码 + 词表映射
 *
 * 【依赖与模型获取】
 * 严格复用 rule-process-plugin 中 imgClassify 的范式：configUtils + cloneAndPrepareModel
 * 通过 git-lfs 从 HuggingFace 镜像拉取 ONNX 模型（默认 hf-mirror.com）。
 *   rely: onnxruntime-node、sharp（图像预处理）
 *
 * 【坐标 / robotjs 映射】（与前两版一致）
 *   坐标为图片像素空间（左上原点）。robotjs 映射：
 *     screenX = round(cx * scale) + offsetX；scale = 图片像素/屏幕像素
 *     screenY = round(cy * scale) + offsetY；offset = 图片在屏幕左上角位置
 *
 * 【使用方式】
 *   rule-process run -r examples/ruleDir/rule-ocr-stream.js -i examples/inputDir -o examples/outputDir
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs = require('fs');
const path = require('path');
const {execSync} = require('child_process');
const ort = require('onnxruntime-node');// 引入ONNX运行时，负责加载并推理ONNX格式模型

// =======================
// 配置区（参照 imgClassify / translation 的 configUtils 范式）
// =======================
const configUtils = {
    mirrorUrl: 'https://hf-mirror.com/',            // 唯一的镜像源：同时用于 git clone 与 axios 兜底下载；可换 'https://hf-cdn.sufy.com/'
    modelPath: path.join(process.cwd(), './examples/model'), // 本地模型根目录
    repoName: 'x3zvawq/paddleocr-js-onnx',          // 本次指定仓库：paddleocr.js 的 ONNX 模型集
    // 拉取哪些文件
    lfsFiles: [
        'ppocr_v5_mobile/PP-OCRv5_mobile_det_infer.onnx',
        'ppocr_v5_mobile/PP-OCRv5_mobile_rec_infer.onnx'
    ],
    minModelBytes: 1024,   // 模型文件最小合格体积：小于此值视为 LFS 指针占位文件，需重新拉取
    // 推理超参
    detLimit: 960,        // 检测最长边缩放上限（像素）
    boxThreshold: 0.3,    // DB 二值化阈值
    minBoxArea: 12,       // 连通域最小像素数，过滤噪点
    recMaxWidth: 320,     // 识别输入最大宽度（像素）
    // 归一化（PaddleOCR 标准：检测用 ImageNet 统计，识别用 0.5 中心化）
    detMean: [0.485, 0.456, 0.406],
    detStd: [0.229, 0.224, 0.225],
    recMean: [0.5, 0.5, 0.5],
    recStd: [0.5, 0.5, 0.5],
    // CTC 解码：blank 位置。**实测结论（用真实模型跑推理对照得出，不要凭"官方惯例"改）**：
    // 本模型（x3zvawq/paddleocr-js-onnx 的 PP-OCRv5 mobile rec，输出 [1,T,18385]）
    // blank = 0（第 0 类），字符取 vocabList[bestIdx-1]。
    // 曾误改为 'last' 导致整篇识别错位成乱码（如「新工作任务」→「韵 土 伯 伤 包」）。
    blankIndex: 'first',
    // 识别输入通道顺序：PaddleOCR 用 cv2 读取 = BGR；sharp 默认输出 RGB。
    // 默认 'bgr' 表示把 sharp 的 RGB 重排为 BGR 再喂模型。若识别乱码，改 'rgb' 试。
    recChannelOrder: 'bgr',
    getFullModelPath() {
        return path.join(this.modelPath, this.repoName.split('/').pop());
    },
    getGitCloneUrl() {
        return this.mirrorUrl + this.repoName;
    }
};
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'bmp', 'webp', 'tiff', 'gif'];

// =======================
// 工具函数：查找本地Git Bash可执行文件路径（Windows专用）
// =======================
function getGitBashPath() {
    try {
        // 从系统环境变量检索git-bash位置
        let gitBashPath = execSync('where git-bash.exe', {encoding: 'utf8'}).trim();
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
        execSync(fullCmd, {stdio: 'inherit', encoding: 'utf8'});
    } catch (error) {
        // 命令执行异常，封装错误信息抛出
        throw new Error(`指令执行失败：${bashCmd}\n原因：${error.message.slice(0, 200)}`);
    }
}

// =======================
// 模型自动准备函数：克隆仓库 + Git LFS拉取模型大文件（缺失时 axios 兜底，经 yield 交由引擎落盘）
// @param {object} outputNodeTemplate 输出节点模板（用于拼模型文件节点）
// @returns {AsyncGenerator} yield 兜底下载的模型文件节点；return true/false 表示模型是否准备完整
// =======================
async function* cloneAndPrepareModel(outputNodeTemplate) {
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
                fs.mkdirSync(baseModelPath, {recursive: true});
            }

            // 执行git clone，仅拉取仓库目录结构，不拉取LFS大文件
            runCommand(`git clone "${gitCloneUrl}"`, baseModelPath);
        }

        console.log('正在拉取必要的模型文件...');
        const includeFiles = configUtils.lfsFiles;
        let allOk = true;   // 任一文件获取失败 → false，交由主流程报「模型准备失败」
        // 遍历需要的模型文件，逐个通过Git LFS下载
        for (const includeFile of includeFiles) {
            const localFile = path.join(fullModelPath, includeFile);

            // ① 先判断：已就绪（存在且 >= minModelBytes）就跳过，不触发 lfs
            if (isModelFileReady(localFile)) {
                console.log(`[模型] ${includeFile} 已就绪 (${fs.statSync(localFile).size} bytes)，跳过 lfs`);
                continue;
            }

            // ② 按需 lfs：仅缺失 / 体积不合格时才拉取该文件
            console.log(`[模型] ${includeFile} 缺失或过小(<${configUtils.minModelBytes}B，疑似 LFS 指针)，执行 git lfs pull`);
            try {
                runCommand(`git lfs pull --include="${includeFile}"`, fullModelPath);
            } catch (e) {
                console.warn(`[模型] git lfs pull ${includeFile} 失败，转 axios 兜底:`, e.message);
            }

            // ③ 再判断：lfs 后仍不合格 → axios 兜底下载
            if (isModelFileReady(localFile)) {
                console.log(`[模型] ${includeFile} lfs 拉取成功 (${fs.statSync(localFile).size} bytes)`);
            } else {
                const ok = yield* downloadWithAxios(includeFile, localFile, outputNodeTemplate);
                if (ok) {
                    console.log(`[模型] ${includeFile} axios 兜底成功 (${fs.statSync(localFile).size} bytes)`);
                } else {
                    allOk = false;
                    console.error(`[模型] ${includeFile} 获取失败，模型不完整`);
                }
            }
        }

        return allOk;
    } catch (error) {
        console.error('模型准备失败:', error.message);
        return false;
    }
}

/**
 * 用 axios 从 configUtils.mirrorUrl 下载单个模型文件：先收完流、再 yield 一个文件节点，写盘交给引擎。
 * 下载源与 git clone 源统一使用 mirrorUrl（不再单独维护下载镜像列表）。
 * - 为什么先收完：输出节点的 content 只能是 string|Buffer（validtor 会拒掉流对象），所以必须拼成整块 Buffer。
 *   代价是内存驻留（不省内存）；收益是写盘路径/日志/覆盖语义全部交给框架统一处理。
 * - 为什么 yield 后能立刻用：build.js 的 for await 循环体（写盘）在 gen.next() 之后同步执行，
 *   所以 yield* 恢复时文件已落盘，紧随其后的 InferenceSession.create 可直接加载。
 * - 节点 path 指向模型缓存目录（不是业务输出目录），与 destPath 所在目录一致，行为与直接 fs 写入等价。
 * @returns {AsyncGenerator} yield 模型文件节点数组；return true/false 表示该文件是否获取成功
 */
async function* downloadWithAxios(relPath, destPath, outputNodeTemplate) {
    const base = configUtils.mirrorUrl.replace(/\/+$/, '');
    // 注意：必须用 resolve（返回原始文件字节）；blob 返回的是 HF 网页(HTML)，会把 HTML 当成模型写盘
    const url = `${base}/${configUtils.repoName}/resolve/main/${relPath}`;
    try {
        const axios = require('axios'); // 惰性加载：未安装时仅兜底失败，不影响插件加载
        console.log(`[axios兜底] 下载 ${relPath} <- ${url}`);
        const res = await axios.get(url, {responseType: 'stream', timeout: 180000});

        // ① 先收完：逐块读入并拼成完整 Buffer
        const chunks = [];
        let received = 0;
        for await (const chunk of res.data) {
            chunks.push(chunk);
            received += chunk.length;
        }
        const content = Buffer.concat(chunks, received);

        // ② 再 yield：把「写哪个文件」交给引擎（引擎写前会自己 createHostDir 建目录）
        const ext = path.extname(destPath).slice(1);
        yield [{
            ...outputNodeTemplate,
            path: path.dirname(destPath),
            fileName: path.basename(destPath, '.' + ext),
            normExt: ext,
            content
        }];
        // 此刻引擎已写盘完成（顺序保证），statSync 顺带作为一次运行时自检
        console.log(`[axios兜底] 成功交付 ${destPath} (${fs.statSync(destPath).size} bytes，由引擎落盘)`);
        return true;
    } catch (e) {
        console.warn(`[axios兜底] ${url} 失败: ${e.message}`);
        return false;
    }
}

/**
 * 判断某个模型文件是否就绪：存在且体积 >= configUtils.minModelBytes。
 * 小于阈值的通常是 Git LFS 指针占位文件（约 130B），需要重新拉取。
 */
function isModelFileReady(localPath) {
    return fs.existsSync(localPath) && fs.statSync(localPath).size >= configUtils.minModelBytes;
}

// =======================
// 中文词表（ppocrv5_dict.txt，一行一字）
// =======================
function getVocab(vocabPath) {
    if (!fs.existsSync(vocabPath)) throw new Error('未找到词表 ' + vocabPath + '（请确认 lfs 已拉取）');
    // PP-OCRv5 dict 每行一个字符、无空行。先去 BOM 与行尾 \r，
    // 再 filter 掉空行与文件末尾换行产生的空串：否则 vocabList 长度会 +1、
    // numClasses 跟着错位，导致 blank 判定失效、识别出的字整体错位。
    let raw = fs.readFileSync(vocabPath, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    const list = raw.split(/\r?\n/).filter(s => s.length > 0);
    if (list.length === 0) throw new Error('词表为空：' + vocabPath);
    return list; // vocabList[i] 对应模型类别 i；blank 位置见 configUtils.blankIndex
}

// =======================
// 纯函数：sigmoid / 连通域 / 取框 / CTC 解码（可单测，不依赖 sharp/ort）
// =======================
function sigmoid(x) {
    return 1 / (1 + Math.exp(-x));
}

/**
 * 检测概率图二值化：自动判断模型输出是否为未归一化的 logits。
 * 若数值最大值 > 1（典型 logits），先 sigmoid 再按阈值二值化；
 * 若已在 [0,1]（已是概率图），直接阈值二值化，避免二次 sigmoid 把背景判成文字（导致整图被当成一框、识别无结果）。
 */
function binarizeDet(scoreData, boxThreshold) {
    let maxV = -Infinity;
    for (let i = 0; i < scoreData.length; i++) if (scoreData[i] > maxV) maxV = scoreData[i];
    const needSigmoid = maxV > 1;
    const mask = new Uint8Array(scoreData.length);
    for (let i = 0; i < scoreData.length; i++) {
        const p = needSigmoid ? sigmoid(scoreData[i]) : scoreData[i];
        mask[i] = p > boxThreshold ? 1 : 0;
    }
    return mask;
}

/** 4 连通域标记，返回各连通域的像素坐标列表 */
function connectedComponents(mask, W, H) {
    const seen = new Uint8Array(W * H);
    const comps = [];
    for (let i = 0; i < W * H; i++) {
        if (!mask[i] || seen[i]) continue;
        const pixels = [];
        const stack = [i];
        seen[i] = 1;
        while (stack.length) {
            const p = stack.pop();
            const x = p % W, y = (p / W) | 0;
            pixels.push([x, y]);
            const nb = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
            for (const [nx, ny] of nb) {
                if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
                const ni = ny * W + nx;
                if (mask[ni] && !seen[ni]) {
                    seen[ni] = 1;
                    stack.push(ni);
                }
            }
        }
        comps.push({size: pixels.length, pixels});
    }
    return comps;
}

/** 从检测概率图取轴对齐框，直接映射回原图像素坐标（score_coord * 原图/score图） */
function boxesFromDet(scoreData, scoreW, scoreH, ow, oh, boxThreshold, minBoxArea) {
    const mask = binarizeDet(scoreData, boxThreshold);
    const comps = connectedComponents(mask, scoreW, scoreH);
    const boxes = [];
    for (const c of comps) {
        if (c.size < minBoxArea) continue;
        let minx = scoreW, miny = scoreH, maxx = 0, maxy = 0;
        for (const [x, y] of c.pixels) {
            if (x < minx) minx = x;
            if (x > maxx) maxx = x;
            if (y < miny) miny = y;
            if (y > maxy) maxy = y;
        }
        let x0 = Math.round(minx * ow / scoreW);
        let y0 = Math.round(miny * oh / scoreH);
        let x1 = Math.round((maxx + 1) * ow / scoreW);
        let y1 = Math.round((maxy + 1) * oh / scoreH);
        x0 = Math.max(0, Math.min(ow, x0));
        y0 = Math.max(0, Math.min(oh, y0));
        x1 = Math.max(0, Math.min(ow, x1));
        y1 = Math.max(0, Math.min(oh, y1));
        if (x1 - x0 < 3 || y1 - y0 < 3) continue;
        boxes.push({x0, y0, x1, y1});
    }
    return boxes;
}

/** CTC 贪心解码：输入模型原始输出 data + dims，自动识别类别轴/时间轴
 *  兼容 [1,T,C] / [1,C,T] / [T,C] 任意布局（行优先）
 *  blank 位置与字符索引映射由 configUtils.blankIndex 决定（本模型实测为 'first'）：
 *    - 'first'（本模型实测正确）：blank = 0，字符取 vocabList[bestIdx-1]
 *    - 'last'（备选）：blank = numClasses-1，字符直接取 vocabList[bestIdx]
 */
function ctcDecode(data, dims, numClasses, vocabList) {
    // 定位类别轴：直接取"最大的非 batch 维"。
    // 不用 numClasses 硬匹配——词表去空行后 +1(=18384) 与模型实际类别数(18385) 差 1，
    // 硬匹配会失配；而类别数（万级）远大于时间步 T，取最大维稳定可靠。
    let cAxis = -1, maxDim = -1;
    for (let i = 0; i < dims.length; i++) if (dims[i] > 1 && dims[i] > maxDim) {
        maxDim = dims[i];
        cAxis = i;
    }
    // 时间轴 = 其余维度中长度 > 1 的那一个（batch 维恒为 1）
    let tAxis = -1;
    for (let i = 0; i < dims.length; i++) if (i !== cAxis && dims[i] > 1) {
        tAxis = i;
        break;
    }
    if (tAxis === -1) tAxis = dims.length - 1;
    const T = dims[tAxis], C = dims[cAxis];
    // 通用行优先线性索引
    const linIndex = (coord) => {
        let stride = 1, off = 0;
        for (let i = dims.length - 1; i >= 0; i--) {
            off += coord[i] * stride;
            stride *= dims[i];
        }
        return off;
    };
    const coord = new Array(dims.length).fill(0);
    const at = (cc, tt) => {
        coord[cAxis] = cc;
        coord[tAxis] = tt;
        return data[linIndex(coord)];
    };
    const blank = configUtils.blankIndex === 'first' ? 0 : (numClasses - 1);
    const toChar = (idx) => (configUtils.blankIndex === 'first' ? idx - 1 : idx);
    if (toChar(0) < 0 && configUtils.blankIndex === 'first') { /* noop */
    }
    let text = '', prev = -1;
    for (let t = 0; t < T; t++) {
        let best = -Infinity, bestIdx = 0;
        for (let c = 0; c < C; c++) {
            const v = at(c, t);
            if (v > best) {
                best = v;
                bestIdx = c;
            }
        }
        if (bestIdx !== blank && bestIdx !== prev) {
            const ci = toChar(bestIdx);
            if (ci >= 0 && ci < vocabList.length) text += vocabList[ci];
        }
        prev = bestIdx;
    }
    return text;
}

// =======================
// 预处理（sharp）：检测 / 识别 输入张量（CHW）
// =======================
async function preprocessDet(buf, limit) {
    const sharp = require('sharp');
    const meta = await sharp(buf).metadata();
    const ow = meta.width, oh = meta.height;
    const ratio = Math.min(limit / Math.max(ow, oh), 1);
    const nw = Math.max(1, Math.round(ow * ratio));
    const nh = Math.max(1, Math.round(oh * ratio));
    const inW = Math.max(32, Math.ceil(nw / 32) * 32); // 补到 32 倍数
    const inH = Math.max(32, Math.ceil(nh / 32) * 32);
    const raw = await sharp(buf).resize(inW, inH, {fit: 'fill'}).raw().toBuffer();
    const [m0, m1, m2] = configUtils.detMean, [s0, s1, s2] = configUtils.detStd;
    const out = new Float32Array(3 * inH * inW);
    for (let y = 0; y < inH; y++) for (let x = 0; x < inW; x++) {
        const hi = (y * inW + x) * 3, r = raw[hi], g = raw[hi + 1], b = raw[hi + 2];
        out[0 * inH * inW + y * inW + x] = (r / 255 - m0) / s0;
        out[1 * inH * inW + y * inW + x] = (g / 255 - m1) / s1;
        out[2 * inH * inW + y * inW + x] = (b / 255 - m2) / s2;
    }
    return {tensor: out, dims: [1, 3, inH, inW], ow, oh};
}

async function preprocessRec(buf, ow, oh, box, maxWidth) {
    const sharp = require('sharp');
    const x0 = Math.max(0, Math.min(ow - 1, box.x0));
    const y0 = Math.max(0, Math.min(oh - 1, box.y0));
    const x1 = Math.max(x0 + 1, Math.min(ow, box.x1));
    const y1 = Math.max(y0 + 1, Math.min(oh, box.y1));
    const w = x1 - x0, h = y1 - y0;
    const recH = 48;
    const recW = Math.min(Math.max(Math.round(recH * w / h), 10), maxWidth);
    const inW = Math.max(8, Math.ceil(recW / 8) * 8); // 补到 8 倍数
    const raw = await sharp(buf).extract({left: x0, top: y0, width: w, height: h})
        .resize(inW, recH, {fit: 'fill'}).raw().toBuffer();
    const [m0, m1, m2] = configUtils.recMean, [s0, s1, s2] = configUtils.recStd;
    const out = new Float32Array(3 * recH * inW);
    for (let y = 0; y < recH; y++) for (let x = 0; x < inW; x++) {
        const hi = (y * inW + x) * 3, r = raw[hi], g = raw[hi + 1], b = raw[hi + 2];
        // 通道顺序：PaddleOCR 用 cv2 读取 = BGR；sharp 默认输出 RGB。
        // 默认把 RGB 重排为 BGR 再喂模型（configUtils.recChannelOrder='bgr'）。
        const cr = configUtils.recChannelOrder === 'rgb' ? r : b;
        const cg = g;
        const cb = configUtils.recChannelOrder === 'rgb' ? b : r;
        out[0 * recH * inW + y * inW + x] = (cr / 255 - m0) / s0;
        out[1 * recH * inW + y * inW + x] = (cg / 255 - m1) / s1;
        out[2 * recH * inW + y * inW + x] = (cb / 255 - m2) / s2;
    }
    return {tensor: out, dims: [1, 3, recH, inW]};
}

// =======================
// 按需读图（stream 模式）：把输入节点的图片读成 Buffer
// =======================
/**
 * mode='stream' 时节点 content 为 null，用 node.stream()（Readable）逐块读入再合并为 Buffer；
 * 同时兼容 full 模式（content 已是 Buffer），避免规则被误用时直接报错。
 * @param {object} node 输入文件节点
 * @returns {Promise<Buffer>} 图片字节
 */
async function readImageBuffer(node) {
    if (Buffer.isBuffer(node.content)) return node.content;   // 兼容 full 模式
    if (typeof node.stream !== 'function') {
        throw new Error(`节点既无 content 也无 stream()，无法读取：${node.base}`);
    }
    const chunks = [];
    for await (const chunk of node.stream()) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    if (chunks.length === 0) throw new Error(`图片内容为空：${node.base}`);
    return Buffer.concat(chunks);
}

// =======================
// 主流程（异步生成器：模型文件经 yield 交给引擎落盘；每张图识别完立即 yield 该图产物）
// =======================
async function* writingRules(inputArray, outputNodeTemplate) {
    const imgFiles = inputArray.filter(item => IMAGE_EXTS.includes(item.normExt));
    if (imgFiles.length === 0) {
        yield [{...outputNodeTemplate, content: '错误: 未找到图片文件（' + IMAGE_EXTS.join('/') + '）'}];
        return;
    }

    const modelReady = yield* cloneAndPrepareModel(outputNodeTemplate);
    if (!modelReady) {
        yield [{...outputNodeTemplate, content: '错误: 模型准备失败'}];
        return;
    }

    // 模型本地绝对路径（写死，与 lfsFiles 一一对应；参照 txt2img 插件 paths 约定）
    const full = configUtils.getFullModelPath();
    const paths = {
        det: path.join(full, 'ppocr_v5_mobile/PP-OCRv5_mobile_det_infer.onnx'),// 文本检测（DB 概率图）
        rec: path.join(full, 'ppocr_v5_mobile/PP-OCRv5_mobile_rec_infer.onnx'),// 文本识别（SVTR + CTC）
        dict: path.join(full, 'ppocr_v5_mobile/ppocrv5_dict.txt')                // 中文词表（一行一字，blank=0）
    };

    let vocabList;
    try {
        vocabList = getVocab(paths.dict);
    } catch (e) {
        yield [{...outputNodeTemplate, content: '错误: ' + e.message}];
        return;
    }
    const numClasses = vocabList.length + 1; // + blank

    const detSession = await ort.InferenceSession.create(paths.det);
    const recSession = await ort.InferenceSession.create(paths.rec);

    for (const img of imgFiles) {
        const started = Date.now();
        const report = {image: img.base, ok: false, boxCount: 0, elapsedMs: 0, error: null};

        // stream 模式下 content 为 null：先按需读流拿到图片 Buffer（逐张用完即弃，不累积内存）
        let imgBuf;
        try {
            imgBuf = await readImageBuffer(img);
        } catch (e) {
            report.error = e.message;
            yield [{
                ...outputNodeTemplate,
                fileName: `${img.name}_ocr_report`,
                normExt: 'json',
                content: JSON.stringify(report, null, 2)
            }];
            console.error(`[ocr-paddleocrv5-stream] ${img.base} 读取失败: ${e.message}`);
            continue;
        }

        try {
            const det = await preprocessDet(imgBuf, configUtils.detLimit);
            const detOut = await detSession.run({[detSession.inputNames[0]]: new ort.Tensor('float32', det.tensor, det.dims)});
            const detScore = Object.values(detOut)[0];
            const sd = detScore.dims;
            const scoreW = sd[sd.length - 1], scoreH = sd[sd.length - 2];
            const boxes = boxesFromDet(detScore.data, scoreW, scoreH, det.ow, det.oh, configUtils.boxThreshold, configUtils.minBoxArea);

            const lines = [];
            for (const box of boxes) {
                const rec = await preprocessRec(imgBuf, det.ow, det.oh, box, configUtils.recMaxWidth);
                const recOut = await recSession.run({[recSession.inputNames[0]]: new ort.Tensor('float32', rec.tensor, rec.dims)});
                const rd = Object.values(recOut)[0];
                const text = ctcDecode(rd.data, rd.dims, numClasses, vocabList).trim();
                const cx = Math.round((box.x0 + box.x1) / 2), cy = Math.round((box.y0 + box.y1) / 2);
                lines.push({
                    text,
                    confidence: null,
                    x0: box.x0,
                    y0: box.y0,
                    x1: box.x1,
                    y1: box.y1,
                    cx,
                    cy,
                    w: box.x1 - box.x0,
                    h: box.y1 - box.y0
                });
            }

            report.ok = true;
            report.boxCount = lines.length;
            report.elapsedMs = Date.now() - started;
            const plain = lines.map(l => l.text).join('\n');
            // 一张图的 3 个产物一次性 yield：引擎对该批逐节点校验后立即落盘（不等全部图片跑完）
            yield [
                {...outputNodeTemplate, fileName: img.name, normExt: 'txt', content: plain},
                {
                    ...outputNodeTemplate,
                    fileName: `${img.name}_ocr_report`,
                    normExt: 'json',
                    content: JSON.stringify(report, null, 2)
                },
                {
                    ...outputNodeTemplate, fileName: `${img.name}_ocr_coords`, normExt: 'json',
                    content: JSON.stringify({
                        image: img.base, unit: 'px', origin: 'top-left', normExt: img.normExt,
                        model: 'PP-OCRv5-mobile (x3zvawq/paddleocr-js-onnx)', count: lines.length,
                        note: '坐标为图片像素空间（左上原点）；robotjs 按 screenX=cx*scale+offsetX 映射屏幕坐标。lines=检测框(文本+包围盒)',
                        words: [], lines
                    }, null, 2)
                }
            ];
            console.log(`[ocr-paddleocrv5-stream] ${img.base} 完成: ${lines.length} 框, 耗时 ${report.elapsedMs}ms`);
        } catch (e) {
            report.error = e.message;
            report.elapsedMs = Date.now() - started;
            yield [{
                ...outputNodeTemplate,
                fileName: `${img.name}_ocr_report`,
                normExt: 'json',
                content: JSON.stringify(report, null, 2)
            }];
            console.error(`[ocr-paddleocrv5-stream] ${img.base} 失败: ${e.message}`);
        }
    }
}

module.exports = {
    name: 'ocr2txt',
    version: '1.0.0',
    mode: 'stream', // 流式模式：输入不预读 content，规则内用 node.stream() 逐张读取；产出用 yield 逐批落盘
    process: writingRules,
    description: '基于飞桨 PP-OCRv5（ONNX, onnxruntime-node）的图片文字识别规则 · 流式 yield 版：mode=stream + async function*，每张图识别完立即 yield 该图的 txt/_ocr_report.json/_ocr_coords.json（引擎收到即落盘）；识别算法/模型/配置/输出 schema 与全量版 examples/ruleDir/rule-ocr.js 完全一致，下游 robotjs 规则可无缝切换',
    notes: {
        node: '>=18.20.4',
        engine: 'onnxruntime-node + sharp（本地 ONNX 推理，非 tesseract）',
        models: 'x3zvawq/paddleocr-js-onnx 的 ppocr_v5_mobile（det/rec/dict）',
        streaming: 'mode=stream + 异步生成器：输入逐张流式读取（单张 Buffer 驻留，不预载全部图片），输出每张图 yield 一批，边识别边落盘；中途中断已落盘部分不丢',
        fallback: 'lfs 后若文件 < 1KB（多为 LFS 指针占位），自动用 axios 从 HF 镜像下载：先收完流拼成 Buffer，再 yield 一个模型文件节点交给引擎落盘（节点 path 指向模型缓存目录）',
        tips: '需 Git + Git LFS 自动拉模型；若识别乱码，先用 Netron 核对 det/rec 输入名与输出形状，必要时调整归一化与 recMaxWidth',
        run: 'rule-process run -r examples/ruleDir/rule-ocr-stream.js -i examples/inputDir -o examples/outputDir'
    },
    error: {
        'model-download': {
            description: '模型下载失败（网络/镜像）',
            process: '切换 configUtils.mirrorUrl 或手动放置 det/rec/dict 到模型目录'
        },
        'vocab': {description: '词表缺失', process: '确保 lfs 已拉取 ppocrv5_dict.txt，或手动放置到模型目录'},
        'read-image': {
            description: 'stream 模式下读取图片流失败',
            process: '确认输入图片未损坏且可读；报告节点 <图>_ocr_report.json 内含 error 原因'
        },
        'decode-axis': {
            description: '无法从识别输出确定类别轴（模型结构与预期不符）',
            process: '用 Netron 查看 rec 输出维度，校正 numClasses 或 ctcDecode 的轴判定'
        }
    },
    input: {
        normExt: 'png、jpg、jpeg、bmp、webp、tiff、gif',
        description: '待识别图片，支持批量；stream 模式下逐张读取，不预载全部内容'
    },
    output: {
        normExt: 'txt、json',
        format: '每张图产出 <图片名>.txt（文本）、<图片名>_ocr_report.json（耗时/框数/错误）、<图片名>_ocr_coords.json（检测框文本+像素包围盒，供 robotjs）；每张图识别完立即落盘'
    },
    rely: {
        'onnxruntime-node': '1.23.2',
        'sharp': '0.34.5',
        'axios': '0.27.2'
    }
};
