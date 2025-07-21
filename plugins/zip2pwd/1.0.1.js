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

// 批量获取n个密码
function getNextPwds(pwdGen, concurrency) {
  const pwds = [];
  for (let i = 0; i < concurrency; i++) {
    const { value, done } = pwdGen.next();
    if (done) break;
    pwds.push(value);
  }
  return pwds;
}

// 主处理函数，接收输入数组和输出模板
async function writingRules(inputArray, outputNodeTemplate) {
  let results = []; // 存储处理结果的数组

  // 过滤出zip文件
  const zipFiles = inputArray.filter(item => item.normExt === 'zip');

  // 遍历输入数组中的每个元素
  for (const input of zipFiles) {
    const zipPath = input.path
    const zip = new AdmZip(zipPath); // 创建AdmZip实例，传入ZIP文件路径
    const entries = zip.getEntries(); // 获取ZIP文件中的所有条目(文件)列表

    if (entries.length === 0) {// 判断是否有内容
      results.push({file: zipPath, password: null, msg: 'ZIP文件内无内容'});
      continue;
    }

    // 查找第一个有效文件
    const firstEntry = findFirstFileEntry(entries);
    if (!firstEntry) {
      results.push({file: zipPath, password: null, msg: '未找到文件条目（仅有目录）'});
      continue;
    }

    // const firstEntry = entries[0];//获取第一个文件
    const isEncrypted = firstEntry.header.flags & 1;// 判断是否加密
    if (!isEncrypted) {
      results.push({file: zipPath, password: null, msg: '文件未加密'});
      continue;
    }

    const compressionMethod = firstEntry.header.method;// 判断加密方式
    if (compressionMethod === 99) { // 99 代表 AES 加密
      results.push({file: zipPath, password: null, msg: '文件使用AES加密，adm-zip不支持解密'});
      continue;
    }

    // 优化后的密码尝试逻辑
    let found = null;
    let step = 1;
    const concurrency = 101 //最大并发数
    const pwdGen = pwdGenerator()
    //循环进行密码破解
    while (!found) {
      const pwds = getNextPwds(pwdGen, concurrency);
      if (pwds.length === 0) break;//密码查完了，结束循环

      process.stdout.write(`\r正在尝试第${step}个密码...`);
      step += pwds.length;

      // 并发尝试 本批密码
      const tryPwd = await Promise.all(//等待所有异步结束，Promise.all 需要的是一个 Promise 数组
          pwds.map(pwd => new Promise(resolve => {//进行伪异步
            setImmediate(() => { //让主线程在每个解密操作之间，有机会清理内存，保证性能
              try {
                // 尝试用当前密码(pwd)解压第一个文件,解码失败直接跳转到异常
                firstEntry.getData(pwd);//同步方法，在同一事件循环while中，每个密码尝试会 阻塞事件循环 直到完成
                resolve(pwd); // 成功返回密码
              } catch (e) {
                resolve(null); // 失败返回null
              }
            })
          }))
      )

      found = tryPwd.find(pwd => pwd !== null) || null;
      if (found) break;
    }
    process.stdout.write(`\n`);
    results.push({file: zipPath, password: found, msg: `基于当前内置密码，文件解密${found ? '成功' : '失败'}`});
  }

  const outputNode = outputNodeTemplate; // 获取输出模板
  // 设置输出内容为格式化后的结果JSON
  outputNode.content = JSON.stringify(results, null, 2);
  return [outputNode]; // 返回包含输出节点的数组
}

// module.exports = writingRules; // 导出主处理函数

module.exports = {
  name: 'zip2pwd',
  version: '1.0.1',
  process: writingRules,
  description:'主要用于处理ZIP文件，支持破解基本的加密，但不支持破解AES加密。增加伪异步并发(时间轮询)，提高查询速度。',
  notes:{
    node:'14.18.0',
  },
  input: {
    normExt: 'zip文件'
  },
  output: {
    normExt: 'json文件',
    format: "[{file: 压缩包路径, password: 密码, msg: 描述}]"
  },
  rely:{//默认 latest
    'adm-zip': '0.5.16'
  }
};