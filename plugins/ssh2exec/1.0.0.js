const { Client } = require("ssh2");
const path = require("path");

/**
 * 延迟函数
 * @param {number} ms 延迟毫秒数
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 上下文数据提取工具
 * @param {string} resp 命令输出内容
 * @param {Object} extractMap 提取映射配置
 * @param {Object} targetCtx 目标上下文对象
 */
function extractCtxData(resp, extractMap = {}, targetCtx) {
  for (const [ctxKey, pathStr] of Object.entries(extractMap)) {
    const pathArr = pathStr.split('.');
    let val = resp;
    for (const p of pathArr) {
      val = val && val[p];
      if (val === undefined || val === null) break;
    }
    targetCtx[ctxKey] = val || '';
  }
}

/**
 * 模板渲染：将 {{key}} 替换为上下文对应字段
 * 支持字符串、数组、对象递归渲染，自动转义Shell特殊字符
 * @param {string|Array|Object} template 原始模板
 * @param {Object} data 上下文数据
 * @returns {string|Array|Object} 渲染后内容
 */
function renderTemplate(template, data) {
  if (typeof template === 'string') {
    return template.replace(/\{\{(.+?)\}\}/gs, (_, col) => {
      let val = data[col.trim()] ?? '';
      val = val.replace(/"/g, '\\"');
      val = val.replace(/\n/g, '\\n');
      return val;
    });
  }

  if (Array.isArray(template)) {
    return template.map(item => renderTemplate(item, data));
  }

  if (template !== null && typeof template === 'object') {
    const newObj = {};
    for (const key of Object.keys(template)) {
      newObj[key] = renderTemplate(template[key], data);
    }
    return newObj;
  }

  return template;
}

/**
 * 【核心：纯文件上传】仅实现 本地文件 -> 远程路径 上传
 * @param {Object} sshConfig SSH配置
 * @param {string} localPath 本地文件绝对路径
 * @param {string} remotePath 远程完整文件路径
 * @returns {Promise<string>}
 */
function uploadFile(sshConfig, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on("error", err => {
      conn.end();
      reject(err);
    });

    conn.on("ready", () => {
      conn.sftp((err, sftp) => {
        if (err) {
          conn.end();
          return reject(err);
        }
        // 自动创建远程上级目录
        const remoteDir = path.posix.dirname(remotePath);
        sftp.mkdir(remoteDir, { recursive: true }, () => {
          // 执行上传
          sftp.fastPut(localPath, remotePath, (putErr) => {
            conn.end();
            if (putErr) {
              reject(putErr);
            } else {
              resolve(`文件上传成功：${localPath} => ${remotePath}`);
            }
          });
        });
      });
    });
    conn.connect(sshConfig);
  });
}

/**
 * 执行远程SSH命令，支持流式实时输出、超时终止
 * @param {Object} sshConfig
 * @param {string} sudoPwd
 * @param {string} workDir
 * @param {string} cmd
 * @param {number} timeout 超时毫秒，默认30秒
 * @returns {Promise<{output:string, error:string}>}
 */
function runRemoteCmd(sshConfig, sudoPwd, workDir, cmd, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let output = "";
    let error = "";
    let timer = null;

    // 重置空闲计时器
    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        conn.end();
        resolve({
          output: output + "\n[提示] 30s内无日志输出，主动断开连接",
          error: error
        });
      }, timeout);
    };

    const fullCmd = `cd "${workDir}" && echo ${sudoPwd} | sudo -S -p '' ${cmd}`;
    resetTimer(); // 首次启动计时

    conn.on("error", (err) => {
      clearTimeout(timer);
      conn.end();
      reject(err);
    });

    conn.on("ready", () => {
      conn.exec(fullCmd, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          conn.end();
          return reject(err);
        }

        stream.on("data", (chunk) => {
          const text = chunk.toString();
          output += text;
          process.stdout.write(text);
          resetTimer(); // 有新数据 → 重置空闲计时
        });

        stream.stderr.on("data", (chunk) => {
          const text = chunk.toString();
          error += text;
          process.stderr.write(text);
          resetTimer(); // 错误输出也续期
        });

        stream.on("close", () => {
          clearTimeout(timer);
          conn.end();
          resolve({ output, error });
        });
      });
    });

    conn.connect(sshConfig);
  });
}

function createJsonTemplate() {
  return {
    env: {
      ssh: {
        host: "服务器地址",// 10.xx.xx.xx
        port: 22,//服务器端口号 22
        username: "普通用户名",//user
        password: "普通用户名密码"//pwd1
      },
      rootPwd: "root密码",//pwd2（切换到root权限）
      serverDir: "指令操作目录",// /home/xxx

      jarName: "jar包名称",//xxx.jar
      localPath: "本地jar包地址",//C:\xxx\xxx.jar
      remotePath: "服务器jar包地址",// /xxx/xxx.jar
      LOG_FILE: "日志文件",// log/xxx.log
    },
    steps: [
      // 1. 停止服务
      {
        "stepName": "停止服务",
        "cmd": "./stop.sh"
      },
      // 2. 旧包重命名归档
      {
        "stepName": "归档旧Jar",
        "cmd": "mv {{jarName}} {{jarName}}.bak.$(date +%Y%m%d%H%M%S)"
      },
      // 3. 上传新Jar包
      {
        "stepName": "上传新Jar包",
        "once": true,
        "cmd": "UPLOAD_FILE {{localPath}} {{remotePath}}"
      },
      // 4. 添加执行权限
      {
        "stepName": "添加执行权限",
        "cmd": "chmod +x *.jar"
      },
      // 5. 启动服务
      {
        "stepName": "启动服务",
        "cmd": "./start.sh"
      },
      // 6. 日志打印
      {
        "stepName": "日志打印",
        "cmd": "tail -f {{LOG_FILE}}"
      }
    ]
  };
}

/**
 * 插件主处理入口
 * @param {Array} inputArray 上游输入文件数组
 * @param {Object} outputNodeTemplate 输出节点模板
 * @returns {Array<Object>} 输出文件列表
 */
async function writingRules(inputArray, outputNodeTemplate) {
  const outputDir = outputNodeTemplate.path// 临时目录绝对路径
  const inputPath = path.join (outputDir, '../inputDir');

  const configFile = inputArray.find(item => item.normExt === 'json' && item.name === 'config');
  if (!configFile) {
    const jsonTemplate = createJsonTemplate();
    return [
      { ...outputNodeTemplate, content: '错误: 未找到 config.json 文件,示例文件已创建' },
      {...outputNodeTemplate, path: inputPath, fileName: 'config',normExt:'json', content: JSON.stringify(jsonTemplate, null, 2)}
    ];
  }

  const config = JSON.parse(configFile.content);
  const { env, steps } = config;
  const executedOnce = new Set();
  const sharedCtx = { ...env };

  let success = true;
  let errorMsg = "";

  try {
    // 循环执行所有步骤
    for (const step of steps) {
      const { stepName, once = false, cmd, extractCtx = {} } = step;

      if (once === true && executedOnce.has(stepName)) {
        console.log(`跳过步骤：${stepName}`);
        continue;
      }

      console.log(`执行步骤：${stepName}`);

      const CUSTOM_CMD_LIST = [
        "UPLOAD_FILE"
      ];
      let isCustomCmd = false;

      // ========== 关键修复：所有指令先统一做模板渲染 ==========
      const renderedCmd = renderTemplate(cmd, sharedCtx);

      // 遍历指令清单匹配
      for (const cmdPrefix of CUSTOM_CMD_LIST) {
        if (renderedCmd.startsWith(`${cmdPrefix} `)) {
          isCustomCmd = true;
          if (cmdPrefix === "UPLOAD_FILE") {
            const [_, localFile, remoteFile] = renderedCmd.split(" ");
            // 使用统一上下文 ssh 配置
            const uploadLog = await uploadFile(sharedCtx.ssh, localFile, remoteFile);
            console.log(`[上传]\n${uploadLog}`);
          }
          break;
        }
      }

      // 非自定义指令：走普通 SSH 命令
      if (!isCustomCmd) {
        const res = await runRemoteCmd(sharedCtx.ssh, sharedCtx.rootPwd, sharedCtx.serverDir, renderedCmd);
        console.log(`[输出]\n${res.output}`);

        if (Object.keys(extractCtx).length) {
          extractCtxData(res.output, extractCtx, sharedCtx);
        }
      }

      if (once === true) {
        executedOnce.add(stepName);
      }

      await sleep(500);
    }

    console.log("\n所有步骤执行完毕");
  } catch (e) {
    success = false;
    errorMsg = e.message;
    console.error(`执行异常：${e.message}`);
  }

  // 组装输出内容
  const contents = {
    pluginName: "ssh-exec",
    runTime: new Date().toLocaleString(),
    success: success,
    errorMessage: errorMsg
  };

  return [{
    ...outputNodeTemplate,
    fileName: "ssh_exec_result",
    normExt: "json",
    content: JSON.stringify(contents, null, 2)
  }];
}

// 插件标准导出（对齐范例结构）
module.exports = {
  name: 'ssh2exec',
  version: '1.0.0',
  process: writingRules,
  description: 'SSH远程命令执行插件，支持多步骤、once单次执行、模板渲染、上下文提取',
  notes: {
    node: '18.20.4'
  },
  input: {
    normExt: 'json配置文件',
  },
  output: {
    normExt: 'json',
  },
  rely: {
    'ssh2': '1.15.0'
  },
};