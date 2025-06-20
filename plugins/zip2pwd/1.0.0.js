const AdmZip = require('adm-zip'); // 引入zip文件处理库

// 递归查找ZIP中第一个文件条目（跳过目录）
function findFirstFileEntry(entries) {
  for (const entry of entries) {
    if (!entry.isDirectory) {
      return entry;
    }
  }
  return null;
}

// 密码生成器，支持多种来源
function* passwordGenerator() {
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

// 主处理函数，接收输入数组和输出模板
function writingRules(inputArray, outputNodeTemplate) {
  let results = []; // 存储处理结果的数组

  // 过滤出zip文件
  const zipFiles = inputArray.filter(item => item.normExt === 'zip');

  // 遍历输入数组中的每个元素
  for (const input of zipFiles) {
    const zipPath = input.path
    const zip = new AdmZip(zipPath); // 创建AdmZip实例，传入ZIP文件路径
    const entries = zip.getEntries(); // 获取ZIP文件中的所有条目(文件)列表

    if (entries.length === 0) {
      results.push({file: zipPath, password: null, msg: 'ZIP文件内无内容'});
      continue;
    }

    // 查找第一个有效文件
    const firstEntry = findFirstFileEntry(entries);
    if (!firstEntry) {
      results.push({file: zipPath, password: null, msg: '未找到文件条目（仅有目录）'});
      continue;
    }

    // const firstEntry = entries[0];//如果是目录，会异常，找到文件
    const isEncrypted = firstEntry.header.flags & 1;
    if (!isEncrypted) {
      results.push({file: zipPath, password: null, msg: '文件未加密'});
      continue;
    }

    // 判断加密方式
    const compressionMethod = firstEntry.header.method;
    if (compressionMethod === 99) { // 99 代表 AES 加密
      results.push({file: zipPath, password: null, msg: '文件使用AES加密，adm-zip不支持解密'});
      continue;
    }

    // 优化后的密码尝试逻辑
    let found = null;
    let step = 0;
    // 遍历常见密码列表尝试解压
    for (const pwd of passwordGenerator()) {
      step++;
      try {
        firstEntry.getData(pwd);// 尝试用当前密码(pwd)解压第一个文件,解码失败直接跳转到异常
        found = pwd;
        break;
      } catch (e) {
        // 当前密码错误，继续尝试下一个
      }
      //process.stdout.write 输出内容时，都会覆盖当前行之前的内容
      process.stdout.write(`\r正在尝试第${step}个密码...`);//\r 是回车符，会把光标移动到当前行的开头，不会换行
    }
    process.stdout.write(`\n`);
    results.push({file: zipPath, password: found, msg: `基于当前内置密码，文件解密${found?'成功':'失败'}`});
  }

  const outputNode = outputNodeTemplate; // 获取输出模板
  // 设置输出内容为格式化后的结果JSON
  outputNode.content = JSON.stringify(results, null, 2);
  return [outputNode]; // 返回包含输出节点的数组
}

// module.exports = writingRules; // 导出主处理函数

module.exports = {
  name: 'zip2pwd',
  version: '1.0.0',
  process: writingRules,
  description:'主要用于处理ZIP文件，支持基本的加密（ZipCrypto），但不支持AES加密。'
};