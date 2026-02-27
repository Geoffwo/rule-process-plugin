const xlsx = require('xlsx');
const path = require("path");

// 原始数据（从你的表格转换而来）
const meterDataList = [
    {
        "电能表资产编号": "3730001000000856578557",
        "用户编号": "3700875426338",
        "装机容量": 10,
        "对应拓扑图中编号": 2
    },
    {
        "电能表资产编号": "3730001000000753458280",
        "用户编号": "3701100201957",
        "装机容量": 22.75,
        "对应拓扑图中编号": 8
    },
    {
        "电能表资产编号": "3730001000000856536755",
        "用户编号": "3700916250269",
        "装机容量": 13,
        "对应拓扑图中编号": 3
    },
    {
        "电能表资产编号": "3730001000000755104512",
        "用户编号": "3701096500896",
        "装机容量": 27.775,
        "对应拓扑图中编号": 5
    },
    {
        "电能表资产编号": "3730001000000753459225",
        "用户编号": "3701100203184",
        "装机容量": 22.75,
        "对应拓扑图中编号": 7
    },
    {
        "电能表资产编号": "3730001000000856627965",
        "用户编号": "3701116005170",
        "装机容量": 20.71,
        "对应拓扑图中编号": 10
    },
    {
        "电能表资产编号": "3730001000000753378076",
        "用户编号": "3701100211987",
        "装机容量": 19.11,
        "对应拓扑图中编号": 9
    },
    {
        "电能表资产编号": "3730001000000806037752",
        "用户编号": "3700875425319",
        "装机容量": 5,
        "对应拓扑图中编号": 1
    },
    {
        "电能表资产编号": "3730001000000636910508",
        "用户编号": "3701036564489",
        "装机容量": 20,
        "对应拓扑图中编号": 4
    },
    {
        "电能表资产编号": "3730001000000753456446",
        "用户编号": "3701097242377",
        "装机容量": 20.02,
        "对应拓扑图中编号": 6
    }
];


function writingRules(inputArray, outputNodeTemplate) {
    const outputDir = outputNodeTemplate.path // 临时目录绝对路径
    const inputPath = path.join(outputDir, '../inputDir');

    // 过滤出xlsx文件
    const xlsxFile = inputArray.find(item => item.normExt === 'xlsx' && item.name === '原始数据');

    const fileName = `${xlsxFile.name}-出.xlsx`
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

/**
 * 从完整时间字符串中提取时分部分（格式：HH:MM）
 * @param {string} timeStr - 完整时间字符串，如 "2026-01-22 09:02:54"
 * @returns {string} 时分字符串（HH:MM），格式错误返回空字符串
 */
function extractHourMinute(timeStr) {
    // 1. 校验输入：空值/非字符串直接返回空
    if (!timeStr || typeof timeStr !== 'string') {
        console.warn('输入时间字符串无效：', timeStr);
        return '';
    }

    try {
        // 2. 处理时间字符串（兼容不同分隔符，统一转为Date可识别格式）
        const normalizedTimeStr = timeStr.replace(/-/g, '/'); // 替换-为/，兼容IE/Edge
        const date = new Date(normalizedTimeStr);

        // 3. 校验Date对象是否有效
        if (isNaN(date.getTime())) {
            console.warn('时间字符串解析失败：', timeStr);
            return '';
        }

        // 4. 提取小时和分钟，补零（确保两位数，如9→09，2→02）
        const hour = date.getHours().toString().padStart(2, '0');
        const minute = date.getMinutes().toString().padStart(2, '0');

        // 5. 返回HH:MM格式
        return `${hour}:${minute}`;
    } catch (error) {
        console.error('提取时分失败：', error.message);
        return '';
    }
}


function processData(jsonData) {
    return jsonData.map(item => {
        // 1. 临时存储：先收集所有数据，再按时间节点分组处理
        const tempData = [];
        // 2. 存储每个时间节点对应的储能数据
        const timeNodeStorageMap = {};
        const map = []

        // 第一步：先收集所有原始数据（用户+储能+台区）
        item.data.forEach(dataItem=>{
            const time = formatExcelTime(dataItem['时间']);
            const params = JSON.parse(dataItem['入参']);
            const results = JSON.parse(dataItem['出参']);
            const resultData = results.Msg.data;

            const dataDateOld = params.tg_data.GF_KH_DATA[0].DATA_DATE;
            const dataDate = extractHourMinute(dataDateOld)

            // 处理用户1-10数据（先暂存，不立即push到最终数组）
            params.tg_data.GF_KH_DATA.forEach(param=>{
                const paramObj={}
                const meterObj = meterDataList.find(meter=>meter['对应拓扑图中编号'] == param.GF_ID);
                paramObj['电能表资产编号'] = meterObj['电能表资产编号'];
                paramObj['装机容量'] =  meterObj['装机容量'];

                paramObj['用户编号']=param.GF_ID
                paramObj['时间节点']=dataDate
                paramObj['实时负荷']=param.ACTIVE_POWER_DATA_VALUE
                paramObj['发电效率'] = paramObj['实时负荷']/paramObj['装机容量'];
                paramObj['A相电压(V)']=param.A_VOLTAGE_DATA_VALUE
                paramObj['B相电压(V)']=param.B_VOLTAGE_DATA_VALUE
                paramObj['C相电压(V)']=param.C_VOLTAGE_DATA_VALUE
                // paramObj['类型']='光伏'
                // paramObj['实时负荷']=param.ACTIVE_POWER_DATA_VALUE
                // paramObj['入参-无功负荷']=param.REACTIVE_POWER_DATA_VALUE
                // paramObj['入参-发电效率']=''

                const findResult = resultData.GF_CONTROL_PARAM.find(data=>data.GF_ID === param.GF_ID);
                paramObj['光伏无功（kVA）'] = findResult.REACTIVE_POWER_DATA_VALUE
                paramObj['光伏有功（%）'] = findResult.ACTIVE_POWER_DATA_VALUE
                paramObj['装机容量有功调节-调节系数'] =  paramObj['实时负荷']*(1-paramObj['光伏有功（%）'])/paramObj['装机容量'];

                tempData.push(paramObj)
            })

            // 处理储能数据（提取并存储到时间节点映射表）
            params.tg_data.CN_KH_DATA.forEach(param=>{
                const paramObj={}
                paramObj['电能表资产编号'] = '3730001000000888100405';
                paramObj['装机容量'] = '215';

                paramObj['用户编号']='储能'
                paramObj['时间节点']=dataDate
                paramObj['实时负荷']=param.ACTIVE_POWER_DATA_VALUE
                paramObj['发电效率'] = paramObj['实时负荷']/paramObj['装机容量'];
                paramObj['A相电压(V)']='/'
                paramObj['B相电压(V)']='/'
                paramObj['C相电压(V)']='/'
                // paramObj['类型']='储能'
                // paramObj['实时负荷']=param.ACTIVE_POWER_DATA_VALUE
                // paramObj['入参-无功负荷']=param.REACTIVE_POWER_DATA_VALUE
                // paramObj['入参-发电效率']=''

                const findResult = resultData.CN_CONTROL_PARAM;
                paramObj['SOC'] = param.SOC
                paramObj['储能无功（kVA）'] = findResult.REACTIVE_POWER_DATA_VALUE
                paramObj['储能有功（kW）'] = findResult.ACTIVE_POWER_DATA_VALUE

                // paramObj['电能表资产编号'] = '3730001000000888100405';
                // paramObj['装机容量'] = '215';

                // paramObj['发电效率'] = paramObj['实时负荷']/paramObj['装机容量'];

                // 核心：将储能数据存入时间节点映射表
                timeNodeStorageMap[dataDate] = {
                    SOC: param.SOC,
                    storageReactivePower: findResult.REACTIVE_POWER_DATA_VALUE,
                    storageActivePower: findResult.ACTIVE_POWER_DATA_VALUE
                };

                tempData.push(paramObj)
            })

            // 处理台区数据
            const paramObj={}
            paramObj['用户编号']='台区'
            paramObj['时间节点']=dataDate
            paramObj['实时负荷']=params.tg_data.FH_KH_DATA.ACTIVE_POWER_DATA_VALUE
            paramObj['发电效率']=params.tg_data.TG__GATE_LOAD_RATE
            paramObj['A相电压(V)']=params.tg_data.TG__GATE_A_VOLTAGE
            paramObj['B相电压(V)']='/'
            paramObj['C相电压(V)']='/'
            // paramObj['实时负荷']=params.tg_data.FH_KH_DATA.ACTIVE_POWER_DATA_VALUE
            // paramObj['入参-无功负荷']=''
            // paramObj['发电效率']=params.tg_data.TG__GATE_LOAD_RATE
            // 暂存台区数据
            tempData.push(paramObj);
        });

        // 第二步：按时间节点为所有用户赋值储能字段
        const finalData = tempData.map(item => {
            // 只给用户1-10（非储能、非台区）赋值储能字段
            if (item['用户编号'] !== '储能' && item['用户编号'] !== '台区') {
                const storageData = timeNodeStorageMap[item['时间节点']] || {};
                // 赋值相同时间节点的储能字段值
                item['SOC'] = storageData.SOC || '';
                item['储能无功（kVA）'] = storageData.storageReactivePower || '';
                item['储能有功（kW）'] = storageData.storageActivePower || '';
            }
            return item;
        });

        return {
            name:item.name,
            data:finalData
        }
    })
}

/**
 * Excel时间戳转时分格式（如 9:30、9:45）
 */
function formatExcelTime(excelTime) {
    if (!excelTime) return '';
    const excelEpoch = new Date(1899, 11, 30);
    const jsDate = new Date(excelEpoch.getTime() + excelTime * 24 * 60 * 60 * 1000);
    const hours = jsDate.getHours().toString().padStart(2, '0');
    const minutes = jsDate.getMinutes().toString().padStart(2, '0');
    // 按15分钟取整（匹配示例中的9:30、9:45）
    const roundedMinutes = minutes//Math.round(minutes / 15) * 15;
    const finalMinutes = roundedMinutes === 60 ? '00' : minutes;
    const finalHours = roundedMinutes === 60 ? (parseInt(hours) + 1).toString().padStart(2, '0') : hours;
    return `${finalHours}:${finalMinutes}`;
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
    jsonData.forEach(item => {
        const sheetName = item.name; // sheet名称（市南/市北等）
        let sheetData = item.data;   // sheet数据

        // 统一数据格式：如果是对象，转为包含该对象的数组
        if (!Array.isArray(sheetData)) {
            sheetData = [sheetData];
        }

        // 将JSON数组转换为Excel工作表
        const worksheet = xlsx.utils.json_to_sheet(sheetData);

        // 将工作表添加到工作簿
        xlsx.utils.book_append_sheet(workbook, worksheet, sheetName);
    });

    // 5. 写入XLSX文件（同步写入，加异常捕获）
    xlsx.writeFile(workbook, outputPath);
}

// module.exports = writingRules; // 导出主处理函数

module.exports = {
    name: 'xlsx2xlsx',
    version: '1.1.0',
    process: writingRules,
    description:'主要用于将xlsx文件转化为xlsx-联合1.1.1实现伪自动化处理',
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