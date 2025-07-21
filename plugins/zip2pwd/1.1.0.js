const { execSync, spawn } = require('child_process');

// 检查7z工具是否可用
function check7z() {
  try {
    execSync(`7z -h`, { stdio: 'ignore' });
    return true;
  } catch (e) {
    console.error('7z工具检查失败:', e);
    return false;
  }
}

// 密码生成器，支持多种来源
function* pwdGenerator() {
  // 1. 内置常见密码，使用循环生成
  const commonPasswords = [
    '123456', 'password', 'admin', '111111', '123123','776655',
    'abc123', '654321', '56487', 'qwerty', 'test', '000000'
  ];

  for (let i = 0; i < commonPasswords.length; i++) {
    yield commonPasswords[i];
  }
  // 2. 循环生成1-100000的数字密码
  for (let i = 1; i <= 1000000; i++) {
    yield i.toString();
  }
  // 3. 假设从文件读取（同步示例，实际可用fs.readFileSync等）
  // const fs = require('fs');
  // let filePasswords = fs.readFileSync('passwords.txt', 'utf-8').split('\n');
  // yield* filePasswords;

  // 4. 其他来源（如数据库、API等），这里只是示例
  // yield* getPasswordsFromDB();
  // yield* getPasswordsFromAPI();
}

// 尝试用指定密码解压7z文件
async function tryExtractZip(filePath, password,outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      'x',                    // 解压命令
      '-y',                   // 所有询问都回答"是"
      `-p${password}`,        // 设置密码
      `-o${outputPath}`,         // 指定输出目录
      filePath                // 要解压的文件路径
    ];

    const process = spawn('7z', args, {
      stdio: 'pipe'
    });

    let stderr = '';
    let stdout = '';

    process.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    process.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    process.on('close', (code) => {
      // 检查解压成功的标志
      const isSuccess = (
          code === 0 &&
          !stderr.includes('Wrong password') &&
          !stderr.includes('错误的密码') &&
          !stderr.includes('Incorrect password')
      );

      if (isSuccess) {
        resolve(password);
      } else {
        reject(new Error('密码错误或解压失败'));
      }
    });

    process.on('error', (err) => {
      reject(err);
    });
  });
}

// 主处理函数
async function writingRules(inputArray, outputNodeTemplate) {
  // 过滤出7z文件
  const zipFiles = inputArray.filter(item => ['7z','zip'].includes(item.normExt));

  if (!check7z()) {
    return [{
      ...outputNodeTemplate,
      content: '错误: 系统中未找到7z指令。\n' +
          '1. 请从 https://www.7-zip.org 下载并安装\n' +
          '2. 配置7z到系统环境变量\n' +
          '3. 配置后可能需要重启以更新环境变量'
    }];
  }

  if (zipFiles.length === 0) {
    return [{...outputNodeTemplate, content: '错误: 未找到压缩文件'}];
  }

  const contents = [];
  for (const file of zipFiles) {
    const filePath = file.path;
    const fileName = file.name;
    const outputPath = outputNodeTemplate.path;

    console.log(`开始破解: ${fileName}`);
    let foundPassword = null;
    let step = 0;

    // 遍历密码生成器
    for (const password of pwdGenerator()) {
      step++;
      process.stdout.write('\r\x1B[K');// 使用 ANSI 转义序列： \r: 回车到行首 \x1B[K: 清除从光标到行尾的内容
      process.stdout.write(`\r正在尝试第${step}个密码: ${password}`);

      try {
        // 尝试用当前密码解压
        await tryExtractZip(filePath, password, outputPath);
        foundPassword = password;
        break;
      } catch (e) {
        // 密码错误，继续尝试下一个
      }
    }

    process.stdout.write(`\n`);

    contents.push({
      file: fileName,
      password: foundPassword
    });
  }

  return [{...outputNodeTemplate,fileName: '7z_pwd',normExt: 'json',content: JSON.stringify(contents,null,2)}]
}

// module.exports = writingRules; // 导出主处理函数


module.exports = {
  name: 'zip2pwd',
  version: '1.1.0',
  process: writingRules, // 主处理函数
  description: '用于处理加密压缩文件，使用7z命令行工具，支持使用常见密码和数字密码组合尝试破解。',
  notes: {
    node: '14.18.0',
    '7z': '24.08'
  },
  input: {
    normExt: 'zip文件'
  },
  output: {
    normExt: 'json文件+解压缩的文件',
    format: "[{file: 压缩包路径, password: 密码, msg: 描述}]"
  },
};