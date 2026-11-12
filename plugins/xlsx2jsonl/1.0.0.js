/*
 * xlsx2jsonl（rule-process 插件版）
 * 职责：把 xlsx 表格转换成 jsonl 文件（每行一个 JSON 对象）。
 * 定位：jsonl2xlsx 的反向转换；与 xlsx2json 的区别在输出形态——
 *   xlsx2json   → 一个 json： [{ name: 'sheet名', data: [ {...} ] }]（整表进内存，适合小表）
 *   xlsx2jsonl  → 每 sheet 一个 JSON Lines 文本：每行一条记录（适合逐行消费，如喂给大模型逐行审核）
 *
 * 转换规则：
 *   - 表头（首行）即 JSON 字段名，列顺序按表头顺序；空表头写 __EMPTY，重名表头加 _1/_2 后缀
 *     （命名规则与 xlsx.utils.sheet_to_json 一致）
 *   - 单 sheet 工作簿输出同名文件（reviewed.xlsx → reviewed.jsonl）
 *     多 sheet 工作簿每 sheet 一个文件（reviewed.xlsx → reviewed_市南.jsonl、reviewed_城阳.jsonl）
 *   - 空单元格写 null（不省略键），保证下游按首条记录定列时不丢列；整行为空的行不产出记录
 *   - 数字保留数字类型（不转字符串），日期单元格按统一格式输出文本
 *   - 默认注入 rowIdx（0 起），与 jsonl2xlsx 对称：jsonl2xlsx 见数字 rowIdx 会据此升序还原源表行序
 *   - 坏 sheet（空表/只有表头/命中过滤词/隐藏页）跳过并 warn，不中断其他 sheet 与其他文件
 *
 * 日期处理（重要）：不用 xlsx 的 cellDates 读法——它把序列号转 Date 时有 ~43 秒的时区换算误差
 * （45306 会变成"2024-01-14 23:59:17"）。这里改为 cellNF 读法拿到单元格数字格式 z，
 * 再用 SSF.is_date / SSF.format 精确格式化：纯日期 → yyyy-mm-dd，带时间 → yyyy-mm-dd hh:mm:ss，
 * 纯时间（序列号 < 1）→ hh:mm:ss。
 */
const path = require('path');
const xlsx = require('xlsx');

// ===== 可调配置（改这里即可，不用动下面的逻辑）=====
const CONFIG = {
  addRowIdx: true,        // 每行注入 rowIdx（0 起）：jsonl2xlsx 读回时据此升序还原行序
  skipSheetKeywords: [],  // sheet 名命中任一关键词即跳过（如 ['删', '汇总']），默认不过滤
  skipHiddenSheets: true, // 跳过隐藏 sheet（Excel 里被折叠的中间过程页）
  useDisplayText: false   // true=所有单元格取 Excel 显示文本（日期/百分比/千分位按显示原样，但数字会变成字符串）
};

function writingRules(inputArray, outputNodeTemplate) {
  // 过滤出 xlsx/xls 文件（目录节点 normExt 为空串，不会误匹配）
  const xlsxFiles = inputArray.filter(item => item.normExt === 'xlsx' || item.normExt === 'xls');

  if (xlsxFiles.length === 0) {
    console.log('未找到 xlsx 文件');
    return [{ ...outputNodeTemplate, content: '错误: 未找到 xlsx 文件' }];
  }

  const outputNodes = [];
  xlsxFiles.forEach(xlsxFile => {
    outputNodes.push(...generateJsonl(xlsxFile, outputNodeTemplate));
  });

  if (outputNodes.length === 0) {
    outputNodes.push({ ...outputNodeTemplate, content: '错误: xlsx 中没有可导出的数据行（空表或表头以下无内容）' });
  }

  return outputNodes;
}

/** 读取工作簿，按 sheet 拆出多个 jsonl 输出节点 */
function generateJsonl(file, outputNodeTemplate) {
  let workbook;
  try {
    // cellNF: 保留单元格数字格式 z，用于识别并精确格式化日期（见文件头说明）
    workbook = xlsx.readFile(file.path, { cellNF: true });
  } catch (error) {
    console.error(`读取文件 ${file.path} 失败:`, error.message);
    return []; // 返回空避免进程中断
  }

  const sheetNames = workbook.SheetNames.filter(sheetName => shouldProcess(workbook, sheetName, file));
  // 只有一个待导出 sheet 时用文件名，多个 sheet 时加 sheet 名后缀区分（过滤后不足 2 个即视为单表）
  const isMultiSheet = sheetNames.length > 1;

  const nodes = [];
  sheetNames.forEach(sheetName => {
    const rows = sheetToRecords(workbook.Sheets[sheetName]);

    if (rows.length === 0) {
      console.warn(`sheet「${sheetName}」无数据行，已跳过: ${file.name}`);
      return;
    }

    const fileName = isMultiSheet ? `${file.name}_${sanitizeName(sheetName)}` : `${file.name}`;
    // JSON Lines：每行一条记录，行尾统一带换行
    const content = rows.map((row, index) => JSON.stringify(toRecord(row, index))).join('\n') + '\n';

    console.log(`已生成: ${fileName}.jsonl（sheet: ${sheetName}，${rows.length} 行）`);
    nodes.push({
      ...outputNodeTemplate,
      fileName,
      normExt: 'jsonl',
      content
    });
  });

  return nodes;
}

/** sheet 是否需要导出：命中跳过关键词 / 隐藏页 */
function shouldProcess(workbook, sheetName, file) {
  if (CONFIG.skipSheetKeywords.some(keyword => sheetName.includes(keyword))) {
    console.log(`sheet「${sheetName}」命中跳过关键词，已跳过: ${file.name}`);
    return false;
  }

  if (CONFIG.skipHiddenSheets && isHiddenSheet(workbook, sheetName)) {
    console.log(`sheet「${sheetName}」为隐藏页，已跳过: ${file.name}`);
    return false;
  }

  return true;
}

/** 判断 sheet 是否被隐藏（SheetJS: Hidden 为 1/2，可见时为 0/undefined） */
function isHiddenSheet(workbook, sheetName) {
  try {
    const sheetMeta = workbook.Workbook && workbook.Workbook.Sheets;
    if (!Array.isArray(sheetMeta)) return false;
    const index = workbook.SheetNames.indexOf(sheetName);
    const meta = index >= 0 ? sheetMeta[index] : null;
    return !!(meta && meta.Hidden);
  } catch (e) {
    return false;
  }
}

/** worksheet → 记录数组：首行为表头，逐行取值，整行为空的行跳过 */
function sheetToRecords(worksheet) {
  if (!worksheet || worksheet['!ref'] == null) return [];

  const range = xlsx.utils.decode_range(worksheet['!ref']);
  const headers = buildHeaders(worksheet, range);
  const records = [];

  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    const record = {};
    let isEmpty = true;

    for (let c = range.s.c; c <= range.e.c; c++) {
      const value = cellValue(worksheet[xlsx.utils.encode_cell({ r, c })]);
      if (value !== null) isEmpty = false;
      record[headers[c - range.s.c]] = value;
    }

    if (!isEmpty) records.push(record);
  }

  return records;
}

/** 构建表头：空单元格 → __EMPTY，重名 → 原名_1/_2（与 xlsx.utils.sheet_to_json 一致） */
function buildHeaders(worksheet, range) {
  const headers = [];

  for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = worksheet[xlsx.utils.encode_cell({ r: range.s.r, c })];
    const base = cell == null || cell.v == null ? '__EMPTY' : cellText(cell);
    let name = base;
    let counter = 0;
    while (headers.includes(name)) name = `${base}_${++counter}`;
    headers.push(name);
  }

  return headers;
}

/** 单元格 → JSON 值：空值 null、日期格式化、其余保留原始类型 */
function cellValue(cell) {
  if (cell == null || cell.v === undefined || cell.v === null) return null;

  if (CONFIG.useDisplayText) return cellText(cell);

  // 错误值（#DIV/0! 等）保留成文本，比丢成 null 更有信息量
  if (cell.t === 'e') return cellText(cell);

  // 日期单元格：按数字格式 z 精确格式化（不用 cellDates，见文件头说明）
  if (cell.t === 'n' && isDateFormat(cell.z)) return formatDateSerial(cell.v, cell.z);

  return cell.v;
}

/** 单元格显示文本（读文件时 SheetJS 会算好 w） */
function cellText(cell) {
  if (cell.w != null) return cell.w;
  return cell.v == null ? '' : String(cell.v);
}

/** 数字格式是否为日期/时间格式 */
function isDateFormat(format) {
  if (!format) return false;
  try {
    return !!(xlsx.SSF.is_date && xlsx.SSF.is_date(format));
  } catch (e) {
    return false;
  }
}

/** 按统一格式输出日期文本：纯时间 → hh:mm:ss，含时间 → yyyy-mm-dd hh:mm:ss，纯日期 → yyyy-mm-dd */
function formatDateSerial(serial, format) {
  const pattern = serial >= 0 && serial < 1
    ? 'hh:mm:ss'
    : (hasTimeToken(format) ? 'yyyy-mm-dd hh:mm:ss' : 'yyyy-mm-dd');

  try {
    return xlsx.SSF.format(pattern, serial);
  } catch (e) {
    return serial; // 格式化失败保留原值，不丢数据
  }
}

/** 数字格式里是否含时间占位符 h/s（先剔除 "文本段" 与 \转义，避免误判） */
function hasTimeToken(format) {
  const cleaned = String(format).replace(/"[^"]*"/g, '').replace(/\\./g, '');
  return /[hs]/i.test(cleaned);
}

/** 一行表数据 → JSON 对象：默认把 rowIdx 放最前 */
function toRecord(row, index) {
  const record = {};

  // 源表本来就有 rowIdx 列时保留原值，避免覆盖业务字段
  if (CONFIG.addRowIdx && !('rowIdx' in row)) {
    record.rowIdx = index;
  }

  Object.keys(row).forEach(key => {
    record[key] = row[key];
  });

  return record;
}

/** sheet 名 → 文件名安全字符 */
function sanitizeName(sheetName) {
  return String(sheetName).replace(/[\\/:*?"<>|]/g, '_').trim() || 'Sheet';
}

module.exports = {
  name: 'xlsx2jsonl',
  version: '1.0.0',
  process: writingRules,
  description: '将 xlsx 按 sheet 拆成 jsonl：表头即字段名，一行一条记录；单 sheet 输出同名 jsonl，多 sheet 输出 文件名_sheet名.jsonl',
  notes: {
    node: '18.20.4',
    tips: [
      '输入约定：xlsx（或 xls）表格，首行为表头，一行数据一条记录；多 sheet 会拆成多个 jsonl',
      '输出：单 sheet → 与 xlsx 同名（reviewed.xlsx → reviewed.jsonl）；多 sheet → 文件名_sheet名.jsonl（sheet 名里的 \\/:*?"<>| 会替换成 _）',
      '空单元格写 null 而非省略键，保证 jsonl2xlsx 按首条记录定列时不丢列；整行为空的行不产出记录',
      '默认注入 rowIdx（0 起，若源表已有该列则保留原值），与 jsonl2xlsx 对称：jsonl2xlsx 见数字 rowIdx 会据此还原源表行序',
      '数字保留数字类型；日期输出可读文本（yyyy-mm-dd / yyyy-mm-dd hh:mm:ss / hh:mm:ss），不是 Excel 序列号',
      '日期用 cellNF + SSF.format 精确格式化，未用 SheetJS 的 cellDates（该选项有 43 秒级时区换算误差，会把 2024-01-15 读成 2024-01-14 23:59:17）',
      '表头命名与 sheet_to_json 一致：空表头 __EMPTY，重名 原名_1/原名_2',
      '默认跳过隐藏 sheet、不按关键词过滤；可在文件顶部 CONFIG 调整（addRowIdx / skipSheetKeywords / skipHiddenSheets / useDisplayText）',
      '已知限制：合并单元格只有左上角有值，其余为 null（Excel 本身也是这个事实）；公式单元格取的是缓存值'
    ]
  },
  input: {
    normExt: 'xlsx文件',
    format: 'xlsx/xls 表格：首行表头，一行数据一条记录'
  },
  output: {
    normExt: 'jsonl文件',
    format: 'JSON Lines：每行一个 JSON 对象，字段即表头列，行尾带换行'
  },
  rely: { // 默认 latest
    'xlsx': '0.18.0'
  }
};
