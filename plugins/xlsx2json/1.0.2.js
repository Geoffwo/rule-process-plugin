const xlsx = require('xlsx');

function writingRules(inputArray, outputNodeTemplate) {
  // 过滤出xlsx文件
  const xlsxFiles = inputArray.filter(item => item.normExt === 'xlsx');

  // 处理每个文件并生成输出节点
  return xlsxFiles.map(file => {
    const name = file.name;//2024年1月
    const matchResult = name.match(/(\d{4})年(\d{1,2})月/);
    let formattedName = name; // 默认保留原格式

    if (matchResult) {
      const [, year, month] = matchResult;
      formattedName = `${year}年${month.padStart(2, '0')}月`;
    }
    //修改2024年01月
    return {
      ...outputNodeTemplate,
      fileName:`${formattedName}`,
      normExt:'json',
      content: JSON.stringify(readExcel(file),null,2) // 读取Excel内容
    }
  });

  // return []
}

// 工具函数：去除千分位逗号并转为数字（容错）
const toNumber = (value) => {
  const number = Number(String(value).replace(/,/g, ''));
  if(isNaN(number)){
    return value
  }
  return  number;
};

function readExcel(file) {
  try {
    // 1. 读取工作簿（启用公式计算）
    const workbook = xlsx.readFile(file.path);

    // 2. 遍历所有工作表
    const sheets = []
    workbook.SheetNames.forEach(sheetName => {
      // 核心新增：如果工作表名称包含“删”字，跳过当前工作表，不统计
      if (sheetName.includes('删')) {
        return; // forEach中return等价于continue，跳过当前循环
      }

      const worksheet = workbook.Sheets[sheetName];
      const jsonData = xlsx.utils.sheet_to_json(worksheet);
      const name = file.name;//2024年1月
      const matchResult = name.match(/(\d{4})年(\d{1,2})月/);
      let formattedName = name; // 默认保留原格式

      if (matchResult) {
        const [, year, month] = matchResult;
        formattedName = `${year}年${month.padStart(2, '0')}月`;
      }
      //修改2024年01月
      const objKey = `${formattedName}全行业销售电量情况统计表`;
      const findObj = jsonData.find(item=>item[objKey] === 71);
      const keys = Object.keys(findObj);
      const correctKey= ['序号','行业','用电客户数-本月','用电客户数-同期','运行容量-本月','运行容量-同期','售电量-本月','售电量-同期','售电量-本月同比增速（%）','售电量-本年累计','售电量-同期累计','售电量-累计同比增速（%）']
      const correctObj = {}
      keys.forEach((key,index)=>{
        const keyElement = correctKey[index];
        if(!keyElement){
          return
        }
        correctObj[keyElement] = toNumber(findObj[key])
      })

      //用电增长指数=（本月平均日电量/上年同期平均日电量）*100。
      // correctObj['用电增长指数']=correctObj['售电量-同期'] ? correctObj['售电量-本月']/correctObj['售电量-同期'] * 100 : 0

      //规模增长指数=（本月平均运行容量/上年同期平均运行容量）*100。
      // correctObj['规模增长指数']=correctObj['运行容量-同期'] ? correctObj['运行容量-本月']/correctObj['运行容量-同期'] * 100 : 0

      //电力景气指数=用电增长指数×0.8+规模增长指数×0.2
      // correctObj['电力景气指数']=correctObj['用电增长指数'] * 0.8 + correctObj['规模增长指数'] * 0.2

      sheets.push({
        name: sheetName,
        data: correctObj
      });
    });

    // 3. 数据合并
    // 3.1 找到需要合并的目标sheet（红岛→城阳、客户→黄岛）
    const hongdaoSheet = sheets.find(item => item.name.includes('红岛'));
    const huangdaoCustomerSheet = sheets.find(item => item.name.includes('客户'));
    const chengyangSheet = sheets.find(item => item.name.includes('城阳'));
    const huangdaoSheet = sheets.find(item => item.name.includes('黄岛'));

    // 3.2 红岛数据合并到城阳（数值累加）
    if (hongdaoSheet && chengyangSheet) {
      const mergeFields = [
        '用电客户数-本月', '用电客户数-同期', '运行容量-本月',
        '运行容量-同期', '售电量-本月', '售电量-同期',
        '售电量-本年累计', '售电量-同期累计'
      ];
      mergeFields.forEach(field => {
        const cyValue = toNumber(chengyangSheet.data[field]);
        const hdValue = toNumber(hongdaoSheet.data[field]);
        chengyangSheet.data[field] = cyValue + hdValue; // 累加后覆盖
      });
    }

    // 3.3 开发区客户数据合并到黄岛（数值累加）
    if (huangdaoCustomerSheet && huangdaoSheet) {
      const mergeFields = [
        '用电客户数-本月', '用电客户数-同期', '运行容量-本月',
        '运行容量-同期', '售电量-本月', '售电量-同期',
        '售电量-本年累计', '售电量-同期累计'
      ];
      mergeFields.forEach(field => {
        const hdValue = toNumber(huangdaoSheet.data[field]);
        const khValue = toNumber(huangdaoCustomerSheet.data[field]);
        huangdaoSheet.data[field] = hdValue + khValue; // 累加后覆盖
      });
    }

    // 3.4 遍历处理所有sheet（过滤红岛/客户sheet + 计算指数）
    const finalSheets = sheets.filter(item => {
      // 过滤掉红岛、客户sheet（已合并到对应区域，无需保留）
      return !item.name.includes('红岛') && !item.name.includes('客户');
    }).map(sheet => {
      const data={ ...sheet.data }; // 深拷贝避免原数据污染

      //"售电量-本月": "3,916,591",转化为数字

      //用电增长指数=（本月平均日电量/上年同期平均日电量）*100。
      data['用电增长指数']=data['售电量-同期'] ? data['售电量-本月']/data['售电量-同期'] * 100 : 0

      //规模增长指数=（本月平均运行容量/上年同期平均运行容量）*100。
      data['规模增长指数']=data['运行容量-同期'] ? data['运行容量-本月']/data['运行容量-同期'] * 100 : 0

      //电力景气指数=用电增长指数×0.8+规模增长指数×0.2
      data['电力景气指数']=data['用电增长指数'] * 0.8 + data['规模增长指数'] * 0.2

      // 保留两位小数（可选，提升可读性）
      data['用电增长指数'] = Number(data['用电增长指数'].toFixed(2));
      data['规模增长指数'] = Number(data['规模增长指数'].toFixed(2));
      data['电力景气指数'] = Number(data['电力景气指数'].toFixed(2));

      return {
        name: sheet.name,
        data
      };
    });

    // ========== 新增：按指定区域顺序排序 ==========
    // 1. 定义区域排序优先级（核心顺序）
    const areaOrder = [
      '市南',
      '市北',
      '李沧',
      '崂山',
      '黄岛',
      '城阳',
      '即墨',
      '胶州',
      '平度',
      '莱西'
    ];
    // 2. 构建区域→排序权重的映射（权重越小越靠前）
    const areaPriorityMap = areaOrder.reduce((map, area, index) => {
      map[area] = index;
      return map;
    }, {});
    // 3. 辅助函数：根据sheet名称匹配区域权重（未匹配则排最后）
    const getSheetSortPriority = (sheetName) => {
      for (const area of areaOrder) {
        // 匹配sheet名称中包含的区域关键词（支持缩写/全称）
        if (sheetName.includes(area)) {
          return areaPriorityMap[area];
        }
      }
      // 未匹配到指定区域的sheet，权重设为无穷大（排最后）
      return Infinity;
    };
    // 4. 执行排序
    finalSheets.sort((sheetA, sheetB) => {
      const priorityA = getSheetSortPriority(sheetA.name);
      const priorityB = getSheetSortPriority(sheetB.name);
      return priorityA - priorityB;
    });

    finalSheets.forEach(sheet=>{
      // const sheetName = sheet.name
      // for (const area of areaOrder) {
      //   // 匹配sheet名称中包含的区域关键词（支持缩写/全称）
      //   if (sheetName.includes(area)) {
      //     sheet.name = area;
      //   }
      // }
      sheet.name = sheet.name.substring(0, 2);//只保留两位
    })

    // 3. 返回结构化结果
    return finalSheets;

  } catch (error) {
    console.error(`读取文件 ${file.path} 失败:`, error.message);
    return []; // 返回空避免进程中断
  }
}

// module.exports = writingRules; // 导出主处理函数

module.exports = {
  name: 'xlsx2json',
  version: '1.0.2',
  process: writingRules,
  description:'主要用于将xlsx文件转化为json-特定青岛车企-增加大量特定数据规则处理',
  notes:{
    node:'18.20.4',
  },
  input: {
    normExt: 'xlsx文件'
  },
  output: {
    normExt: 'json文件',
    format: "[{name:sheet页名称,data:这一页的数据}]"
  },
  rely:{//默认 latest
    'xlsx': '0.18.0'
  }
};