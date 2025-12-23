function writingRules(inputArray, outputNodeTemplate) {
    // 过滤出sql文件
    const sqlFiles = inputArray.filter(item => item.normExt === 'sql');

    if (sqlFiles.length === 0) {
        console.log('未找到 sql文件，正在生成默认 sql模板...');
        const defaultJsonTemplate = createDefaultSqlTemplate();
        return [
            {...outputNodeTemplate, content: '错误: 未找到sql文件,已创建示例文件'}, // 修正文案错误（json→sql）
            {...outputNodeTemplate, fileName: 'template', normExt: 'sql', content: defaultJsonTemplate}
        ];
    }

    const result = []
    sqlFiles.forEach(sqlFile => {
        const sqlContent = processSql(sqlFile);
        result.push({
            ...outputNodeTemplate,
            fileName: 'result',
            normExt: 'sql',
            content: sqlContent
        })
    });

    // 处理每个文件并生成输出节点
    return result;
}

function processSql(sqlFile) { // 移除多余的contents参数
    let transformedContent = '';
    try {
        const sqlData = sqlFile.content || ''; // 增加空值保护

        // 修复后的正则表达式：
        // 1. 表名支持 纯字母/字母.字母 两种格式
        // 2. 允许语句跨多行（[\s\S]匹配所有字符，包括换行）
        // 3. 非贪婪匹配改为合理的贪婪匹配，确保捕获完整内容
        const insertRegex = /INSERT\s+INTO\s+([\w\.]+)\s*\(([\s\S]*?)\)\s*VALUES\s*\(([\s\S]*?)\);/gis;

        let match;

        // 循环查找所有匹配项
        while ((match = insertRegex.exec(sqlData)) !== null) {
            console.log('匹配到INSERT语句:', match[0]);
            const [fullMatch, tableName, columnsStr, valuesStr] = match;

            // 解析列名和值（清理换行和多余空格）
            const columns = columnsStr.replace(/\s+/g, ' ').split(',').map(col => col.trim());
            const values = parseValues(valuesStr.replace(/\s+/g, ' ')); // 清理值中的换行/多空格

            // 找到 CONTENT 列的索引（不区分大小写）
            const contentIndex = columns.findIndex(col => col.toUpperCase() === 'CONTENT');

            let contentValue = '';
            if (contentIndex !== -1 && contentIndex < values.length) {
                contentValue = values[contentIndex];
                // 特殊处理：如果CONTENT值是空字符串，给默认值避免语法错误
                if (contentValue === "''") {
                    contentValue = "'默认内容'";
                }
            }

            // 构建 VALUES 子句的新内容，替换CONTENT为V_clobdata
            const newValues = values.map((val, index) => {
                return index === contentIndex ? 'V_clobdata' : val;
            }).join(', ');

            // 组装成目标 PL/SQL 格式
            const plsqlBlock = `
DECLARE
    V_clobdata CLOB := ${contentValue || "''"};
BEGIN
    INSERT INTO ${tableName} (${columnsStr.replace(/\s+/g, ' ')})
    VALUES (${newValues});
    COMMIT;
END;`; // 增加/表示PL/SQL块结束，符合Oracle规范
            console.log('生成的PL/SQL块:', plsqlBlock);
            transformedContent += plsqlBlock + '\n'; // 分隔多个块，提升可读性
        }

        // 如果没有匹配到任何INSERT语句，给出提示
        if (transformedContent === '') {
            transformedContent = '-- 未找到有效的INSERT INTO ... VALUES ...; 语句\n';
        }

    } catch (writeError) {
        console.error(`处理SQL失败：${writeError.message}`, writeError.stack);
        transformedContent = `-- 处理失败：${writeError.message}\n`;
    }

    console.log('最终转换结果:', transformedContent);
    return transformedContent;
}

/**
 * 解析 VALUES 子句中的值列表，正确处理包含逗号的字符串。
 * @param {string} valuesStr - VALUES 子句中的内容，例如: 'a', 123, 'b,c'
 * @returns {string[]} - 解析后的值数组
 */
function parseValues(valuesStr) {
    const values = [];
    let currentValue = '';
    let inQuotes = false;

    // 空值保护
    if (!valuesStr) return values;

    for (const char of valuesStr) {
        if (char === "'") {
            inQuotes = !inQuotes;
            currentValue += char;
        } else if (char === ',' && !inQuotes) {
            // 遇到逗号且不在引号内，说明是一个值的结束
            values.push(currentValue.trim());
            currentValue = '';
        } else {
            currentValue += char;
        }
    }

    // 添加最后一个值
    if (currentValue.trim()) {
        values.push(currentValue.trim());
    }

    return values;
}

function createDefaultSqlTemplate() {
    // 默认SQL模板：模拟包含CONTENT大字段的Oracle INSERT语句场景
    return `
-- 示例1：单条INSERT语句（含长文本CONTENT字段）
INSERT INTO T_POWER_STATISTICS (ID, AREA_NAME, INDUSTRY, CONTENT, CREATE_TIME) 
VALUES (1, '市南', '24.汽车制造业', '{"序号":71,"用电客户数-本月":0,"售电量-本月":0,"电力景气指数":0,"详细数据":{"月度统计":[123,456,789],"年度统计":[987,654,321]}}', SYSDATE);

-- 示例2：多条INSERT语句（不同区域，含更长的CONTENT内容）
INSERT INTO database.T_POWER_STATISTICS (ID, AREA_NAME, INDUSTRY, CONTENT, CREATE_TIME) 
VALUES (2, '市北', '24.汽车制造业', '{"序号":71,"用电客户数-本月":0,"用电客户数-同期":1,"运行容量-本月":0,"运行容量-同期":315,"售电量-本月":0,"售电量-同期":30421,"售电量-本月同比增速（%）":-100,"售电量-本年累计":0,"售电量-同期累计":30421,"售电量-累计同比增速（%）":-100,"用电增长指数":0,"规模增长指数":0,"电力景气指数":0,"扩展信息":{"区域特征":"工业集中区","用电类型":"生产用电","备注":"无异常"}}', SYSDATE);

INSERT INTO T_POWER_STATISTICS (ID, AREA_NAME, INDUSTRY, CONTENT, CREATE_TIME) 
VALUES (3, '李沧', '24.汽车制造业', '{"序号":71,"行业":"    24.汽车制造业","用电客户数-本月":14,"用电客户数-同期":15,"运行容量-本月":12219,"运行容量-同期":11819,"售电量-本月":1879536,"售电量-同期":1346038,"售电量-本月同比增速（%）":39.634690848252426,"售电量-本年累计":1879536,"售电量-同期累计":1346038,"售电量-累计同比增速（%）":39.634690848252426,"用电增长指数":139.63,"规模增长指数":103.38,"电力景气指数":132.38,"明细数据":[{"时段":"早高峰","用电量":50000},{"时段":"午高峰","用电量":60000},{"时段":"晚高峰","用电量":80000},{"时段":"低谷","用电量":20000}],"统计时间":"2025-12","数据来源":"电力营销系统"}', SYSDATE);
    `;
}

module.exports = {
    name: 'sql2format',
    version: '1.0.0',
    process: writingRules,
    description: '主要用于将oracle的insert语句转变为PL/SQL格式-防止但内容长度过长-泰安专项脚本',
    notes: {
        node: '18.20.4',
    },
    input: {
        normExt: 'sql文件',
        format: 'INSERT INTO xxx VALUES (xxx);'
    },
    output: {
        normExt: 'sql文件',
        format: `DECLARE
                V_clobdata CLOB := xxx;
            BEGIN
                INSERT INTO xxx (xxx)
                VALUES (xxxx);
                COMMIT;
            END;`
    },
};