const xlsx = require('xlsx');
const path = require("path");

// 原始数据映射（电能表资产编号 -> 用户编号/装机容量/拓扑编号）
const meterDataMap = {
    "3730001000000856578557": { userCode: "3700875426338", capacity: 10, topologyNo: 2,name:'陈红' },
    "3730001000000753458280": { userCode: "3701100201957", capacity: 22.75, topologyNo: 8,name:'宋立英' },
    "3730001000000856536755": { userCode: "3700916250269", capacity: 13, topologyNo: 3,name:'任秀山' },
    "3730001000000755104512": { userCode: "3701096500896", capacity: 27.775, topologyNo: 5,name:'梁俊营' },
    "3730001000000753459225": { userCode: "3701100203184", capacity: 22.75, topologyNo: 7,name:'马志' },
    "3730001000000856627965": { userCode: "3701116005170", capacity: 20.71, topologyNo: 10,name:'杜宪英' },
    "3730001000000753378076": { userCode: "3701100211987", capacity: 19.11, topologyNo: 9,name:'刘培玲' },
    "3730001000000806037752": { userCode: "3700875425319", capacity: 5, topologyNo: 1,name:'王玉玲' },
    "3730001000000636910508": { userCode: "3701036564489", capacity: 20, topologyNo: 4,name:'刘孝' },
    "3730001000000753456446": { userCode: "3701097242377", capacity: 20.02, topologyNo: 6,name:'吕传海' },
    "3730001000000888100405": { userCode: "储能", capacity: 215, topologyNo: "储能",name:'' },
    undefined: { userCode: "台区", capacity: 200, topologyNo: "台区",name:'马埠村一号-01' }
};


function writingRules(inputArray, outputNodeTemplate) {
    const outputDir = outputNodeTemplate.path // 临时目录绝对路径
    const inputPath = path.join(outputDir, '../inputDir');

    // 过滤出xlsx文件
    const xlsxFile = inputArray.find(item => item.normExt === 'xlsx' && item.name === '原始数据-出');

    const fileName = `${xlsxFile.name}-格式化.xlsx`
    const outputPath = path.join(inputPath, fileName) // 临时目录绝对路径

    const jsonData = readExcel(xlsxFile);
    const data = processData(jsonData);
    writeExcel(data,outputPath)

    // 处理每个文件并生成输出节点
    // return xlsxFiles.map(file => ({
    //     ...outputNodeTemplate,
    //     fileName:`p-${file.name}`,
    //     normExt:'json',
    //     content: JSON.stringify(readExcel(file),null,2) // 读取Excel内容
    // }));

    return [{...outputNodeTemplate}]
}

function processData(jsonData) {
    // 存储按用户编号分组的数据
    const userGroups = {};
    // 遍历所有Sheet的数据
    jsonData[0].data.forEach(row => {
        // 获取关键字段
        const meterCode = row['电能表资产编号'];
        const timeNode = row['时间节点']; //extractHourMinute(row['时间节点'] || '');
        const realTimeLoad = row['实时负荷'];
        const phaseAVoltage = row['A相电压(V)'];
        const phaseBVoltage = row['B相电压(V)'];
        const phaseCVoltage = row['C相电压(V)'];
        const pvReactivePower = row['光伏无功（kVA）'];
        const installCapacity = row['装机容量'] || (meterDataMap[meterCode].capacity || '');

        // 新增：获取储能相关字段（如果原始Excel中有这些数据）
        const soc = row['SOC'] || '';
        const energyStorageReactive = row['储能无功（kVA）'] || '';
        const energyStorageActive = row['储能有功（kW）'] || '';

        // 确定用户编号（优先用表格中的，没有则从映射表取）
        let userCode = row['用户编号'] || meterDataMap[meterCode].userCode || '未知用户';
        // 处理台区/储能的特殊标识
        if (!meterCode && row['用户编号'] === '台区') userCode = '台区';

        // 跳过无效数据
        if (!timeNode || !meterCode && userCode === '未知用户') return;

        // 初始化用户分组
        if (!userGroups[userCode]) {
            userGroups[userCode] = {
                name: `用户_${userCode}`, // Sheet名称
                capacity: installCapacity, // 装机容量（用于公式计算）
                data: [] // 该用户的所有时段数据
            };
        }

        // 构建单条数据记录
        const dataRecord = {
            "时间节点": timeNode,
            "实时负荷(kW)": realTimeLoad || '',
            "发电效率": '', // 留空，后续用公式填充
            "A相电压(V)": phaseAVoltage || 0,
            "B相电压(V)": phaseBVoltage || 0,
            "C相电压(V)": phaseCVoltage || 0,
            "光伏无功（kVA）": pvReactivePower || '',
            "理论可调最大无功（kVA）": '', // 暂留空，可根据需求补充
            "是否下发成功": '', // 暂留空，可根据需求补充
            "":'',
            "SOC":soc,
            "储能无功（kVA）":energyStorageReactive,
            "储能有功（kW）":energyStorageActive,
            "视在功率（kW）":'',// 留空，后续用公式填充
        };

        userGroups[userCode].data.push(dataRecord);
    });

    // 对每个用户的数据按时间节点升序排序，并处理公式
    const processedSheets = [];
    Object.values(userGroups).forEach(group => {
        // 按时间节点排序（HH:MM格式直接比较）
        group.data.sort((a, b) => {
            return a['时间节点'].localeCompare(b['时间节点']);
        });

        // 创建新的Sheet数据结构
        const sheetData = {
            name: group.name,
            data: group.data,
            capacity: group.capacity // 保存装机容量用于写入公式
        };

        processedSheets.push(sheetData);
    });

    return processedSheets;
}


function readExcel(file) {
    try {
        // 1. 读取工作簿（启用公式计算）
        const workbook = xlsx.readFile(file.path);

        // 2. 遍历所有工作表
        const sheets = []
        workbook.SheetNames.forEach(sheetName => {
            const worksheet = workbook.Sheets[sheetName];
            const jsonData = xlsx.utils.sheet_to_json(worksheet);
            // console.log(jsonData);

            sheets.push({
                name: sheetName,
                data: jsonData
            });
        });

        // 3. 返回结构化结果
        return sheets;

    } catch (error) {
        console.error(`读取文件 ${file.path} 失败:`, error.message);
        return []; // 返回空避免进程中断
    }
}

function writeExcel(jsonData,outputPath){
    // 创建新的Excel工作簿
    const workbook = xlsx.utils.book_new();

    // 遍历每个sheet数据
    jsonData.forEach(sheetItem => {
        const sheetName = sheetItem.name;
        const sheetData = sheetItem.data;
        const capacity = sheetItem.capacity;

        // 提取用户编号（从sheet名称中解析，如"用户_3700875425319" → "3700875425319"）
        const userCode = sheetName.replace('用户_', '');
        // 匹配电能表资产编号（反向查找meterDataMap）
        let meterCode = '';
        let userName = '';
        for (const [key, value] of Object.entries(meterDataMap)) {
            if (value.topologyNo == userCode) {
                meterCode = key;
                userName = value.name;
                if (value.topologyNo === '台区') meterCode = '台区';
                break;
            }
        }

        // 如果没有数据，跳过该Sheet
        if (!sheetData.length) return;

        // 1. 先创建基础工作表（不含公式）
        const worksheet = xlsx.utils.json_to_sheet(sheetData);

        // 2. 核心：将所有单元格从A1起始偏移到B3起始
        // 定义偏移量：列偏移+1（A→B），行偏移+2（1→3）
        const colOffset = 1; // A(0) → B(1)
        const rowOffset = 2; // 1 → 3
        const newWorksheet = {};

        // 遍历原有单元格，重新计算位置
        Object.keys(worksheet).forEach(cellAddr => {
            // 跳过!ref等非单元格属性（decode_cell返回false则跳过）
            const cell = xlsx.utils.decode_cell(cellAddr);
            if (!cell) return;

            // 解析单元格地址（如A1 → {r:0, c:0}）
            const { r: originalRow, c: originalCol } = cell;
            // 计算新地址：行+2，列+1
            const newRow = originalRow + rowOffset;
            const newCol = originalCol + colOffset;
            // 转换回单元格地址（如{r:2, c:1} → B3）
            const newCellAddr = xlsx.utils.encode_cell({ r: newRow, c: newCol });

            // 复制单元格内容到新地址
            newWorksheet[newCellAddr] = worksheet[cellAddr];
        });

        // 3. 自定义单元格内容（核心新增逻辑）
        // B1：电能表资产编号+userCode（格式：编号-用户编号）
        newWorksheet['B1'] = {
            t: 's', // 字符串类型
            v: `${userName}(${meterCode})` // 无编号时仅显示用户编号
        };

        if(userCode !== '台区'){
            // E1：userCode（纯用户编号）
            newWorksheet['E1'] = {
                t: 's',
                v: `序号：${userCode}`
            };
        }

        // G1：装机容量（capacity），空值显示""
        newWorksheet['G1'] = {
            t: 's', // 数字类型（无值时显示空字符串）
            v: '装机容量'
        };
        // H1：装机容量（capacity），空值显示""
        newWorksheet['H1'] = {
            t: 'n', // 数字类型（无值时显示空字符串）
            v: capacity || 0
        };

        // 4. 处理装机容量和发电效率公式（适配新的单元格位置）
        const headers = Object.keys(sheetData[0]);
        const efficiencyColIndex = headers.indexOf("发电效率");
        const wgColIndex = headers.indexOf("理论可调最大无功（kVA）");
        const szglColIndex = headers.indexOf("视在功率（kW）");
        const cnWgColIndex = headers.indexOf("储能无功（kVA）");
        const cnYgColIndex = headers.indexOf("储能有功（kW）");
        const loadColIndex = headers.indexOf("实时负荷(kW)");

        if (efficiencyColIndex !== -1 && loadColIndex !== -1 && capacity) {
            // 计算新的列号（原列号+偏移量）
            const efficiencyCol = String.fromCharCode(65 + efficiencyColIndex + colOffset); // 发电效率列（原C→D，因为列偏移+1）
            const wgCol = String.fromCharCode(65 + wgColIndex + colOffset); // 发电效率列（原C→D，因为列偏移+1）
            const szglCol = String.fromCharCode(65 + szglColIndex + colOffset); // 视在功率
            const cnWgCol = String.fromCharCode(65 + cnWgColIndex + colOffset); // 储能无功
            const cnYgCol = String.fromCharCode(65 + cnYgColIndex + colOffset); // 储能有功
            const loadCol = String.fromCharCode(65 + loadColIndex + colOffset); // 实时负荷列（原B→C）
            const capacityCell = `H1`; // 装机容量放在H1单元格

            // 在H1单元格写入装机容量
            // worksheet[capacityCell] = { t: 'n', v: Number(capacity) };

            // 为每一行的发电效率列设置公式：=实时负荷单元格/装机容量单元格
            sheetData.forEach((_, rowIndex) => {
                // 数据行起始：原2→5（3+2，因为B3是表头行，数据从B4开始）
                const rowNum = rowIndex + 4; // 从第二行开始是数据行
                const formulaCell = `${efficiencyCol}${rowNum}`;
                const loadCell = `${loadCol}${rowNum}`;

                // 设置公式
                newWorksheet[formulaCell] = {
                    t: 'n',
                    f: `${loadCell}/${capacityCell}`,
                    v: sheetData[rowIndex]['实时负荷(kW)'] / capacity // 计算初始值
                };
            });

            // 为每一行的[理论可调最大无功]列设置公式：=SQRT(H1*H1-C4*C4)
            sheetData.forEach((_, rowIndex) => {
                // 数据行起始：原2→5（3+2，因为B3是表头行，数据从B4开始）
                const rowNum = rowIndex + 4; // 从第二行开始是数据行
                const formulaCell = `${wgCol}${rowNum}`;
                const loadCell = `${loadCol}${rowNum}`;

                // 设置公式
                newWorksheet[formulaCell] = {
                    t: 'n',
                    f: `SQRT(${capacityCell}*${capacityCell}-${loadCell}*${loadCell})`,
                    v:  Math.sqrt(capacity * capacity - sheetData[rowIndex]['实时负荷(kW)'] * sheetData[rowIndex]['实时负荷(kW)']) // 计算初始值
                };
            });

            // 为每一行的[理论可调最大无功]列设置公式：=SQRT(H1*H1-C4*C4)
            sheetData.forEach((_, rowIndex) => {
                // 数据行起始：原2→5（3+2，因为B3是表头行，数据从B4开始）
                const rowNum = rowIndex + 4; // 从第二行开始是数据行
                const formulaCell = `${szglCol}${rowNum}`;
                const cnWgCell = `${cnWgCol}${rowNum}`;
                const cnYgCell = `${cnYgCol}${rowNum}`;

                // 设置公式
                newWorksheet[formulaCell] = {
                    t: 'n',
                    f: `SQRT(${cnWgCell}*${cnWgCell}+${cnYgCell}*${cnYgCell})`,
                    v:  Math.sqrt(sheetData[rowIndex]['储能无功（kVA）'] * sheetData[rowIndex]['储能无功（kVA）'] + sheetData[rowIndex]['储能有功（kW）'] * sheetData[rowIndex]['储能有功（kW）']) // 计算初始值
                };
            });
        }

        // 5. 关键修复：手动扩展!ref范围，确保包含所有单元格
        // 步骤1：收集所有已写入的单元格地址，找到最大行/列
        let maxRow = 0;
        let maxCol = 0;
        Object.keys(newWorksheet).forEach(cellAddr => {
            const cell = xlsx.utils.decode_cell(cellAddr);
            if (!cell) return;
            if (cell.r > maxRow) maxRow = cell.r;
            if (cell.c > maxCol) maxCol = cell.c;
        });
        // 步骤2：强制设置!ref为从A1（r=0,c=0）到最大行/列的范围
        newWorksheet['!ref'] = xlsx.utils.encode_range({
            s: { r: 0, c: 0 }, // 起始：A1
            e: { r: maxRow, c: maxCol } // 结束：最大行/列
        });

        // 6. 将新工作表添加到工作簿
        xlsx.utils.book_append_sheet(workbook, newWorksheet, sheetName);
    });

    // 5. 写入文件（添加异常捕获）
    try {
        xlsx.writeFile(workbook, outputPath);
        console.log(`文件已成功写入: ${outputPath}`);
    } catch (error) {
        console.error(`写入文件失败:`, error.message);
    }
}

// module.exports = writingRules; // 导出主处理函数

module.exports = {
    name: 'xlsx2xlsx',
    version: '1.1.1',
    process: writingRules,
    description:'主要用于将xlsx文件转化为xlsx-联合1.1.2实现伪自动化处理',
    notes:{
        node:'18.20.4',
    },
    input: {
        normExt: 'xlsx文件'
    },
    output: {
        normExt: 'xlsx文件'
    },
    rely:{//默认 latest
        'xlsx': '0.18.0'
    }
};