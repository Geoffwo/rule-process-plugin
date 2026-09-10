/*
 * ICD 联合诊断发现器（rule-process 插件版）
 * 流程：读数据 → bigram 倒排索引(blocking) → 成分接受(range) → 精确切分/loose 兜底/模糊配对 → 输出预结果表 → 交AI筛选
 *
 * 本插件符合 rule-process-plugin 框架约定：
 *   - 导出 module.exports = { name, version, process: writingRules, description, notes, input, output, rely }
 *   - writingRules(inputArray, outputNodeTemplate) 接收输入文件节点，将预结果 xlsx 写入 outputNodeTemplate.path，
 *     返回一个状态输出节点。
 *   - 参数集中在顶部 config 配置块，运行前按需调整。
 *
 * 输入约定：文件名 data.xlsx，第一个 sheet，A 列=ICD10 编码、B 列=ICD10 名称、C 列=icd_type，首行为表头。
 * 无输入文件或源表无有效数据时，自动输出"输入模板.xlsx"，按模板填数据后重跑。
 */
const path = require('path');
const fs = require('fs');
const xlsx = require('xlsx');

// ============================ 配置 ============================
const config = {
    threshold: 0.5,//片段重合度大于等于配置的最低阈值
    // 模糊配对（别名/缩写召回）专用阈值，刻意从严，避免噪声爆炸
    fuzzyTopK: 6,             // 候选成分取前 k 名做两两组合
    fuzzyContMin: 0.85,       // 每个成分对联合名的包含度下限
    fuzzyCoverageMin: 0.90,   // part1∪part2 对联合名的 bigram 覆盖率下限
    fuzzyMaxPerunion: 2,      // 每个联合名最多保留的模糊配对数
    // loose 兜底：精确切分因连接词未知而失败时，双子串候选对覆盖率 >= 此值则产出低置信记录
    looseCoverageMin: 0.85,
    // 子序列配对（术式修饰词型）：union = 成分A + 修饰词(如"开窗") + 成分B，成分是 union 的非连续子序列
    subseqTopK: 6,             // 候选成分取前 k 名做两两组合
    subseqMaxGap: 6,         // 单个成分相对 union 最多缺失的字符数（增量文本长度上限；注意短成分的 gap 含修饰词+长度差）
    subseqCoverageMin: 0.85, // 双成分合并后对 union 的字符覆盖率下限
    subseqMaxPerunion: 2     // 每个联合名最多保留的子序列配对数
};

// 连接词（不含空串；空串 = 无连接词的直接拼接，在 splitExact 里单独处理）
// 注意：长连接词必须排在短的前面，startsWith 按序匹配，否则"并有"会被"并"截胡
const CONNECTORS = ['以及', '并有', '合并', '联合', '伴有','和', '及', '与', '且', '伴', '并', '，', '、', '/'];

// ------------------------- bigram 工具 -------------------------
/**
 * 取字符串的所有相邻二字滑窗
 * @param {string} str 输入文本
 * @returns {string[]} bigram数组，例如 "肺结核" → ["肺结", "结核"]
 */
function bigrams(str) {
    const out = [];
    // 字符串长度不足2，无法生成bigram，直接返回空数组
    if (!str || str.length < 2) return out;

    // 滑动窗口步长1，每次截取2个字符
    for (let i = 0; i + 2 <= str.length; i++) out.push(str.slice(i, i + 2));
    return out;
}

/**
 * 计算【组分】相对于【联合诊断】的gram覆盖率(重合度)
 * 返回值 0~1
 * 公式：组分有多少个二字片段，出现在联合诊断片段里 / 组分总片段数量
 * 注意：是“组分的片段有多少被联合覆盖”，不是两者交集除以并集
 * @param {string[]} preDataGrams 候选组分的二字gram数组
 * @param {string[]} unionGrams 联合诊断的二字gram数组
 * @returns {number} 0‑1
 */
function rangeOf(preDataGrams, unionGrams) {
    //preDataGrams（候选：颈椎间盘切除术）：`["颈椎","椎间","间盘","间切","切除","除术"]`
    //unionGrams（联合：颈椎间盘切除伴椎管减压术）：`["颈椎","椎间","间盘","间切","切除","除伴","伴椎","椎管","管减","减压","压术"]`

    // 边界：如果候选组分没有二字片段（比如只有单个汉字的病名），直接返回重合度0
    if (!preDataGrams.length) return 0;

    // 把联合诊断的所有二字片段放入Set集合
    const unionSet = new Set(unionGrams);

    // 记录：候选组分中，能在联合诊断里找到的二字片段数量
    let overlap = 0;

    // 遍历候选组分每一个二字片段
    for (const gram of preDataGrams) {
        // 如果这个片段在联合诊断片段集合中存在，重合计数+1
        if (unionSet.has(gram)) overlap++;
    }

    // 返回：重合片段数 ÷ 候选组分全部片段总数 → 得到0~1的覆盖率
    // 看候选组分多少片段落在联合里，不关心联合多出的片段
    return overlap / preDataGrams.length;
}

/**
 * 计算两个子组分合并后对联合手术的 n‑gram 覆盖率
 * 覆盖率 = (union中被part1+part2覆盖到的gram数量) / (union全部gram总数量)
 * 取值范围：0 ~ 1；越大代表两个子组分的片段越能覆盖联合手术的文本片段
 * @param {Array} part1Grams 组分1的ngram片段数组
 * @param {Array} part2Grams 组分2的ngram片段数组
 * @param {Array} unionGrams 联合手术union本身的ngram片段数组
 * @returns {number} 覆盖率 0‑1
 */
function coverageOf(part1Grams, part2Grams, unionGrams) {
    // 将联合手术的所有ngram转为Set集合，方便快速查找、去重
    const unionSet = new Set(unionGrams);
    // 合并part1、part2的ngram片段，放入Set自动去重：得到两个组分总共拥有的片段集合
    const union = new Set([...part1Grams, ...part2Grams]);

    // 统计：联合手术中，被part1+part2覆盖到的ngram片段数量
    let covered = 0;
    // 遍历联合手术全部ngram
    for (const gram of unionSet) {
        // 如果该ngram存在于两个组分合并集合中，说明被覆盖
        if (union.has(gram)) {
            covered++;
        }
    }
    // 覆盖率 = 已覆盖片段数 / union总片段数
    return covered / unionSet.size;
}

// ------------------------- 精确切分 -------------------------
/**
 * 精确切分文本：preData是union的子串，剥离preData，提取剩下part2文本和连接词
 * @param {string} unionName 联合诊断完整名称文本
 * @param {string} preDataName 组分A文本（已经确认是union子串）
 * @returns {{part2Name:string, connector:string}|null}
 */
function splitExact(unionName, preDataName) {
    // indexOf：查找 preDataName 在 unionName 字符串内部的起始下标
    const idx = unionName.indexOf(preDataName);
    // 防御判断：找不到子串直接返回null；上层已经判断isSubstring，理论不会走到这里
    if (idx < 0) return null;

    // =========情况1：preDataName 出现在 unionName【开头】=========
    if(idx===0){
        // idx：组分A第一个字符下标；idx + preDataName.length：组分A结束之后第一个字符下标
        // 截取：preData后面剩下全部字符串 rest
        const rest = unionName.slice(idx + preDataName.length);// preDataName 在开头：unionName = preDataName + 连接词? + part2

        // 优先遍历已知连接词，看rest是不是以连接词开头
        for (const conn of CONNECTORS) {
            if (rest.startsWith(conn)) {
                // rest.slice(conn.length)：去掉开头的连接词，拿到part2的文本
                const part2Name = rest.slice(conn.length);

                // part2不为空，并且不能和preData完全相同，禁止A+A无效组合，返回切分结果
                if (part2Name && part2Name !== preDataName)
                    return { part2Name, connector: conn };
            }
        }

        // 无连接词：直接拼接模式，rest本身就是part2（没有“伴/及”这类词）
        if (rest && rest !== preDataName) {
            return { part2Name: rest, connector: '' };
        }
    }

    // =========情况2：假设 preDataName 出现在 unionName【结尾】=========
    if (idx + preDataName.length === unionName.length) {
        // preDataName 在结尾：unionName = part2 + 连接词? + preDataName
        // slice(0, idx)：截取0~idx（不包含idx），拿到组分A前面全部字符串 pre
        const pre = unionName.slice(0, idx);
        // 判断前面字符串pre是否以某个连接词结尾
        for (const conn of CONNECTORS) {
            if (pre.endsWith(conn)) {
                // pre.slice(0, pre.length - conn.length)：把末尾的连接词截掉，得到part2文本
                const part2Name = pre.slice(0, pre.length - conn.length);

                // part2不为空，并且不能和preData完全相同，禁止A+A无效组合，返回切分结果
                if (part2Name && part2Name !== preDataName)
                    return { part2Name, connector: conn };
            }
        }

        // 无连接词：直接拼接模式，pre本身就是part2（没有“伴/及”这类词）
        if (pre && pre !== preDataName) {
            return { part2Name: pre, connector: '' };
        }
    }

    // 以上全部条件不满足，切分失败返回null
    return null;
}

function containsConnector(s) {
    return CONNECTORS.some(c => s.includes(c));
}

// ------------------------- 输入模板 -------------------------
// 无输入文件时输出（携带参考信息：表头 + 示例数据，示例演示"联合诊断=A+B"）
function createXlsxTemplate(outputPath){
    const headers = ['icd_code', 'icd_name', 'icd_type', 'is_gray'];

    // 示例数据（可选，你也可以只创建带表头的空文件）
    const sampleData = [
        { icd_code: 'A16.201', 'icd_name': '肺结核','icd_type': 10, 'is_gray':0  },
        { icd_code: 'D48.901', 'icd_name': '瘤','icd_type': 10, 'is_gray':0  },
        { icd_code: 'A15.001', 'icd_name': '肺结核瘤','icd_type': 10, 'is_gray':0  }
    ];

    // 创建工作簿
    const workbook = xlsx.utils.book_new();
    const worksheet = xlsx.utils.json_to_sheet(sampleData, { header: headers });
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Sheet1');

    // 写入文件
    xlsx.writeFile(workbook, outputPath);
}

// ------------------------- 索引构建 -------------------------
/**
 * 基于原始ICD行数据构建三类索引：名称→行号、bigram倒排索引、单字兜底索引
 * @param {Array<{code:string,name:string}>} rows icd原始行数组
 * @returns {{nameToIdx:Map<string,number>,bigramIndex:Map<string,number[]>,singleCharIndex:Map<string,number[]>}}
 */
function buildIndexes(rows) {
    // 预计算每条记录的bigram数组，挂载到行对象grams属性
    rows.forEach(row => {
        row.grams = bigrams(row.name);
    });

    // 名字→行号的 映射字典Map（key带icd_type后缀，防止同名条目跨类型串查）
    //{
    //   "肺结核|10": 0,
    //   "瘤|10": 1,
    //   "肺结核瘤|10":2
    //}
    const nameToIdx = new Map();
    rows.forEach((row, index) => {
        const key = row.name + '|' + row.icdType;
        if (!nameToIdx.has(key))
            nameToIdx.set(key, index);
    });

    // bigram 倒排索引：gram → [行索引]
    // "肺结" → [0, 2]      // 第0行、第2行都有“肺结”这两个连续字
    // "结核" → [0, 2]      // 第0行、第2行都有“结核”
    const bigramIndex = new Map();
    rows.forEach((row, index) => {
        // 循环当前疾病所有二字片段
        for (const gram of row.grams) {
            // 去map里找这个二字片段gram对应的数组
            let list = bigramIndex.get(gram);
            // 如果map里还没有这个片段，新建空数组，存进map
            if (!list) {
                list = [];
                bigramIndex.set(gram, list);
            }

            // 把当前行号i加到这个片段对应的数组里
            list.push(index);
        }
    });

    // 单字名称索引：单字 → [行索引]（兜底 bigram 切不出的极短成分，如"瘤"）
    // "瘤" → [1]
    const singleCharIndex = new Map();
    rows.forEach((row, index) => {
        // 只处理：疾病名称长度严格等于1个字的行
        if (row.name.length === 1) {
            let list = singleCharIndex.get(row.name);
            if (!list) {
                list = [];
                singleCharIndex.set(row.name, list);
            }
            list.push(index);
        }
    });

    //返回了三个字典（索引）
    return { nameToIdx, bigramIndex, singleCharIndex };
}

// ------------------------- 候选召回与过滤 -------------------------
/**
 * 针对一条联合诊断，召回候选成分列表，做包含度 过滤，按包含度 降序返回
 * @param {number} unionIdx 当前联合诊断行下标
 * @param {{name:string,grams:string[]}} union 联合诊断行对象
 * @param {Array} rows icd全部行
 * @param {Map} bigramIndex bigram倒排索引
 * @param {Map} singleCharIndex 单字兜底索引
 * @returns {Array<{idx:number,data:object,isSubstring:boolean,range:number}>}
 */
function findPreDatas(unionIdx, union, rows, bigramIndex, singleCharIndex) {
    // 使用Set存储候选行下标，自动去重
    const preDataIdx = new Set();

    // 1. 通过bigram倒排索引，召回有公共二字片段的记录下标，排除自身
    for (const gram of union.grams) {//遍历当前疾病的每一个二字行号碎片
        // 拿二字片段gram去 bigramIndex 倒排索引查，得到所有包含这个片段的行号数组
        const list = bigramIndex.get(gram);
        if (list){// 如果找到了有对应的行（list不为空）
            for (const idx of list) {// 遍历这些行号
                if (idx !== unionIdx) {// idx 不能等于自己这一行（不要把自己当成候选）
                    preDataIdx.add(idx);// 加入候选集合 preDataIdx，这就是候选疾病的行号
                }
            }
        }
    }

    // 2. 单字兜底：遍历联合诊断每个汉字，召回单字诊断条目下标（如"瘤"）
    for (const char of union.name) {//把当前疾病名称，拆成一个个汉字，逐个拿出来
        // 拿单字singleCharIndex 倒排索引查，得到所有包含这个片段的行号数组
        const list = singleCharIndex.get(char);
        if (list){// 如果找到了有对应的行（list不为空）
            for (const idx of list) {// 遍历这些行号
                if (idx !== unionIdx) {// idx 不能等于自己这一行（不要把自己当成候选）
                    preDataIdx.add(idx);// 加入候选集合 preDataIdx，这就是候选疾病的行号
                }
            }
        }
    }

    // 3. 过滤候选：长度必须小于联合诊断；子串直接放行，非子串需要满足包含度阈值
    // 存放最终筛选出来的有效候选列表
    const preDatas = [];

    // 遍历前面通过倒排索引捞出来的候选行号集合（preDataIdx是Set，里面存行下标）
    for (const index of preDataIdx) {
        // 根据行下标取出候选ICD完整记录 存在关联的数据
        const preData = rows[index];

        // 类型闸门：联合诊断与子诊断必须同 icd_type，不允许混合（等值比较，空值===空值视为同型）
        if (preData.icdType !== union.icdType) continue;

        // 候选名称和联合诊断完全一样，跳过（防止数据重复）
        if (preData.name === union.name) continue;

        // 判断：联合诊断的名称文本里，是否完整包含候选的名称
        const isSubstring = union.name.includes(preData.name);

        // range：片段重合度（0~1）
        // 如果是完整子串包含，直接给满分1；否则调用函数基于二字gram计算片段重合度
        let range;

        // 候选文本不能长于等于union+3，才允许计算gram包含度（候选比联合略长的场景）
        if(preData.name.length - union.name.length >= 3){
            range = 0; // 长候选直接打0分
        }else{
            range = isSubstring ? 1 : rangeOf(preData.grams, union.grams);
        }

        // 筛选条件：要么是完整子串，要么gram片段重合度大于等于配置的最低阈值
        if (isSubstring || range >= config.threshold) {
            // 满足条件，压入候选结果数组，带上索引、原始记录、标记、重合度分数
            preDatas.push({ index, preData, isSubstring, range });
        }
    }
    // 将候选列表按照重合度从高到低排序；分数越高排在越前面
    preDatas.sort((a, b) => b.range - a.range);

    // 返回筛选+排序完成的候选集合，供后续业务使用
    return preDatas;
}

// ------------------------- 精确切分 ----------------=========
/**
 * 精确切分：基于文本切割，A是union子串，切掉A之后剩余文本恰好是库中存在的另一条ICD记录B
 * @param {Object} union 当前待拆分联合手术记录
 * @param {Array} preDatas findPreDatas返回候选对象数组
 * @param {Map} nameToIdx 名称→行号索引，用于剩余文本反查part2
 * @param {Array} rows ICD全量数据
 * @param {Set} seen 全局去重集合，避免产出重复【union|A|B】
 * @returns {Array} 精确拆分结果列表 method="exact"
 */
function findExactSplits(union, preDatas, nameToIdx, rows, seen) {
    // 保存本次产生的精确切分结果
    const results = [];

    // 遍历每一个召回后的候选组分（候选part1）
    for (const item of preDatas) {
        // 闸门1：只有候选是union完整子串才允许精确切分；不是子串直接跳过
        if (!item.isSubstring) continue;

        // 调用splitExact文本切割函数：把union.name，把part1(item.preData.name)从union名字里切掉
        // 返回 {part2Name:"xxx", connector:"伴"} 或者 null（切分失败）
        const split = splitExact(union.name, item.preData.name);
        if (!split) continue;// split为null代表文本切分不通过（子串在中间、格式不满足二元切分），直接跳过该候选

        // 使用切分得到的part2文本，去索引查找该手术在全量rows数组中的行下标
        // key拼上icd_type，确保反查到的part2与union同类型，防止同名条目跨类型串查
        const part2Idx = nameToIdx.get(split.part2Name + '|' + union.icdType);
        // ICD库中不存在这个part2手术名称，丢弃该候选
        if (part2Idx === undefined) continue;

        // 防护：禁止part1和part2是同一条数据，避免 A+A 的无效拆分
        if (part2Idx === item.index) continue;

        // 通过下标取出完整的part2手术对象
        const part2 = rows[part2Idx];

        // 构造去重key：union名称 + 排序后的part1、part2名称
        // sort消除顺序问题：A伴B 和 B伴A 生成同一个key，避免重复产出两条记录
        const key = union.name + '|' + [item.preData.name, part2.name].sort().join('|');

        // 该组合已经生成过，跳过，防止重复结果
        if (seen.has(key)) continue;
        // 将组合key加入全局去重集合，标记已生成
        seen.add(key);


        // 组装一条精确切分结果，推入结果数组
        results.push({
            unionCode: union.code,          // 联合手术编码
            unionName: union.name,          // 联合手术名称
            icdType: union.icdType,         // icd_type（联合与两个子诊断同型）
            isGray: union.is_gray,          // 联合灰度
            part1Code: item.preData.code,   // 拆分出来part1手术编码
            part1Name: item.preData.name,   // 拆分出来part1手术名称
            part1Gray: item.preData.is_gray,   // 拆分出来part1灰度
            part2Code: part2.code,          // 拆分出来part2手术编码
            part2Name: part2.name,          // 拆分出来part2手术名称
            part2Gray: part2.is_gray,   // 拆分出来part2灰度
            method: 'exact',                // 标记为精确切分
            // 连接器转换：空字符串（无连接词）显示“（拼接）”，否则直接使用识别到的连接词
            connector: split.connector === '' ? '（拼接）' : split.connector,
            // 置信分数，Math.min钳位，保证分数最大不超过1，item.range为候选匹配置信度
            score: Math.min(1, item.range)
        });
    }

    // 返回全部精确切分结果
    return results;
}

// ------------------------- loose 兜底 -------------------------
/**
 * loose宽松配对拆分：中等置信度
 * 适用场景：精确切分(exact)不满足时兜底；不需要严格文本拼接复原union全名，依靠字符覆盖率做配对
 * 约束：至少2个子串候选；两两组合；过滤全是带连接词的组分；覆盖率达到阈值；全局seen去重
 * @param {Object} union 待拆分联合手术记录 {code,name,grams}
 * @param {Array} preDatas 召回得到的候选组分列表
 * @param {Set<string>} seen 全局去重集合，和外层discover共用，避免重复产出同一套(union,A,B)组合
 * @returns {Array<Object>} loose拆分结果数组，method='loose'
 */
function findLoosePairs(union, preDatas, seen) {
    // 过滤：只保留是union名称子串的候选
    const substrCands = preDatas.filter(row => row.isSubstring);
    // 宽松配对需要至少2个候选才能两两组合，不足2个直接返回空数组
    if (substrCands.length < 2) return [];

    const results = [];
    // 记录当前union已经生成多少条loose结果，用来控制单条union产出上限
    let added = 0;

    // substrCands已经按照匹配置信度(包含度)降序排序；截取top‑6高得分候选，避免组合爆炸
    const top = substrCands.slice(0, config.fuzzyTopK);

    // 双重循环：两两组合；a<b避免(A,B)、(B,A)重复；added控制单条union最大产出条数
    for (let a = 0; a < top.length && added < config.fuzzyMaxPerunion; a++) {
        for (let b = a + 1; b < top.length && added < config.fuzzyMaxPerunion; b++) {
            const item1 = top[a];
            const item2 = top[b];

            // 防护：两个组分名称完全相同，跳过，避免A+A无效组合
            if (item1.preData.name === item2.preData.name) continue;

            // 规则约束：至少一个组分不能包含连接词（伴/及/和/并）
            // 如果两个组分都自带连接词，说明本身就属于联合手术，不适合作为子组分，直接跳过
            if (containsConnector(item1.preData.name) && containsConnector(item2.preData.name)) continue;

            // coverageOf：计算两个组分ngram片段合并后对union的整体字符覆盖率
            const cov = coverageOf(item1.preData.grams, item2.preData.grams, union.grams);
            // 覆盖率低于配置阈值，认为信息不足，丢弃该组合
            if (cov < config.looseCoverageMin) continue;

            // 构造去重key：名称sort排序，消除(A,B)/(B,A)顺序差异
            const key = union.name + '|' + [item1.preData.name, item2.preData.name].sort().join('|');
            // 该组合已经生成过，跳过
            if (seen.has(key)) continue;
            seen.add(key);

            // 组装loose结果对象
            results.push({
                unionCode: union.code,
                unionName: union.name,
                icdType: union.icdType,        // icd_type（联合与两个子诊断同型）
                isGray: union.is_gray,          // 联合灰度
                part1Code: item1.preData.code,
                part1Name: item1.preData.name,
                part1Gray: item1.preData.is_gray,
                part2Code: item2.preData.code,
                part2Name: item2.preData.name,
                part2Gray: item2.preData.is_gray,
                method: 'loose',          // 标记为宽松配对
                connector: '未知',         // loose不解析连接词，填未知
                score: Math.min(item1.range, item2.range) // 取两个组分匹配置信度较小值作为本条结果分数
            });
            // 计数+1，用于控制单条union最多产出结果数量
            added++;
        }
    }
    return results;
}

// ------------------------- 模糊配对 -------------------------
// 召回"别名/缩写"型（至少一个成分不是子串），覆盖率极高才收，交 AI 筛
function findFuzzyPairs(union, preDatas, seen) {
    // 候选不足2个，无法两两配对，直接返回空数组
    if (preDatas.length < 2) return [];

    // 截取得分最高的top‑K候选，避免候选过多造成组合爆炸，由配置控制数量
    const top = preDatas.slice(0, config.fuzzyTopK);

    const results = [];
    // 记录当前union已经生成多少条fuzzy结果，控制单条union产出上限
    let added = 0;

    // 双重循环两两组合；a<b避免(A,B)与(B,A)重复；added控制单条union最大产出条数
    for (let a = 0; a < top.length && added < config.fuzzyMaxPerunion; a++) {
        for (let b = a + 1; b < top.length && added < config.fuzzyMaxPerunion; b++) {
            const item1 = top[a];
            const item2 = top[b];

            // 防护：两个组分名称完全相同，禁止A+A无效组合，直接跳过
            if (item1.preData.name === item2.preData.name) continue;

            // 核心规则：不能两个组分全都是union的子串
            // 如果两者都是子串，那么该组合理论上应该已经被exact或者loose处理，不需要走模糊流程
            if (item1.isSubstring && item2.isSubstring) continue;

            // 约束：两个组分都不能自带连接词（伴/及/和/并）
            // 带连接词代表组分本身就是联合手术，不能作为子拆分成分
            if (containsConnector(item1.preData.name) || containsConnector(item2.preData.name)) continue;

            // 组分各自的匹配置信度必须达到模糊模式最低阈值，任意一个不满足则丢弃
            if (item1.range < config.fuzzyContMin || item2.range < config.fuzzyContMin) continue;

            // 计算两个组分ngram合并后对union的片段覆盖率
            const cov = coverageOf(item1.preData.grams, item2.preData.grams, union.grams);
            // 覆盖率达不到模糊模式阈值，片段重合太少，直接丢弃
            if (cov < config.fuzzyCoverageMin) continue;

            // 构造去重key，sort排序消除A/B顺序差异，复用全局seen集合
            const key = union.name + '|' + [item1.preData.name, item2.preData.name].sort().join('|');
            // 该组合已经产出过，跳过
            if (seen.has(key)) continue;
            seen.add(key);

            // 组装模糊配对结果
            results.push({
                unionCode: union.code,
                unionName: union.name,
                icdType: union.icdType,        // icd_type（联合与两个子诊断同型）
                isGray: union.is_gray,
                part1Code: item1.preData.code,
                part1Name: item1.preData.name,
                part1Gray: item1.preData.is_gray,
                part2Code: item2.preData.code,
                part2Name: item2.preData.name,
                part2Gray: item2.preData.is_gray,
                method: 'ngram',       // 标记为ngram模糊配对
                connector: '',         // 模糊模式无法识别连接词，填空
                score: Math.min(item1.range, item2.range) // 取两个组分置信度较小值作为本条得分
            });
            // 计数+1，用于控制单条union最大产出数量
            added++;
        }
    }
    return results;
}

// ------------------------- 子序列配对 -------------------------
/**
 * 判断 candName 是否为 unionName 的非连续子序列，并返回贪心命中的位置数组
 * 非连续子序列 = unionName 删掉若干字符后恰好等于 candName（如 union 去掉"开窗"得成分）
 * @param {string} candName 候选成分名称
 * @param {string} unionName 联合诊断名称
 * @returns {number[]|null} 命中位置数组（下标递增），不是子序列返回 null
 */
function matchSubseqPositions(candName, unionName) {
    const pos = [];
    let j = 0;
    // 贪心：从左到右扫 union，按顺序匹配 cand 的每个字符
    for (let i = 0; i < unionName.length && j < candName.length; i++) {
        if (unionName[i] === candName[j]) {
            pos.push(i);
            j++;
        }
    }
    // cand 全部字符都按序命中才是子序列
    return j === candName.length ? pos : null;
}

/**
 * 子序列配对（术式修饰词型）：union = 成分A + 修饰词(如"开窗") + 成分B
 * 适用场景：成分文字按序散布在 union 中，但被修饰词隔断、不是连续子串，exact/loose 均无法命中
 * 约束：成分是 union 非连续子序列、增量字符数 ≤ subseqMaxGap、双成分合并字符覆盖率达标、至少一个成分非子串；全局seen去重
 * 输出 connector 字段携带增量文本（union 中未被覆盖的字符），供 AI 筛选阶段重点审查
 * @param {Object} union 待拆分联合诊断记录 {code,name,grams}
 * @param {Array} preDatas 召回得到的候选组分列表
 * @param {Set<string>} seen 全局去重集合
 * @returns {Array<Object>} 子序列配对结果数组，method='subseq'
 */
function findSubseqPairs(union, preDatas, seen) {
    // 预计算：每个候选作为 union 非连续子序列时的命中位置数组
    const cands = [];
    for (const item of preDatas) {
        // 带连接词的候选本身就是联合术式，不能作为子拆分成分
        if (containsConnector(item.preData.name)) continue;

        // gap = union长度 - 候选长度，即该成分相对 union 缺失的字符数（增量文本字数）
        const gap = union.name.length - item.preData.name.length;

        // 增量字符数须在 [1, subseqMaxGap]：0=同名（已过滤），过大说明差异超出"修饰词"范畴
        if (gap < 1 || gap > config.subseqMaxGap) continue;

        //判断 candName 是否为 unionName 的非连续子序列
        const pos = matchSubseqPositions(item.preData.name, union.name);
        if (!pos) continue; // 不是子序列
        cands.push({ item, pos });
    }

    if (cands.length < 2) return [];

    // 按成分长度降序（增量越小越可信）取 top-6，避免组合爆炸
    cands.sort((a, b) => b.item.preData.name.length - a.item.preData.name.length);
    const top = cands.slice(0, config.subseqTopK);

    const results = [];
    let added = 0;

    // 双重循环两两组合；a<b避免(A,B)与(B,A)重复；added控制单条union产出上限
    for (let a = 0; a < top.length && added < config.subseqMaxPerunion; a++) {
        for (let b = a + 1; b < top.length && added < config.subseqMaxPerunion; b++) {
            const cand1 = top[a];
            const cand2 = top[b];

            // 防护：两个组分名称完全相同，禁止A+A无效组合
            if (cand1.item.preData.name === cand2.item.preData.name) continue;

            // 两个都是子串的组合应由 exact/loose 处理，子序列通道要求至少一个非子串
            if (cand1.item.isSubstring && cand2.item.isSubstring) continue;

            // 合并两个成分的命中位置，计算对 union 的字符覆盖率
            const covered = new Set([...cand1.pos, ...cand2.pos]);
            const coverage = covered.size / union.name.length;
            // 覆盖率低于阈值，说明未覆盖字符过多（不止修饰词），丢弃
            if (coverage < config.subseqCoverageMin) continue;

            // 提取增量文本：union 中未被任何成分覆盖的字符（按原顺序）
            let gapText = '';
            for (let i = 0; i < union.name.length; i++) {
                if (!covered.has(i)) gapText += union.name[i];
            }

            // 构造去重key，sort排序消除A/B顺序差异，复用全局seen集合
            const key = union.name + '|' + [cand1.item.preData.name, cand2.item.preData.name].sort().join('|');
            if (seen.has(key)) continue;
            seen.add(key);

            // 组装子序列配对结果，connector 携带增量文本供 AI 筛审查
            results.push({
                unionCode: union.code,
                unionName: union.name,
                icdType: union.icdType,        // icd_type（联合与两个子诊断同型）
                isGray: union.is_gray,
                part1Code: cand1.item.preData.code,
                part1Name: cand1.item.preData.name,
                part1Gray: cand1.item.preData.is_gray,
                part2Code: cand2.item.preData.code,
                part2Name: cand2.item.preData.name,
                part2Gray: cand2.item.preData.is_gray,
                method: 'subseq',        // 标记为子序列配对（术式修饰词型）
                connector: gapText ? `${gapText}` : '',
                score: Math.min(1, coverage) // 以合并字符覆盖率作为置信分
            });
            added++;
        }
    }
    return results;
}

// ------------------------- 核心发现逻辑 -------------------------
/**
 * ICD联合诊断发现入口，遍历全部ICD记录执行三套匹配策略
 * @param {Array} rows icd源数据行数组
 * @returns {{results:Array,exactCount:number,looseCount:number,ngramCount:number}}
 */
function discover(rows) {
    // buildIndexes 构建全部索引
    const { nameToIdx, bigramIndex, singleCharIndex } = buildIndexes(rows);

    const results = [];
    // 全局去重集合，防止同一个（联合,A,B）组合重复产出
    const seen = new Set();
    // 统计计数器
    let exactCount = 0, looseCount = 0, subseqCount = 0, ngramCount = 0;

    // 遍历每一条ICD记录，把每一条都当做潜在联合诊断
    for (let i = 0; i < rows.length; i++) {
        const union = rows[i];
        // 召回该联合诊断的候选成分列表
        const preDatas = findPreDatas(i, union, rows, bigramIndex, singleCharIndex);
        if (preDatas.length === 0) continue;

        // 1. 精确切分（高置信）
        // findExactSplits：做文本精确拼接匹配，A名称+B名称拼起来和union文本吻合，属于可靠拆分
        const exactResults = findExactSplits(union, preDatas, nameToIdx, rows, seen);
        // 将精确切分结果存入总结果集
        exactResults.forEach(row => results.push(row));
        // 累加精确切分产出条数
        exactCount += exactResults.length;
        // 标记：本条union是否已经找到精确切分结果
        const exactFound = exactResults.length > 0;

        // 2. loose 兜底：精确切分失败 + 两个子串候选覆盖率够高 → 产出低置信记录
        // 精确切分失败时才进入：不需要严格文本复原，依靠两个候选子串覆盖率打分配对
        let looseFound = false;
        if (!exactFound) {
            // 调用宽松配对函数：不要求文本严格复原，依靠候选子串覆盖程度做配对拆分
            const looseResults = findLoosePairs(union, preDatas, seen);
            // 将宽松配对产出的结果追加到全局结果数组
            looseResults.forEach(row => results.push(row));
            // 累加宽松配对产出的记录条数，用于后期统计评估
            looseCount += looseResults.length;
            looseFound = looseResults.length > 0;
        }

        // 3. 子序列配对（术式修饰词型）：成分被"开窗"等修饰词隔断、非连续子串时的补足召回
        // 精确切分与 loose 均未命中时进入；命中后 connector 携带增量文本，供 AI 筛选重点审查
        let subseqFound = false;
        if (!exactFound && !looseFound) {
            const subseqResults = findSubseqPairs(union, preDatas, seen);
            subseqResults.forEach(row => results.push(row));
            subseqCount += subseqResults.length;
            subseqFound = subseqResults.length > 0;
        }

        // 4. 模糊配对（别名/缩写型，仅在没有更高置信结果时补足召回）
        // 有精确/loose/subseq 结果则直接跳过，避免引入噪声
        if (!exactFound && !looseFound && !subseqFound) {
            // 调用模糊配对函数：基于字符片段、ngram做近似匹配，允许不完全文本匹配，召回别名、缩写类拆分
            const fuzzyResults = findFuzzyPairs(union, preDatas, seen);
            // 将模糊配对产出的结果追加到全局结果数组
            fuzzyResults.forEach(row => results.push(row));
            // 累加模糊配对产出记录条数，用于离线统计、效果评估
            ngramCount += fuzzyResults.length;
        }
    }

    return { results, exactCount, looseCount, subseqCount, ngramCount };
}

function readExcel(file,sheet) {
    // 1. 读取工作簿（启用公式计算）
    const workbook = xlsx.readFile(file.path);

    const sheetToRead = sheet || workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetToRead];

    if (!worksheet) {
        throw new Error(`工作表 "${sheetToRead}" 不存在，可用工作表: ${workbook.SheetNames.join(', ')}`);
    }

    // 3. 返回结构化结果：表头 icd_code/icd_name/is_gray 映射为内部 code/name/is_gray，跳过无名称行
    return xlsx.utils.sheet_to_json(worksheet)
        .map(r => ({ code: r.icd_code, name: r.icd_name, is_gray: r.is_gray, icdType: r.icd_type }))
        .filter(r => r.name);
}

function writeOutput(results, outputPath){
    const header = [
        '联合编码', '联合名称','联合是否灰度',
        'ICD10编码1', 'ICD10名称1','1是否灰度',
        'ICD10编码2', 'ICD10名称2','2是否灰度',
        '匹配方式', '关联得分', '连接词'
    ];

    const aoa = [header];
    for (const result of results) {
        aoa.push([
            result.unionCode, result.unionName, result.isGray,
            result.part1Code, result.part1Name, result.part1Gray,
            result.part2Code, result.part2Name, result.part2Gray,
            result.method, result.score.toFixed(3), result.connector
        ]);
    }

    // 创建工作簿
    const workbook = xlsx.utils.book_new();
    const worksheet = xlsx.utils.aoa_to_sheet(aoa);
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Sheet1');

    // 写入文件
    xlsx.writeFile(workbook, outputPath);
}

// ------------------------- 框架入口 -------------------------
function writingRules(inputArray, outputNodeTemplate) {
    const outputDir = outputNodeTemplate.path // 输出目录绝对路径
    // 优先从真实输入节点反推输入目录（避免硬编码 inputDir 目录名）；无任何输入文件时退回同级 inputDir
    const firstInput = (inputArray || [])[0];
    const inputPath = firstInput ? path.dirname(firstInput.path) : path.join(outputDir, '../inputDir');
    const demoPath = path.join(inputPath, 'data.xlsx')
    const outputPath = path.join(outputDir, 'result.xlsx') // 输出目录绝对路径

    // 1. 定位输入 Excel（取第一个 xlsx 节点）；无输入文件时直接生成携带参考信息的输入模板
    const xlsxFile = (inputArray || []).find(item => item.normExt === 'xlsx' && item.name === 'data');

    if (!xlsxFile) {
        fs.mkdirSync(inputPath, { recursive: true });
        createXlsxTemplate(demoPath);
        return [{ ...outputNodeTemplate, content: '错误: 未找到 data.xlsx 文件,示例文件已创建' }];
    }

    // 2. 读取源表
    const rows = readExcel(xlsxFile);
    console.log(`已加载 ${rows.length} 条记录（来自 ${xlsxFile.path}）\n`);

    // 3. 运行发现
    const { results, exactCount, looseCount, subseqCount, ngramCount } = discover(rows);

    // 4. 写出预结果 xlsx（写入框架提供的输出目录）
    writeOutput(results, outputPath);

    // 5. 日志
    console.log(`源表行数: ${rows.length}`);
    console.log(`精确配对(exact): ${exactCount}`);
    console.log(`兜底配对(loose): ${looseCount}`);
    console.log(`子序列配对(subseq): ${subseqCount}`);
    console.log(`模糊配对(ngram): ${ngramCount}`);
    console.log(`预结果总条数: ${results.length}`);
    console.log('已写出:', outputPath);

    // 6. 返回状态节点：path 必须保持输出目录（框架契约：path 仅允许目录），
    //    预结果 xlsx 已由 writeOutput 直接写入 outputDir，这里只补一份 json 摘要
    const summary = {
        sourceRows: rows.length,
        exactCount,
        looseCount,
        subseqCount,
        ngramCount,
        total: results.length,
        outputFile: outputPath
    };
    return [{
        ...outputNodeTemplate,
        fileName: `result`,
        normExt: 'json',
        content: JSON.stringify(summary, null, 2)
    }];
}

module.exports = {
    name: 'icd10check',
    version: '1.1.0',
    process: writingRules,
    description: 'ICD 联合诊断发现器：基于 bigram 倒排索引(blocking)+成分包含度(range)，从 ICD10 名称表中自动发现"联合诊断=A+B"的预结果（精确切分 exact + 兜底 loose + 子序列 subseq + 模糊配对 ngram），供后续人工/AI 筛选',
    notes: {
        node: '18.20.4',
        tips: [
            '输入约定：文件名 data.xlsx，第一个 sheet，A 列=ICD10 编码、B 列=ICD10 名称、C 列=icd_type、首行表头；无数据时自动输出输入模板',
            '类型约束：联合诊断与两个子诊断必须同 icd_type，跨类型候选在召回阶段即被拦截，不会产出混合组合',
            '输出：在框架输出目录生成 result.xlsx（预结果表）与 result.json（运行摘要），列含 联合编码/联合名称/icd类型/两个成分编码名称/匹配方式/关联得分/连接词',
            'method=exact 高置信精确切分；method=loose 双子串兜底（连接词未知，建议优先审）；method=subseq 术式修饰词型（连接词列为"xx"，即 union 中未被成分覆盖的修饰文本，建议重点审）；method=ngram 别名/缩写型模糊召回',
            '阈值集中在脚本顶部 config，按需调整'
        ],
        // 新增：四个匹配策略的详细说明
        strategies: {
            exact: {
                label: '精确切分',
                description: '基于文本子串切割，要求两个成分的名称拼接后恰好等于联合诊断名称（连接词可为已知列表中的词或无连接词）。高置信度，建议人工/AI复审。'
            },
            loose: {
                label: '兜底配对',
                description: '当精确切分失败时，两个候选成分均为联合诊断的子串，通过双成分合并后的 n‑gram 覆盖率（≥ looseCoverageMin）产生中等置信度结果。连接词未知，建议人工/AI优先审查。'
            },
            subseq: {
                label: '子序列配对（术式修饰词型）',
                description: '成分按序散布在联合诊断中，但被修饰词（如“开窗”）隔断，并非连续子串。通过非连续子序列匹配，且增量字符数 ≤ subseqMaxGap，双成分合并字符覆盖率 ≥ subseqCoverageMin。连接词字段携带未被覆盖的修饰文本，供AI重点审查。'
            },
            ngram: {
                label: '模糊配对（别名/缩写型）',
                description: '至少一个成分不是联合诊断的子串，依靠 n‑gram 重合度（每个成分的包含度 ≥ fuzzyContMin 且合并覆盖率 ≥ fuzzyCoverageMin）进行召回。置信度较低，专为别名/缩写设计，需AI筛选。'
            }
        }
    },
    input: {
        normExt: 'xlsx文件',
        format: 'Excel：约定 data.xlsx，第一个 sheet，A 列编码 + B 列名称 + C 列 icd_type，首行表头'
    },
    output: {
        normExt: 'xlsx文件',
        format: '预结果表：联合编码,联合名称,icd类型,ICD10编码1,ICD10名称1,ICD10编码2,ICD10名称2,匹配方式,关联得分,连接词'
    },
    rely: {
        'xlsx': '0.18.0'
    },
};
