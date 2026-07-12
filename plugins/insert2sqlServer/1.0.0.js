const sql = require('mssql');

// ==================== 工具函数 & 常量定义 ====================
// 正则：匹配单条 INSERT 语句（去掉全局g，改用循环截取文本）
const INSERT_REG = /INSERT\s+[\s\S]*?;/;
const STAT_BATCH_SIZE = 50;

/**
 * 字节单位格式化（B/KB/MB）
 * @param {number} bytes 原始字节数
 * @param {number} decimals 保留小数位数
 * @returns {string} 格式化后带单位的字符串
 */
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const dm = Math.max(decimals, 0);
    const sizes = ['B', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

/**
 * 构建单条SQL执行错误日志文本
 * @param {string} fileName 源SQL文件名
 * @param {number} sqlNo 当前SQL序号
 * @param {string} sql 执行失败的SQL语句
 * @param {string} errMsg 错误描述信息
 * @returns {string} 拼接好的日志内容
 */
function buildErrorSqlLog(fileName, sqlNo, sql, errMsg) {
    const now = new Date().toISOString();
    return `
[${now}] 来源文件: ${fileName}
SQL 序号: ${sqlNo}
错误信息: ${errMsg}
执行失败SQL:
${sql}
--------------------------------------------------------
`;
}

// ==================== MSSQL 连接配置 & 连接池 ====================
const dbConfig = {
    user: 'sa',            // 账号
    password: '123456',    // 密码
    server: 'localhost',   // 地址
    database: 'demo',      // 库名
    port: 1433,            // MSSQL 默认端口
    options: {
        encrypt: false,    // 本地测试关闭加密，线上建议开启 true
        trustServerCertificate: true
    },
    pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
    }
};

// 创建连接池
const pool = new sql.ConnectionPool(dbConfig);

/**
 * 构建实时统计快照
 * @param {Array} allFileResults 已处理完成的文件统计数组
 * @param {string} fileName 当前处理文件名
 * @param {number} fileSize 当前文件大小
 * @param {number} stmtCount 当前文件总SQL条数
 * @param {number} successCount 当前文件执行成功数
 * @param {number} failCount 当前文件执行失败数
 * @param {string} status 文件处理状态
 * @returns {Array} 拼接后的完整统计快照
 */
function buildStatSnapshot(allFileResults, fileName, fileSize, stmtCount, successCount, failCount, status) {
    const snapshot = [...allFileResults];
    if (fileName) {
        snapshot.push({
            fileName,
            fileSize,
            totalSql: stmtCount,
            success: successCount,
            fail: failCount,
            status
        });
    }
    return snapshot;
}

// ==================== 主处理生成器函数（流式处理入口） ====================
async function* writingRules(inputArray, outputNodeTemplate) {
    const sqlFiles = inputArray.filter(item => item.normExt === 'sql');
    if (sqlFiles.length === 0) {
        console.error('错误: 未找到 sql 文件');
        return;
    }

    const totalFile = sqlFiles.length;
    const allFileResults = [];

    for (let i = 0; i < totalFile; i++) {
        const file = sqlFiles[i];
        const { name, size = 0, stream } = file;

        console.log(`\n===== [${i + 1}/${totalFile}] 开始处理 ${name} 文件 【大小：${formatBytes(size)}】 =====\n`);

        let remainChunk = '';
        let stmtCount = 0;
        let successCount = 0;
        let failCount = 0;
        let readBytes = 0;

        try {
            for await (const chunk of stream()) {
                //标记进度
                readBytes += Buffer.byteLength(chunk);
                const progress = size ? ((readBytes / size) * 100).toFixed(2) : 0;
                console.log(`文件单次读入进度: ${progress}% | ${formatBytes(readBytes)} / ${formatBytes(size)} \n`);

                // 拼接残留 + 当前分片
                let content = remainChunk + chunk;

                // ========== 核心修复：循环截取单条INSERT，不再重复扫描 ==========
                let match;
                // 循环匹配，直到当前 content 里找不到完整 INSERT
                while ((match = content.match(INSERT_REG))) {
                    const sql = match[0].trim();

                    stmtCount++;

                    // 截取：把已匹配到的整条SQL从content中删掉
                    content = content.slice(match.index + match[0].length);

                    // 执行SQL
                    try {
                        await pool.query(sql);
                        successCount++;
                        console.log(`[${name}] SQL#${stmtCount} 执行成功 \x1B[1A\x1B[K`);
                    } catch (sqlErr) {
                        failCount++;
                        console.log(`\n[${name}] SQL#${stmtCount} 失败: ${sqlErr.message} `);
                        const logText = buildErrorSqlLog(name, stmtCount, sql, sqlErr.message);
                        yield [{
                            ...outputNodeTemplate,
                            fileName: 'error_sql',
                            normExt: 'log',
                            content: logText,
                            option: { flag: 'a' }
                        }];
                    }

                    // 批次更新统计日志
                    if (stmtCount % STAT_BATCH_SIZE === 0) {
                        const snapshot = buildStatSnapshot(allFileResults, name, size, stmtCount, successCount, failCount, 'processing');
                        yield [{
                            ...outputNodeTemplate,
                            fileName: 'result',
                            normExt: 'log',
                            content: JSON.stringify(snapshot, null, 2)
                        }];
                        console.log(`[统计] 已处理 ${stmtCount} 条SQL，更新 result.log\n`);
                    }
                }

                // 把当前剩余不完整内容，存入残留，留给下一个chunk
                remainChunk = content;
            }

            // 文件流读完，检查尾部残缺片段
            if (remainChunk.trim()) {
                console.warn(`[${name}] 文件末尾存在残缺SQL片段，已丢弃`);
            }

            // 单文件汇总
            console.log(`===== [${i + 1}/${totalFile}] 处理完成 ${name} 文件 【成功：${successCount} | 失败：${failCount}】=====`);

            allFileResults.push({
                fileName: name,
                fileSize: size,
                totalSql: stmtCount,
                success: successCount,
                fail: failCount,
                hasIncompleteSql: !!remainChunk.trim(),
                status: 'done'
            });

        } catch (readErr) {
            console.error(`读取文件 ${name} 异常：`, readErr);
            allFileResults.push({
                fileName: name,
                fileSize: size,
                totalSql: stmtCount,
                success: successCount,
                fail: failCount,
                error: readErr.message,
                hasIncompleteSql: false,
                status: 'error'
            });
        }
    }

    // 全局汇总
    console.log(`\n==================== 全部任务结束 ====================`);
    console.table(allFileResults);
    console.log(`======================================================`);

    yield [{
        ...outputNodeTemplate,
        fileName: 'result',
        normExt: 'log',
        content: JSON.stringify(allFileResults, null, 2)
    }];

    await pool.end();
}

// ==================== 模块导出 ====================
module.exports = {
    name: 'insert2sqlServer',
    version: '1.0.0',
    mode: 'stream',
    process: writingRules,
    description:'流式解析SQL，单文件独立统计，报错即时yield输出日志，无内存缓存防OOM',
    notes:{
        node:'18.20.4',
    },
    input: {
        normExt: 'sql文件'
    },
    output: {
        normExt: 'log日志文件',
    },
    rely:{//默认 latest
        'mssql':'12.7.0'
    }
};