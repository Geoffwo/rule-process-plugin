const { execSync, spawn } = require('child_process');

// 检查FFmpeg是否可用
function checkFFmpeg() {
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    return true;
  } catch (e) {
    console.log(e);
    return false;
  }
}

// 核心音频处理函数
function processAudioBuffer(inputBuffer) {
  return new Promise((resolve, reject) => {// 创建一个Promise对象，用于处理异步操作
    // 创建FFmpeg进程
    const ffmpeg = spawn('ffmpeg', [ // 使用spawn方法启动一个新的ffmpeg进程
      '-y',                 // 自动覆盖输出文件而不提示
      '-i', 'pipe:0',       // 指定输入来源为stdin(标准输入)
      '-ar', '16000',       // 设置音频采样率为16000Hz
      '-ac', '1',           // 设置音频声道数为1(单声道)
      '-f', 'wav',          // 指定输出格式为WAV
      'pipe:1'              // 指定输出目标为stdout(标准输出)
    ]);

    // 创建一个数组来收集输出数据块
    const outputChunks = [];

    //输出处理
    ffmpeg.stdout.on('data', chunk => outputChunks.push(chunk));// 监听FFmpeg标准输出(stdout)的数据事件 每当有数据块被输出时，将其推入outputChunks数组
    ffmpeg.stdout.on('end', () => {// 监听FFmpeg标准输出(stdout)的结束事件
      resolve(Buffer.concat(outputChunks));// 使用Buffer.concat将收集的所有数据块合并成一个Buffer
    });

    // 错误处理
    ffmpeg.on('error', reject);// 如果FFmpeg进程本身出错，调用reject返回错误
    ffmpeg.on('close', code => {// 当进程退出时，检查退出代码，非0表示处理失败
      if (code !== 0) reject(new Error(`FFmpeg 异常关闭, code ${code}`));
    });

    // 输入处理
    ffmpeg.stdin.write(inputBuffer);// 将输入数据(Buffer)写入FFmpeg的标准输入(stdin)
    ffmpeg.stdin.end();// 结束输入流，通知FFmpeg数据已全部写入
  });
}

async function writingRules(inputArray, outputNodeTemplate) {
  // console.log(inputArray);

  // 筛选所有wav/mp3文件并保留完整文件信息
  const audioFiles = inputArray.filter(info =>
      info.path.endsWith('.wav') || info.path.endsWith('.mp3')
  );

  if (!checkFFmpeg()) {
    return [{...outputNodeTemplate, content: '错误: 系统中未找到FFmpeg指令。\n 1. 请从 https://ffmpeg.org 下载（windows推荐ffmpeg-release-full.7z）\n 2.解压缩安装FFmpeg（需配置bin到环境变量）\n 3.配置环境变量后，需要重启以更新状态'}];
  }

  // 如果没有找到音频文件
  if (audioFiles.length === 0) {
    return [{...outputNodeTemplate, content: '错误: 未找到WAV音频文件'}];
  }

  const result = []
  for (const file of audioFiles) {//可以用await Promise.all()并发替代
    // 使用ffmpeg转换音频格式为16kHz单声道WAV
    const processedBuffer = await processAudioBuffer(file.content);
    result.push({...outputNodeTemplate,fileName: `p-${file.name}`,normExt: 'wav',content: processedBuffer});
  }

  // 返回结果对象
  return result;
}

// module.exports = writingRules;

// 修正后的导出配置
module.exports = {
  name: 'audio2wav',
  version: '1.0.0',
  process: writingRules,
  description: '音频处理工具：扫描目录中的WAV/MP3文件，自动转换为16kHz单声道WAV格式，用于离线音频转文字'
};