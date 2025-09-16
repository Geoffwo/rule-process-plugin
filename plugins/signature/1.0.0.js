// 引入 Node.js 内置的加密模块，提供数字签名、哈希、密钥对生成等功能
const crypto = require('crypto');

/**
 * 生成 RSA 密钥对（公钥 + 私钥）
 * @returns {Object} 包含公钥和私钥的对象
 */
function generateKey(){
  // generateKeyPairSync同步生成非对称密钥对 generateKeyPairSync(type, options);
  // type=RSA、ECDSA, RSA生成 RSA 密钥对（公钥 + 私钥）
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048, // 密钥长度（2048 位，安全性较高）
    publicKeyEncoding: { type: 'spki', format: 'pem' }, // 公钥格式标准（SPKI） 输出为 PEM 格式（文本格式）
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, // 私钥格式标准（PKCS#8） 输出为 PEM 格式（文本格式）
  });

  console.log('公钥:\n', publicKey);
  console.log('私钥:\n', privateKey);
  return { publicKey, privateKey };
}

/**
 * 使用私钥对数据进行数字签名
 * @param {string|Buffer} data - 待签名的数据
 * @param {string} privateKey - PEM 格式的私钥
 * @returns {string} Base64 编码的签名字符串
 */
function signData(data, privateKey) {
  // 创建签名对象，指定哈希算法为 SHA-256
  const signer = crypto.createSign('SHA256'); // 使用 SHA-256 哈希算法
  signer.update(data); // 写入需要签名的原始数据（支持多次调用以追加数据）
  signer.end();// 结束数据输入，准备生成签名

  // 用私钥对数据的哈希值加密，生成签名，返回 Base64 编码的字符串
  const signature = signer.sign(privateKey, 'base64');
  return signature;
}


/**
 * 使用公钥验证数字签名
 * @param {string|Buffer} data - 原始数据
 * @param {string} signature - Base64 编码的签名字符串
 * @param {string} publicKey - PEM 格式的公钥
 * @returns {boolean} 签名是否有效
 */
function signVerify(data, signature, publicKey) {
  // 创建验证对象，指定哈希算法为 SHA-256（需与签名时一致）
  const verifier = crypto.createVerify('SHA256');
  verifier.update(data);// 写入原始数据（必须与签名时的数据完全一致）
  verifier.end();// 结束数据输入，准备验证

  // 验证签名是否有效
  // 用公钥解密签名，得到哈希值A，再计算数据的哈希值B，比较 A === B
  const isValid = verifier.verify(publicKey, signature, 'base64');
  return isValid;
}

/**
 * 验证文件签名
 */
function verifyFile(inputFiles,outputNodeTemplate){
  // 过滤出密钥pem文件
  const pemFiles = inputFiles.filter(file => file.normExt === 'pem');
  //签名文件
  const signFiles = inputFiles.filter(file => file.normExt === 'sig');
  //需要校验的文件
  const verifyFiles = inputFiles.filter(file => file.normExt !== 'pem' && file.normExt !== 'sig');

  const contents = []
  const publicKeyNode = pemFiles.find(file => file.name === 'public' && file.normExt === 'pem') || {};
  const publicKey = publicKeyNode.content
  if (!publicKey) {
    contents.push({fileName:'public.pem',msg:'找不到公钥文件'})
    return [{...outputNodeTemplate,content:JSON.stringify(contents)}]
  }

  // 验证每个文件
  verifyFiles.forEach(file=>{
    // 获取原始数据
    const data = file.content;
    const fileName = file.name;
    // 获取签名文件
    const signatureNode = signFiles.find(file => file.name === fileName)|| {};
    const signature = signatureNode.content
    if (!signature) {//签名文件不存在
      contents.push({fileName:fileName,msg:'找不到sig签名文件'})
    }else{
      // 验证签名
      const isValid = signVerify(data, signature, publicKey) // 原始数据 签名 公钥
      const msg = isValid ? '通过，数据完整性已确认' : '不通过，数据可能被篡改或使用了错误的公钥'
      contents.push({fileName:fileName,msg:`签名验证结果: ${msg}`})
    }
  })

  return [{...outputNodeTemplate,content:JSON.stringify(contents)}]
}

/**
 * 处理文件并生成签名文件
 */
function processFiles(inputFiles,outputNodeTemplate) {
  // 过滤出密钥pem文件
  const pemFiles = inputFiles.filter(file => file.normExt === 'pem');
  //需要签名的文件
  const signFiles = inputFiles.filter(file => file.normExt !== 'pem');

  const result = []
  let publicKey = pemFiles.find(file => file.name === 'public');
  let privateKey = pemFiles.find(file => file.name === 'private');

  // 当文件下，公钥私钥任一不存在时，才生成新的密钥对
  if (!publicKey || !privateKey) {
    console.log('未找到现有密钥对，正在生成新的...');
    const keys = generateKey();//生成 RSA 密钥对（公钥 + 私钥）

    // 更新密钥对
    publicKey = keys.publicKey;
    privateKey = keys.privateKey;

    // 生成密钥对文件数组
    result.push({...outputNodeTemplate,normExt:'pem',fileName:'public',content:publicKey})//公钥
    result.push({...outputNodeTemplate,normExt:'pem',fileName:'private',content:privateKey})//私钥
  }

  //循环遍历需要签名的文件
  signFiles.forEach(file=>{
    // 文件的原始数据
    const data = file.content;
    const fileName = file.name;

    // 使用私钥签名原始数据
    const signature = signData(data, privateKey);//返回 Base64 编码的字符串
    // 生成签名文件数组
    result.push({...outputNodeTemplate,normExt:'sig',fileName:fileName,content:signature})
  })
  return result
}

function writingRules(inputArray,outputNodeTemplate) {
  console.log('inputArray=>',inputArray);
  console.log('outputNodeTemplate=>',outputNodeTemplate);

  // 检查是否有签名文件存在
  const hasSignFiles = inputArray.some(file => file.normExt === 'sig');

  let results;
  if (hasSignFiles) {
    // 有签名文件，执行验证操作
    results = verifyFile(inputArray,outputNodeTemplate);
  } else {
    // 没有签名文件，执行签名操作
    results = processFiles(inputArray,outputNodeTemplate);
  }

  return results;
}

// module.exports = writingRules;

module.exports = {
  name: 'signature',
  version: '1.0.0',
  process: writingRules,
  description:'文件签名与验证工具：支持生成RSA密钥对、对文件进行数字签名和验证签名',
  notes:{
    node:'18.20.4',
  },
  input:[
    {
      normExt: '需要签名的文件、[pem文件]',
      format:'如果没有pem文件，生成公私钥；对除pem文件外的剩余文件签名'
    },
    {
      normExt: '需要校验签名的文件、sig文件、pem公钥文件',
      format:'使用公钥验证【sig文件】和【校验文件】名字一致的文件'
    },
  ],
  output: [
    {
      normExt: 'sig文件',
      format: "签名文件"
    },
    {
      normExt: 'json文件',
      format: "[{fileName:文件名,msg:验证结果}]"
    }
  ],

};
