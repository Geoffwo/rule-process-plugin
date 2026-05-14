const mysql = require('mysql2/promise');
const xlsx = require('xlsx');
const path = require("path");

function createJsonTemplate(){
  return {
    config:{
      host: 'localhost',       // MySQL 地址
      user: 'root',            // MySQL 用户名
      password: 'Dareway@12',     // MySQL 密码
      database: 'test_migration',    // 要查询的数据库
      port: 3306,               // 端口默认3306
    },
    sql2xlsx:{
      '导出文档1':'SELECT * FROM test_migration.t_department WHERE 1=1'
    }
  }
}


function writeXlsx(rows,outputPath){
  // 3. 生成 Excel 工作簿
  const worksheet = xlsx.utils.json_to_sheet(rows); // JSON 转工作表
  const workbook = xlsx.utils.book_new(); // 创建工作簿
  xlsx.utils.book_append_sheet(workbook, worksheet,'Sheet1'); // 添加工作表

  xlsx.writeFile(workbook, outputPath);
  console.log(`Excel 导出成功！文件：${outputPath} `);
}

async function writingRules(inputArray, outputNodeTemplate) {
  const outputDir = outputNodeTemplate.path // 临时目录绝对路径
  const inputPath = path.join(outputDir, '../inputDir');

  const dbFile = inputArray.find(item => item.normExt === 'json' && item.name === 'db');

  if (!dbFile) {
    const jsonTemplate = createJsonTemplate();
    return [
      { ...outputNodeTemplate, content: '错误: 未找到 db.json 文件,示例文件已创建' },
      {...outputNodeTemplate, path: inputPath, fileName: 'db',normExt:'json', content: JSON.stringify(jsonTemplate, null, 2)}
    ];
  }
  const dbInfo = JSON.parse(dbFile.content)

  const content = []

  let connection;
  try {
    // 1. 连接数据库
    console.log('正在连接 MySQL...');
    connection = await mysql.createConnection(dbInfo.config);
    console.log('MySQL 连接成功 ');

    const keys = Object.keys(dbInfo.sql2xlsx);

    for (const key of keys) {
      // 2. 执行查询
      console.log('正在执行查询...');
      const [rows] = await connection.query(dbInfo.sql2xlsx[key]);

      if (rows.length === 0) {
        content.push({
          sql:key,
          msg:'查询结果为空，退出'
        })
        console.log('查询结果为空，退出');
        continue;
      }

      content.push({
        sql:key,
        msg:`查询成功，共 ${rows.length} 条数据`
      })
      console.log(`查询成功，共 ${rows.length} 条数据`);

      const outputPath = path.join(outputDir, `${key}.xlsx`) // 临时目录绝对路径
      writeXlsx(rows,outputPath)
    }
  } catch (error) {
    console.error('执行失败 ：', error.message);
  } finally {
    // 关闭数据库连接
    if (connection) {
      await connection.end();
      console.log('MySQL 连接已关闭');
    }
  }

  return [
      {...outputNodeTemplate, fileName: 'result', normExt:'json', content: JSON.stringify(content, null, 2)}
  ];
}

// module.exports = writingRules; // 导出主处理函数

module.exports = {
  name: 'mysql2xlsx',
  version: '1.0.0',
  process: writingRules,
  description:'根据配置文件，将查询结果批量导出为xlsx',
  notes:{
    node:'18.20.4',
  },
  input: {
    normExt: 'json配置文件'
  },
  output: {
    normExt: 'xlsx文件',
  },
  reject:{

  },
  rely:{//默认 latest
    'xlsx': '0.18.0',
    "mysql2": "3.22.3",
  }
};