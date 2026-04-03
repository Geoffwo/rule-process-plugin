/**
 * SQL关键内容替换工具函数
 * @param {string} sql - 输入的原始SQL字符串
 * @returns {string} 替换后的SQL字符串
 */
function replaceSqlKeyParts(sql) {
  if (!sql || typeof sql !== 'string') {
    return '';
  }

  // 按照需求依次执行替换（顺序不影响结果）
  let result = sql
      // 1. 替换表名前缀 HISJN -> HIS
      .replace(/HISJN\.MEDICAL_ITEM_DUP_CHARGE_DICT/gi, 'HIS.MEDICAL_ITEM_DUP_CHARGE_DICT')
      .replace(/HISJN\.MEDICAL_ITEM_OVERUSE_DICT/gi, 'HIS.MEDICAL_ITEM_OVERUSE_DICT')
      // 2. 字段替换 YLXMBM -> MICODE
      .replace(/YLXMBM/gi, 'MICODE')
      // 3. 字段替换 YLXMMC -> listname
      .replace(/YLXMMC/gi, 'listname')
      // 4. 剔除 AND YPBZ = '0' 条件（支持大小写、空格兼容）
      .replace(/\s*AND\s+YPBZ\s*=\s*'0'/gi, '')
      // 5. 替换业务表名 i 标志，忽略大小写匹配
      .replace(/his\.SI_MEDI_ITEM_T/gi, 'his.item_mapping_rmyy');

  return result;
}

async function writingRules(inputArray, outputNodeTemplate) {

  // 筛选出目标文件
  const dataFile = inputArray.find(item => item.normExt === 'txt' && item.name === 'data');
  if (!dataFile) {
    throw new Error('未找到目标文件：请将原始SQL内容拷贝到data.txt文件');
  }

  // 自动读取 data.txt 并执行SQL替换
  const outputSql = replaceSqlKeyParts(dataFile.content);

  return [{
    ...outputNodeTemplate,
    fileName: 'result',
    normExt: 'txt',
    content: outputSql // 直接返回SQL字符串，去掉JSON.stringify
  }];
}

// ====================== 规则引擎插件导出 ======================
module.exports = {
  name: 'sql2format',
  version: '2.0.1',
  process: writingRules,
  description: '读取data.txt中的原始SQL，自动执行关键字段/表名替换，生成标准SQL文件(济南->淄博 医保 自查自纠)',
  notes: {
    node: '18.20.4',
    tips: [
      '将需要转换的原始SQL复制到 data.txt 文件中',
      '插件自动完成表名、字段名替换，删除多余条件',
      '生成的标准SQL保存在 result.txt 文件中'
    ]
  },
  input: {
    normExt: 'txt',
    format: '格式：data.txt 存放原始INSERT SQL语句（直接从数据库复制）'
  },
  output: {
    normExt: 'txt'
  },
  rely: {} // 无第三方依赖，纯文本处理
};