const xlsx = require('xlsx');
const axios = require("axios");
const crypto = require('crypto');
const path = require("path");

function readExcel(file,sheet) {
  // 1. 读取工作簿（启用公式计算）
  const workbook = xlsx.readFile(file.path);

  const sheetToRead = sheet || workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetToRead];

  if (!worksheet) {
    throw new Error(`工作表 "${sheetToRead}" 不存在，可用工作表: ${workbook.SheetNames.join(', ')}`);
  }

  // 3. 返回结构化结果
  return xlsx.utils.sheet_to_json(worksheet);
}

/**
 * 延迟函数
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// [1.1.0新增] RSA密码加密，与前端 rsaPsw() 逻辑一致: Base64(明文) -> RSA加密 -> Base64(密文)
const RSA_PUBLIC_KEY = [
  '-----BEGIN PUBLIC KEY-----',
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArq9XTUSeYr2+N1h3Afl/',
  'z8Dse/2yD0ZGrKwx+EEEcdsBLca9Ynmx3nIB5obmLlSfmskLpBo0UACBmB5rEjBp',
  '2Q2f3AG3Hjd4B+gNCG6BDaawuDlgANIhGnaTLrIqWrrcm4EMzJOnAOI1fgzJRsOO',
  'UEfaS318Eq9OVO3apEyCCt0lOQK6PuksduOjVxtltDav+guVAA068NrPYmRNabVK',
  'RNLJpL8w4D44sfth5RvZ3q9t+6RTArpEtc5sh5ChzvqPOzKGMXW83C95TxmXqpbK',
  '6olN4RevSfVjEAgCydH6HN6OhtOQEcnrU97r9H0iZOWwbw3pVrZiUkuRD1R56Wzs',
  '2wIDAQAB',
  '-----END PUBLIC KEY-----',
].join('\n');

/**
 * RSA加密密码，对齐前端rsaPsw
 * 1.明文base64 2.RSA-PKCS1 3.密文base64
 */
function rsaPsw(password) {
  const passwordBase64 = Buffer.from(password, 'utf-8').toString('base64');
  const encryptedBuf = crypto.publicEncrypt(
      {
        key: RSA_PUBLIC_KEY,
        padding: crypto.constants.RSA_PKCS1_PADDING,
        passphrase: 'Welcome',
      },
      Buffer.from(passwordBase64, 'utf-8')
  );
  return encryptedBuf.toString('base64');
}

// 提取上下文工具
function extractCtxData(resp, extractMap={}, targetCtx) {
  for (const [ctxKey, path] of Object.entries(extractMap)) {
    // 按 . 分割路径，递归取值
    const pathArr = path.split('.');
    let val = resp;
    for (const p of pathArr) {
      val = val && val[p];
      if (val === undefined || val === null) break;
    }
    targetCtx[ctxKey] = val || '';
  }
}

// ---------- 模板渲染：将 {{key}} 替换为行数据对应字段 ----------
function renderTemplate(template, data) {
  //template {"archiveId": "{{id}}","name": "{{姓名}}","type": "{{类型}}","status": "active"}
  //data { "id": "1001", "姓名": "张三", "类型": "个人" }

  //如果是字符串 进行正则元数据捕获
  if (typeof template === 'string') {
    return template.replace(/\{\{(.+?)\}\}/g, (_, col) => data[col.trim()] ?? '');
  }

  //如果是数组 逐项递归
  if (Array.isArray(template)) {
    return template.map(item => renderTemplate(item, data));
  }

  //如果是对象
  if (template !== null && typeof template === 'object') {
    const newObj = {};
    //遍历对象每一个的属性，进行值替换
    for (const key of Object.keys(template)) {
      //设置属性名和对应的实际值
      newObj[key] = renderTemplate(template[key], data);//触发【递归-字符串】判断
    }
    return newObj;
  }
  return template;
}

function createJsonTemplate(){
  return {
    "delay": 300,
    "steps": [
      {
        "stepName": "系统登录",
        "once": true,
        "url": "http://10.24.20.167:18080/api/v1/auth/login",
        "method": "POST",
        "headers": {
          "Content-Type": "application/json"
        },
        "body": {
          "email": "ragflow@dareway.com.cn",
          "password": "Dareway@2026"
        },
        "passwordEncrypt": [
          "password"
        ],
        "extractCtx": {
          "id": "data.data.id"
        }
      },
      {
        "stepName": "用户登录",
        "url": "http://10.24.20.167:18080/api/v1/auth/login",
        "method": "POST",
        "headers": {
          "Content-Type": "application/json"
        },
        "body": {
          "email": "{{email}}",
          "password": "{{password}}"
        },
        "passwordEncrypt": [
          "password"
        ],
        "extractCtx": {
          "token": "headers.authorization"
        }
      },
      {
        "stepName": "用户同意邀请",
        "url": "http://10.24.20.167:18080/api/v1/tenants/{{id}}",
        "method": "PATCH",
        "headers": {
          "Content-Type": "application/json",
          "Authorization": "{{token}}"
        }
      }
    ]
  }
}

function createXlsxTemplate(outputPath){
  // 定义列名，与 config.json 中 body 里的 {{key}} 保持一致
  const headers = ['email', 'password'];

  // 示例数据
  const sampleData = [
    { email: 'test2026061501@dw.com', password: '123456' },
    { email: 'test2026061502@dw.com', password: '123456' }
  ];

  // 创建工作簿
  const workbook = xlsx.utils.book_new();
  const worksheet = xlsx.utils.json_to_sheet(sampleData, { header: headers });
  xlsx.utils.book_append_sheet(workbook, worksheet, 'Sheet1');

  // 写入文件
  xlsx.writeFile(workbook, outputPath);
}

async function writingRules(inputArray, outputNodeTemplate) {
  const outputDir = outputNodeTemplate.path // 临时目录绝对路径
  const inputPath = path.join(outputDir, '../inputDir');
  const outputPath = path.join(inputPath, 'data.xlsx') // 临时目录绝对路径

  // 过滤出xlsx文件
  const xlsxFile = inputArray.find(item => item.normExt === 'xlsx' && item.name === 'data');

  const configFile = inputArray.find(item => item.normExt === 'json' && item.name === 'config03');

  if (!xlsxFile) {
    createXlsxTemplate(outputPath)
    return [{ ...outputNodeTemplate, content: '错误: 未找到 data.xlsx 文件,示例文件已创建' }];
  }

  if (!configFile) {
    const jsonTemplate = createJsonTemplate();
    return [
      { ...outputNodeTemplate, content: '错误: 未找到 config.json 文件,示例文件已创建' },
      {...outputNodeTemplate, path: inputPath, fileName: 'config',normExt:'json', content: JSON.stringify(jsonTemplate, null, 2)}
    ];
  }

  const jsonData = readExcel(xlsxFile);
  console.log(`已加载 ${jsonData.length} 条记录（来自 ${xlsxFile.path}）\n`);

  const config = JSON.parse(configFile.content);
  // const { url, method, headers, body, delay = 200, passwordEncrypt = [] } = config;
  const { delay = 200, steps = [] } = config;

  // 全局共享上下文，once步骤数据全部存入这里，所有行复用 {{shared.xxx}}
  const sharedCtx = {};
  // 记录已执行完成的once步骤下标，避免重复执行
  const executedOnceIdx = new Set();

  const content = []

  for (let i = 0; i < jsonData.length; i++) {
    const row = jsonData[i];
    let rowAllSuccess = true;
    const stepRecords = [];

    // 循环执行所有步骤
    for (let stepIdx = 0; stepIdx < steps.length; stepIdx++) {
      const step = steps[stepIdx];
      const { stepName, once, url, method, headers, body, passwordEncrypt = [], extractCtx={} } = step;

      // once步骤已执行，直接跳过
      if (once === true && executedOnceIdx.has(stepIdx)) {
        console.log(`[${i + 1}] 跳过一次性步骤：${stepName}`);
        continue;
      }

      console.log(`[${i + 1}] 执行步骤：${stepName}`);

      const data = {...sharedCtx,...row}
      // 渲染URL/Header/Body，传入三层：行数据
      const renderUrl = renderTemplate(url,data);
      const renderHeaders = renderTemplate(headers,data);
      const renderBody = renderTemplate(body,data);

      // [1.1.0新增] 对配置中指定的字段进行RSA加密
      for (const field of passwordEncrypt) {
        if (renderBody[field]) {
          renderBody[field] = rsaPsw(renderBody[field]);
        }
      }

      const axiosConfig = {
        url: renderUrl,
        method: method.toLowerCase(),
        headers: renderHeaders,
        data: method.toLowerCase() !== 'get' ? renderBody : null,
        params: method.toLowerCase() === 'get' ? renderBody : null,
        timeout: 60000
      };

      try {
        const response = await axios(axiosConfig);   // 直接发送，不重试
        // console.log('response',response);
        // 提取数据到共享上下文
        extractCtxData(response, extractCtx, sharedCtx);
        // 标记once步骤已执行
        if (once === true) executedOnceIdx.add(stepIdx);

        console.log(` ${stepName} 成功 (状态: ${response.status})`);
        stepRecords.push({
          stepName,
          once,
          status: 'success',
          req: axiosConfig,
          resp: {headers:response.headers,data:response.data}
        });
      } catch (err) {
        rowAllSuccess = false
        const status = err.response?.status || err.code || '网络错误';
        console.error(`[${stepIdx + 1}/${steps.length}] 失败: ${err.message} (状态: ${status})`);

        stepRecords.push({
          stepName,
          once,
          status: 'fail',
          req: axiosConfig,
          resp: err
        });

        break; // 当前行失败，终止后续步骤
      }
      await sleep(delay);
    }
    content.push({
      index: i,
      rowData: row,
      steps: stepRecords,
      totalStatus: rowAllSuccess ? 'success' : 'fail'
    });
  }

  const success = content.filter(item=>item.totalStatus === 'success').length
  const fail = content.filter(item=>item.totalStatus === 'fail').length
  console.log(`\n\n批量处理完成！成功: ${success}, 失败: ${fail}`);
  content.unshift({ successTotal: success, failTotal: fail });

  return [
    {...outputNodeTemplate, fileName: 'result', normExt:'json', content: JSON.stringify(content, null, 2)}
  ];
}

// module.exports = writingRules; // 导出主处理函数

module.exports = {
  name: 'batch2api',
  version: '2.1.2',
  process: writingRules,
  description: 'RAGFLOW定制-组合-批量同意-支持多步骤steps、once单次执行、全局共享上下文,json返回数据优化',
  notes: {
    node: '18.20.4'
  },
  input: {
    normExt: 'xlsx文件 + json配置文件',
  },
  output: {
    normExt: '',
  },
  rely: {
    'xlsx': '0.18.0',
    'axios': '0.27.2',
  },
};