/*
 * 外伤提醒知识库候选集圈选（rule-process 插件版 · 规则预处理模块）
 *
 * 业务目标：从全量 ICD10 基表离线生成"外伤提醒知识库"候选集，
 * 供下游 AI 批量标注模块（icdAI2trauma）做二分类（相关/无关）复核，
 * 最终输出带标注结果的数据集用于入库。
 *
 * 知识库用途：线上开单时弹窗提醒医生创建外伤申请单。
 * 策略：优先召回、宁宽勿漏（仅弹窗提示，不强制）。
 *
 * 职责边界：本模块只做候选集圈选，不做最终入库判定，
 * 目的是大幅减少下游 AI 待处理的数据量。
 *
 * 筛选规则（满足任一即进入候选集）：
 *   规则1（编码规则）：ICD10 编码首字母 ∈ {S,T,V,W,X,Y}
 *     —— 对应 ICD10 第 XIX 章（S00-T98 损伤、中毒和外因的某些其他后果）
 *        与第 XX 章（V01-Y98 疾病和死亡的外因）
 *   规则2（关键词规则）：ICD 诊断名称命中"外伤关键词库"
 *     —— 补充捕捉其他章节中与外伤相关的条目（如 M 章病理性骨折等）
 *
 * 输入约定：文件名 data.xlsx，第一个 sheet，A列=icd_code、B列=icd_name，首行表头。
 * 输出：candidate.xlsx（候选集：icd_code, icd_name, 命中规则, 命中关键词）
 *       candidate.json（运行摘要）
 */
const path = require('path');
const xlsx = require('xlsx');

// 规则1：ICD10 编码首字母白名单
// S/T：损伤、中毒和外因的某些其他后果（第XIX章）
// V/W/X/Y：疾病和死亡的外因（第XX章）
const codeFirstLetters = ['S', 'T', 'V', 'W', 'X', 'Y']

// ============================ 外伤关键词库 ============================
// 策略：优先召回、宁宽勿漏。名称命中任一关键词即进入候选集。
// 说明：规则1（编码首字母）已覆盖 S/T/V/W/X/Y 章绝大部分外伤编码，
//      关键词库主要用于补充其他章节（如 M 章病理性骨折、G 章神经损伤等）
//      中与外伤相关的条目，避免漏召回。按语义分组便于维护。
const TRAUMA_KEYWORDS = [
    // ── 损伤/创伤通用 ──
    '损伤', '创伤', '外伤', '挫伤', '扭伤', '拉伤', '挤压伤', '碾压伤', '压砸伤',
    '撞伤', '摔伤', '跌伤', '擦伤', '裂伤', '割伤', '刺伤', '戳伤', '砍伤',
    '枪伤', '弹伤', '炸伤', '爆震伤', '钝器伤', '锐器伤', '贯通伤', '穿孔伤',
    '开放伤', '闭合伤', '撕脱', '挫裂伤', '创伤性', '外伤性', '损伤性',
    '复合伤', '多发伤', '多发性损伤',

    // ── 骨折/关节 ──
    '骨折', '骨裂', '骨骺分离', '脱位', '脱臼', '半脱位', '错位',

    // ── 脏器/组织损伤 ──
    '颅脑损伤', '脑损伤', '脊髓损伤', '神经损伤', '血管损伤', '肌腱损伤',
    '韧带损伤', '半月板损伤', '软骨损伤', '肌肉损伤', '内脏损伤', '脏器损伤',
    '血肿', '皮下血肿', '硬膜外血肿', '硬膜下血肿', '瘀血', '淤血',
    '异物', '残留异物', '体内异物',

    // ── 烧伤/理化损伤 ──
    '烧伤', '烫伤', '灼伤', '火器伤', '冻伤', '冻僵', '电击', '电伤', '雷击',
    '放射伤', '辐射伤', '中暑', '热射病', '热痉挛', '热衰竭', '溺水', '淹溺',
    '窒息', '气压伤', '减压病',

    // ── 动物/生物致伤 ──
    '咬伤', '蜇伤', '蛰伤', '抓伤', '动物伤', '蛇咬', '虫咬', '蜂蛰', '蜂蜇',

    // ── 中毒/毒物（外因后果）──
    '中毒', '药物中毒', '酒精中毒', '食物中毒', '农药中毒', '重金属中毒',

    // ── 外因/暴力 ──
    '交通事故', '车祸', '工伤', '意外', '自杀', '自伤', '自残', '他杀',
    '暴力', '打架', '斗殴', '虐待', '性侵', '强奸',

    // ── 创伤并发症/综合征 ──
    '挤压综合征', '骨筋膜室综合征', '筋膜室综合征', '创伤性休克', '失血性休克',
    '创伤性湿肺', '脂肪栓塞'
];

// ------------------------- 规则判定 -------------------------
/**
 * 规则1：判断 ICD10 编码首字母是否命中白名单
 * @param {string} code ICD10 编码
 * @returns {boolean}
 */
function hitCodeRule(code) {
    if (!code) return false;
    const first = String(code).trim().charAt(0).toUpperCase();

    return codeFirstLetters.includes(first);
}

/**
 * 规则2：判断诊断名称命中的外伤关键词
 * @param {string} name 诊断名称
 * @returns {string[]} 命中的关键词数组（可能为空）
 */
function hitKeywords(name) {
    if (!name) return [];
    const hit = [];
    for (const kw of TRAUMA_KEYWORDS) {
        if (name.includes(kw)) hit.push(kw);
    }
    return hit;
}

// ------------------------- 输入模板 -------------------------
// 无输入文件时输出（携带参考信息：表头 + 示例数据）
function createXlsxTemplate(outputPath) {
    const headers = ['icd_code', 'icd_name'];
    const sampleData = [
        { icd_code: 'S42.001', 'icd_name': '锁骨骨折', 'icd_type': 'icd10', 'is_gray': 0 },
        { icd_code: 'S06.000', 'icd_name': '脑震荡', 'icd_type': 'icd10', 'is_gray': 0 },
        { icd_code: 'T30.x00', 'icd_name': '烧伤', 'icd_type': 'icd10', 'is_gray': 0 },
        { icd_code: 'V89.900', 'icd_name': '机动车交通事故', 'icd_type': 'icd10', 'is_gray': 0 },
        { icd_code: 'A16.201', 'icd_name': '肺结核', 'icd_type': 'icd10', 'is_gray': 0 },
        { icd_code: 'E11.900', 'icd_name': '2型糖尿病', 'icd_type': 'icd10', 'is_gray': 0 }
    ];
    const workbook = xlsx.utils.book_new();
    const worksheet = xlsx.utils.json_to_sheet(sampleData, { header: headers });
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
    xlsx.writeFile(workbook, outputPath);
}

// ------------------------- 读表 -------------------------
function readExcel(file) {
    const workbook = xlsx.readFile(file.path);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) {
        throw new Error(`文件无工作表: ${file.path}`);
    }
    return xlsx.utils.sheet_to_json(worksheet)
        .map(r => ({ code: r.icd_code, name: r.icd_name, type: r.icd_type, isGray: r.is_gray }))
        .filter(r => r.code || r.name);
}

// ------------------------- 候选集圈选 -------------------------
/**
 * 遍历全量 ICD10 行，按"编码规则 OR 关键词规则"圈选候选集
 * @param {Array<{code:string,name:string}>} rows
 * @returns {{candidates:Array, codeHitCount:number, kwHitCount:number, bothHitCount:number}}
 */
function selectCandidates(rows) {
    const candidates = [];
    let codeHitCount = 0, kwHitCount = 0, bothHitCount = 0;

    for (const row of rows) {
        //只有icd10进入规则筛选
        if (row.type !== 'icd10') continue;

        const codeHit = hitCodeRule(row.code);
        const kws = hitKeywords(row.name);
        const kwHit = kws.length > 0;

        // 满足任一规则即进入候选集
        if (!codeHit && !kwHit) continue;

        let rule;
        if (codeHit && kwHit) {
            rule = '编码+关键词';
            bothHitCount++;
        }
        else if (codeHit) {
            rule = '编码规则';
            codeHitCount++;
        }
        else {
            rule = '关键词规则';
            kwHitCount++;
        }

        candidates.push({
            ...row,
            rule: rule,
            keywords: kws.join('、')
        });
    }

    return { candidates, codeHitCount, kwHitCount, bothHitCount };
}

// ------------------------- 写输出 -------------------------
function writeOutput(candidates, outputPath) {
    const header = ['icd_code', 'icd_name','icd_type','is_gray', '命中规则', '命中关键词'];
    const aoa = [header];
    for (const c of candidates) {
        aoa.push([c.code, c.name,c.type,c.isGray, c.rule, c.keywords]);
    }
    const workbook = xlsx.utils.book_new();
    const worksheet = xlsx.utils.aoa_to_sheet(aoa);
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
    xlsx.writeFile(workbook, outputPath);
}

// ------------------------- 框架入口 -------------------------
function writingRules(inputArray, outputNodeTemplate) {
    const outputDir = outputNodeTemplate.path;
    const inputPath = path.join(outputDir, '../inputDir');
    const demoPath = path.join(inputPath, `data.xlsx`);
    const outputPath = path.join(outputDir, `candidate.xlsx`);

    // 1. 定位输入 Excel（data.xlsx）；无输入文件时生成输入模板
    const xlsxFile = inputArray.find(
        item => item.normExt === 'xlsx' && item.name === 'data'
    );

    if (!xlsxFile) {
        createXlsxTemplate(demoPath);
        return [{ ...outputNodeTemplate, content: `错误: 未找到 data.xlsx 文件,示例文件已创建` }];
    }

    // 2. 读取源表
    const rows = readExcel(xlsxFile);
    console.log(`已加载 ${rows.length} 条 ICD10 记录（来自 ${xlsxFile.path}）\n`);

    // 3. 候选集圈选
    const { candidates, codeHitCount, kwHitCount, bothHitCount } = selectCandidates(rows);

    // 4. 写出候选集
    writeOutput(candidates, outputPath);

    // 5. 日志
    const ratio = rows.length ? (candidates.length / rows.length * 100).toFixed(2) : '0.00';
    console.log(`[外伤候选集圈选] 源表行数: ${rows.length}`);
    console.log(`编码规则命中(S/T/V/W/X/Y): ${codeHitCount}`);
    console.log(`关键词规则命中: ${kwHitCount}`);
    console.log(`编码+关键词双命中: ${bothHitCount}`);
    console.log(`候选集总条数: ${candidates.length}（占比 ${ratio}%）`);
    console.log('已写出:', outputPath);

    // 6. 返回状态节点：path 保持输出目录，候选集 xlsx 已由 writeOutput 写入 outputDir
    const summary = {
        module: '外伤提醒知识库-规则预处理',
        strategy: '优先召回、宁宽勿漏',
        sourceRows: rows.length,
        codeHitCount,
        keywordHitCount: kwHitCount,
        bothHitCount,
        candidateTotal: candidates.length,
        candidateRatio: ratio + '%',
        outputFile: outputPath,
        nextStep: '运行 icdAI2trauma 规则对候选集做 AI 批量标注（相关/无关）'
    };
    return [{
        ...outputNodeTemplate,
        fileName: 'candidate',
        normExt: 'json',
        content: JSON.stringify(summary, null, 2)
    }];
}

module.exports = {
    name: 'icdCheck2trauma',
    version: '1.0.0',
    process: writingRules,
    description: '外伤提醒知识库-规则预处理模块：从全量 ICD10 基表圈选外伤提醒候选集（规则1 编码首字母命中 S/T/V/W/X/Y；规则2 诊断名称命中外伤关键词库，满足任一即入候选集）；只做候选集圈选不做最终入库判定，优先召回、宁宽勿漏，大幅减少下游 AI 待处理数据量',
    notes: {
        node: '18.20.4',
        tips: [
            '业务目标：从全量 ICD10 基表离线生成外伤提醒知识库候选集，输出送 AI 批量标注，最终入库',
            '知识库用途：线上开单时弹窗提醒医生创建外伤申请单；策略：优先召回、宁宽勿漏（仅提示、不强制）',
            '职责边界：本模块只做候选集圈选，不做最终入库判定；目的是大幅减少下游 AI 待处理数据量',
            '筛选规则1（编码规则）：ICD10 编码首字母 ∈ {S,T,V,W,X,Y}',
            '筛选规则2（关键词规则）：ICD 诊断名称命中外伤关键词库（见脚本顶部 TRAUMA_KEYWORDS）',
            '逻辑：满足任一规则即进入候选集（OR）',
            '输入约定：文件名 data.xlsx，第一个 sheet，A列=icd_code、B列=icd_name，首行表头；无数据时自动输出输入模板',
            '输出：candidate.xlsx（候选集：icd_code, icd_name, 命中规则, 命中关键词）+ candidate.json（运行摘要）',
            '命中规则取值：编码规则 / 关键词规则 / 编码+关键词',
            '编码首字母白名单与关键词库均集中在脚本顶部 config / TRAUMA_KEYWORDS，按需调整',
            '链路：traumaRecall（candidate.xlsx）→ icdAI2trauma（reviewed.jsonl）→ jsonl2xlsx（reviewed.xlsx）'
        ],
        rules: {
            rule1_code: {
                label: '编码规则',
                description: 'ICD10 编码首字母 ∈ {S,T,V,W,X,Y}。S-T 为第XIX章"损伤、中毒和外因的某些其他后果"，V-Y 为第XX章"疾病和死亡的外因"。'
            },
            rule2_keyword: {
                label: '关键词规则',
                description: 'ICD 诊断名称命中外伤关键词库，补充捕捉其他章节中与外伤相关的条目（如 M 章病理性骨折）。关键词库按语义分组：损伤/创伤通用、骨折/关节、脏器/组织损伤、烧伤/理化、动物/生物致伤、中毒、外因/暴力、创伤并发症。'
            }
        }
    },
    input: {
        normExt: 'xlsx文件',
        format: 'Excel：约定 data.xlsx，第一个 sheet，A 列=icd_code + B 列=icd_name，首行表头'
    },
    output: {
        normExt: 'xlsx文件',
        format: '候选集 candidate.xlsx：icd_code, icd_name, 命中规则(编码规则|关键词规则|编码+关键词), 命中关键词'
    },
    rely: {
        'xlsx': '0.18.0'
    },
};
