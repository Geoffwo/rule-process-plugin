const { spawnSync, spawn} = require('child_process');
const os = require('os');

// 获取系统安装的语音引擎列表
function listVoices() {
  const command = `
    # 加载 System.Speech 程序集（Windows语音API的核心库）
    Add-Type -AssemblyName System.Speech
    
    # 创建语音合成器对象实例
    $speak = New-Object System.Speech.Synthesis.SpeechSynthesizer
    
    # 遍历获取所有已安装语音的名称
    $speak.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }
  `;
  try {
    // 执行 PowerShell 命令
    const {stdout,stderr} = spawnSync(`powershell`,[
      '-NoProfile',// 不加载用户配置文件，加快执行速度
      '-Command', // 指定直接执行命令
      command
    ], {encoding: 'utf-8'});// 指定输出编码为UTF-8

    // 调试信息输出
    if (stdout) console.log('[PowerShell输出]', stdout);
    if (stderr) console.warn('[PowerShell错误]', stderr);

    console.log(stdout.trim().split('\r\n').filter(Boolean));

    // 处理返回结果： 1. 去除首尾空白 2. 按Windows换行符分割(\r\n) 3. 过滤掉空行
    return stdout;
  } catch (error) {
    return `获取语音列表失败:${error.message}`
  }
}

/**
 * 使用 Windows 内置 SAPI5 引擎进行文本转语音
 * 参数说明：
 *   text - 要转换为语音的文本内容
 *   options - 配置选项
 *     outputFile: 生成的WAV音频文件路径(必需)
 *     voice: 语音引擎名称(默认'Huihui'中文语音)
 *     rate: 语速(-10到+10，0为正常语速)
 *     volume: 音量(0-100)
 */
function speakWithSAPI(text, options = {}) {
  const {
    outputFile = null,// 输出文件必须指定
    voice = 'Microsoft Huihui Desktop',// 默认中文语音
    rate = 0,// 默认正常语速
    volume = 100 // 默认最大音量
  } = options;

  // 安全处理单引号（PowerShell转义）,单引号转义为两个单引号是PowerShell的语法要求
  const escapedText = text.replace(/'/g, "''");

  // 构建完整的PowerShell语音合成命令：
  const command = `
    # 加载语音合成核心库
    Add-Type -AssemblyName System.Speech
    
    # 创建语音合成器实例
    $speak = New-Object System.Speech.Synthesis.SpeechSynthesizer
    
    # 选择指定的语音引擎
    $speak.SelectVoice('${voice}')
    
    # 设置语速（-10最慢，10最快）
    $speak.Rate = ${rate}
    
    # 设置音量（0-100）
    $speak.Volume = ${volume}
    
    # 设置输出到WAV文件
    $speak.SetOutputToWaveFile('${outputFile}')
    
    # 执行文本到语音的转换
    $speak.Speak('${escapedText}')
    
    # 重置输出到默认音频设备（避免影响后续语音播放）
    $speak.SetOutputToDefaultAudioDevice() 
    
    # 释放语音合成器资源
    $speak.Dispose()
  `;

  // 使用 PowerShell 执行构建好的命令
  try {
    const { stdout, stderr } = spawnSync('powershell', [
      '-NoProfile',       // 不加载 PowerShell 配置文件，提高执行速度
      '-NonInteractive',  // 非交互模式运行
      '-Command',         // 指定要执行的命令
      command             // 传入构建好的脚本
    ], {encoding: 'utf-8'});// 指定输出编码为UTF-8

    // 调试信息输出
    if (stdout) console.log('[PowerShell输出]', stdout);
    if (stderr) console.warn('[PowerShell错误]', stderr);

    return { success: true, message: '语音合成执行完成' };
  } catch (error) {
    // 捕获并处理执行过程中的错误
    // throw new Error(`语音合成失败: ${error.message}`);
    return { success: false, message: '语音合成执行失败',error };
  }
}

function writingRules(inputArray, outputNodeTemplate) {
  // 检查操作系统是否为Windows
  if (os.platform() !== 'win32') {
    return [{
      ...outputNodeTemplate,
      content: '错误: 此功能仅支持Windows操作系统'
    }];
  }

  // 过滤出文本内容
  const txtFiles = inputArray.filter(info => info.path.endsWith('.txt'));//可以自定义一个专属后缀

  if (txtFiles.length === 0) {
    return [{
      ...outputNodeTemplate,
      content: '错误: 未找到有效的文本内容。请提供.txt文件。'
    }];
  }

  const result = []
  // 获取可用语音引擎列表
  const voices = listVoices();
  result.push({...outputNodeTemplate,fileName:'voicesList',content: `系统安装的语音引擎: \n${voices}`})

  const contents = []
  for (const file of txtFiles) {
    //定义wav输出路径地址
    const outputFile = `${outputNodeTemplate.path}\\${file.name}.wav`
    // 执行文本到语音转换
    const content = speakWithSAPI(file.content,{outputFile});
    contents.push({fileName:file.name,...content})
  }
  result.push({...outputNodeTemplate,fileName:'voicesResult',content: JSON.stringify(contents)})
  return result;
}

// module.exports = writingRules; // 导出主处理函数

module.exports = {
  name: 'txt2audio',
  version: '1.1.0',
  process: writingRules,
  description:'离线文本文件转语音插件，使用SAPI5引擎将TXT文件合成为WAV语音文件，仅Windows系统可用，拟真度较高，开源，可商用。',
  notes:{
    node: '14.18.0',
    os: 'Windows 7或更高版本',
    framework: '.NET Framework 3.0+',
    powershell: '5.1.19'
  }
};