const { spawnSync } = require('child_process'); // 改为同步方法
function checkEspeakNg() {
  try {
    spawnSync('espeak-ng --version', { stdio: 'pipe' });
    return true;
  } catch (e) {
    console.log(e)
    return false;
  }
}

async function writingRules(inputArray, outputNodeTemplate) {
  // 检查espeak-ng
  if (!checkEspeakNg()) {
    return [{
      ...outputNodeTemplate,
      content: `错误: 系统中未找到espeak-ng。\n` +
          `1. Ubuntu/Debian: sudo apt-get install espeak-ng\n` +
          `2. macOS: brew install espeak\n` +
          `3. Windows: 下载 https://github.com/espeak-ng/espeak-ng/releases\n` +
          `   Windows自定义安装: msiexec /i espeak-ng.msi INSTALLDIR="安装目录"\n` +
          `   espeak-ng -v zh -f file.txt //中文声音正常，命令行存在编码问题\n`
    }];
  }

  // 过滤文本文件
  const txtFiles = inputArray.filter(item => item.normExt === 'txt');

  if (txtFiles.length === 0) {
    return [{
      ...outputNodeTemplate,
      content: '错误: 未找到有效的文本文件。请提供.txt文件。'
    }];
  }

  const contents=[]
  for (const file of txtFiles) {
    try {
      const inputPath = file.path;
      const fileName = file.name;
      const outputPath = outputNodeTemplate.path
      const outputFilePath=`${outputPath}\\${fileName}.wav`

      // 同步执行语音合成
      spawnSync('espeak-ng', [
        '-v', 'zh',       // 中文发音 zh-yue粤语
        '-s', '180',      // 语速
        '-p', '40',       // 音高
        '-a', '200',      // 音量
        '-w', outputFilePath,  // 输出路径
        // `"${file.content}"`    // 直接使用文本内容，中文声音异常
        '-f', inputPath,  // 使用文件路径避免编码问题
      ]);

      // 成功节点
      contents.push({fileName:file.name,msg:'语音合成成功',outputFilePath});
    } catch (error) {
      console.log(error)
      // 错误节点
      contents.push({fileName:file.name,msg:'语音合成失败',error});
    }
  }

  return [{...outputNodeTemplate, content: JSON.stringify(contents)}];
}

// module.exports = writingRules;

module.exports = {
  name: 'txt2audio',
  version: '1.0.0',
  process: writingRules,
  description:'离线文本文件转语音插件，使用espeak-ng将TXT文件合成为WAV语音文件，机械度较高，开源，可商用。',
  notes:{
    node: '14.18.0',
    "espeak-ng": '1.52.0'
  },
  input: {
    normExt: 'txt文件'
  },
  output: {
    normExt: 'wav文件、json文件',
    format: "导出音频和son记录数据结果"
  },
};