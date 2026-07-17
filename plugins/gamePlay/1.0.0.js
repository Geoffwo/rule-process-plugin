const robot = require('robotjs');
const cv = require('@u4/opencv4nodejs');
const screenshot = require('screenshot-desktop');
const path = require('path');
const { execSync } = require('child_process');
const fs = require('fs');

// ====================== 全局配置默认值 ======================
const DEFAULT_CONFIG = {
    globals: {
        initialWait: 8000,        // 启动前等待时间
        stepDelay: 200,           // 步骤间默认延迟
        clickDelay: 300,          // 点击操作前延迟
        typeCharDelay: 180,       // 打字字符间隔
        matchThreshold: 0.65,     // 图像匹配阈值
        debugMode: false,         // 调试模式（保存识别截图）
    },
};

// ====================== 通用工具函数层 ======================
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 鼠标移动+点击（支持左键/右键/双击）
 */
async function clickPos(pos, delay = 300, option = {}) {
    const { button = 'left', double = false } = option;
    robot.moveMouse(pos.x, pos.y);
    await sleep(delay);
    robot.mouseClick(button, double);
}

/**
 * 模拟人工打字
 */
async function typeText(text, delay = 180) {
    const safeText = String(text || '');
    for (const char of safeText) {
        robot.typeString(char);
        await sleep(delay);
    }
}

/**
 * 获取并缓存系统缩放比例（解决高DPI坐标偏差）
 */
function getScreenScaleFactor() {
    const regVal = execSync(
        `reg query "HKCU\\Control Panel\\Desktop\\WindowMetrics" /v AppliedDPI`,
        { encoding: 'utf8', windowsHide: true }
    );
    // 注册表返回的DPI是十六进制，如 0x60 (96) 或 0x90 (144)
    const hexMatch = regVal.match(/0x([0-9a-fA-F]+)/);
    if (!hexMatch) return 1;
    const dpi = parseInt(hexMatch[1], 16);
    const toFixed = (dpi / 96).toFixed(2);
    return Number(toFixed);
}

/**
 * 生成等步长数组（包含起始值和结束值）
 */
function generateRange(start, end, step=0.05, decimalPlaces = 2) {
    // 1. 严格参数校验
    if (step === 0) {
        throw new Error('步长不能为0');
    }

    // 2. 处理方向不匹配的情况（直接返回空数组，友好不报错）
    if ((step > 0 && start > end) || (step < 0 && start < end)) {
        return [];
    }

    // 3. 计算数组长度（核心：用epsilon修正浮点数精度导致的长度计算错误）
    const epsilon = 1e-10;
    const count = Math.floor((end - start + epsilon) / step) + 1;

    // 4. 生成数组（用乘法代替累加，彻底避免精度累积）
    return Array.from({ length: count }, (_, i) => {
        const value = start + step * i;
        // 四舍五入到指定小数位数，消除浮点噪声
        return Number(value.toFixed(decimalPlaces));
    });
}

/**
 * 递归创建目录
 */
function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
        console.log(`已创建目录：${dirPath}`);
    }
}

// ====================== 图像识别核心模块 ======================
/**
 * 保存标注了识别位置的调试截图
 */
async function saveAnnotatedScreenshot(desktopImage, bestMatch, option) {
    try {
        const { step, debugPath } = option;
        const annotated = desktopImage.copy();
        annotated.drawRectangle(
            new cv.Point(bestMatch.x, bestMatch.y),
            new cv.Point(bestMatch.x + bestMatch.cols, bestMatch.y + bestMatch.rows),
            new cv.Vec(0, 255, 0),// 绿色边框
            2// 线宽
        );
        const debugFile = path.join(debugPath, `debug_${step.matchs}_${step.templates}.png`);

        ensureDir(debugPath);//判断并处理目录
        cv.imwrite(debugFile, annotated);//imwrite 遇到不存在的目录 直接失败，不抛错，不提示
        console.log(`已保存调试截图: ${debugPath}`);
    } catch (err) {
        console.error('保存调试截图失败:', err.message);
    }
}

/**
 * 模板匹配核心函数
 */
async function findBrowserIcon(option={}) {
    const {matchsBuffer,templatesBuffer,config,step}=option
    const matchsImage = cv.imdecode(matchsBuffer);
    // 转为灰度图提高匹配稳定性
    const desktopGray = matchsImage.cvtColor(cv.COLOR_BGR2GRAY);

    // 多尺度因子，控制模板缩放范围
    // const scales = [0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4];
    const scales = generateRange(0.5, 1.5);

    // 记录全局最佳匹配
    let bestMatch = null;
    let bestConfidence = 0;

    console.log(`正在匹配: ${step.templates}`);

    try {
        // 读取模板并转为灰度图
        const templatesImage = cv.imdecode(templatesBuffer)
        const templateGray = templatesImage.cvtColor(cv.COLOR_BGR2GRAY);

        // 遍历所有尺度
        for (const scale of scales) {
            // 缩放模板（比缩放原图高效得多） resize精度需要是整数
            // const scaledTemplate = templateGray.resize(Math.round(templateGray.rows * scale),Math.round(templateGray.cols * scale));

            // 缩放模板 (直接使用 fx, fy 缩放)
            const scaledTemplate = templateGray.resize(0, 0, scale, scale);

            // 确保缩放后的模板不会比桌面图像大
            if (scaledTemplate.rows > desktopGray.rows || scaledTemplate.cols > desktopGray.cols) {
                console.log(`${step.templates}模板尺寸过大，跳过`);
                continue;
            }

            // 执行模板匹配
            // matchTemplate 对尺度（大小）非常敏感。
            // 模板图片如果比桌面图标小（或大），哪怕只是几个像素，匹配度都会急剧下降。
            const matched = desktopGray.matchTemplate(scaledTemplate, cv.TM_CCOEFF_NORMED);//cv.TM_CCOEFF_NORMED 综合效果最好，对光照和对比度变化都有很好的鲁棒性
            const { maxLoc, maxVal } = matched.minMaxLoc();

            // 正确写法：一个console.log = 一个换行符
            console.log(`${step.templates} 尺度${scaledTemplate.rows}/${scaledTemplate.cols}: 匹配度${maxVal.toFixed(2)}\x1B[1A\x1B[K`);

            // 匹配度判断
            const matchThreshold = step.matchThreshold || config.globals.matchThreshold;
            if (maxVal > bestConfidence && maxVal >= matchThreshold) {
                // 更新全局最佳匹配
                bestConfidence = maxVal;

                bestMatch = {
                    name: step.templates,
                    x: maxLoc.x,
                    y: maxLoc.y,
                    confidence: maxVal,
                    cols: scaledTemplate.cols,
                    rows: scaledTemplate.rows,
                    scale: scale // 记录当前匹配使用的尺度
                };
            }
        }

        console.log(' '.repeat(100));
    } catch (err) {
        console.error(`识别${step.templates}时出错:`, err);
        return null;
    }

    if (bestMatch) {
        console.log(`找到最佳匹配: ${bestMatch.name}，匹配度: ${bestMatch.confidence.toFixed(2)}，尺度: ${bestMatch.scale.toFixed(1)}`);

        // 获取系统缩放比例（修正最终点击坐标）
        const screenScale = await getScreenScaleFactor();
        console.log(`系统缩放比: ${screenScale}`);

        // 计算图标中心位置（截图坐标）
        // 需要除以系统缩放，从而获取正确的底层坐标
        // 图标宽高 也需要按照缩放比处理，从而确认真实坐标定位
        const centerX = (bestMatch.x + bestMatch.cols / 2) / screenScale;
        const centerY = (bestMatch.y + bestMatch.rows / 2) / screenScale;

        console.log(`修正后中心坐标: (${centerX.toFixed(1)}, ${centerY.toFixed(1)})`);

        if (config.globals.debugMode) {
            await saveAnnotatedScreenshot(matchsImage, bestMatch,option);
        }

        return {
            ...bestMatch,
            x: Math.round(centerX),
            y: Math.round(centerY),
        };
    }

    return null;
}

// ====================== 核心执行引擎 ======================
/**
 * 执行单个步骤（支持所有操作类型）
 */
async function executeStep(step, config, context) {
    const { globals, positions } = config;
    const stepDelay = step.stepDelay || globals.stepDelay;

    switch (step.type) {
        // 固定坐标点击
        case 'click':
            if (!positions[step.displace]) {
                console.log(`步骤错误：未找到坐标点 "${step.displace}"`);
                break;
            }
            const delayClick = step.delay || globals.clickDelay
            const option = {
                button:step.button || 'left',
                double:step.double || false
            }
            await clickPos(positions[step.displace],delayClick,option);
            break;

        // 图像识别点击（新增）
        case 'match':
            console.log(`正在识别...`);

            let  matchsBuffer=null;
            //截图将决定用户实际点击位置
            if(step.matchs==='auto'){//使用实时自动截图
                matchsBuffer = await screenshot({ format: 'png' });
            }else{//使用用户提供截图
                const matchsItem = context.matchsItems.find(item => item.base === step.matchs);
                matchsBuffer = matchsItem && matchsItem.content;
            }

            if (!matchsBuffer) {
                console.log(`未找到 需要匹配的页面,请在 matchs 目录下存放${step.matchs}截图 或 更改为auto实时截图`);
                break;
            }

            // 获取模板图片
            const templatesItem = context.templatesItems.find(item => item.base === step.templates);
            const templatesBuffer = templatesItem && templatesItem.content;
            if (!templatesBuffer) {
                console.log(`未找到 模板图片,请在 templates 目录下存放${step.templates}截图，图片名需要与 mapping.json 匹配`);
                break;
            }

            // 执行匹配
            const matchResult = await findBrowserIcon({
                matchsBuffer,
                templatesBuffer,
                config:config,
                debugPath:context.debugPath,
                step:step
            });

            if (!matchResult) {
                console.log(`${step.matchs}匹配页面 未找到模板 "${step.templates}"的区域，跳过坐标记录`);
                break;
            }

            const pos={
                x:matchResult.x,
                y:matchResult.y
            }

            // 存储为按钮坐标
            config.positions[step.value] = pos;
            console.log(`已将识别位置存储为按钮: ${step.value} = (${pos.x}, ${pos.y})`);

            break;

        // 文本输入
        case 'input':
            const text = step.value;
            const delayInput = step.delay || globals.typeCharDelay
            await typeText(text, delayInput);
            break;

        // 单个按键/组合键
        case 'keyTap':
            robot.keyTap(step.value, step.action);
            break;

        // 按键按下/释放
        case 'keyToggle':
            robot.keyToggle(step.value, step.action);
            break;

        // 按住按键一段时间
        case 'keyHold':
            robot.keyToggle(step.value, 'down');
            await sleep(step.delay);
            robot.keyToggle(step.value, 'up');
            break;

        // 等待
        case 'wait':
            await sleep(step.delay);
            break;

        default:
            console.log(`步骤错误：不支持的操作类型 "${step.type}"`);
    }

    await sleep(stepDelay);
}

// ====================== 模板生成函数 ======================
function createConfigTemplate() {
    return {
        "loop": 10,  // 新增：整体循环次数，默认为1
        "globals": {
            "initialWait": 10000,
            "stepDelay": 200,
            "clickDelay": 300,
            "typeCharDelay": 180,
            "matchThreshold": 0.65,
            "debugMode": true
        },
        "positions": {
            startBtn: { x: 806, y: 354 },
            backBtn: { x: 970, y: 757 },
            listBtn1: { x: 670, y: 224 },
            listBtn2: { x: 656, y: 273 },
            listBtn3: { x: 665, y: 324 },
            listBtn4: { x: 658, y: 374 },
            siteBtn1: { x: 826, y: 230 },
            siteBtn2: { x: 828, y: 319 },
            siteBtn3: { x: 832, y: 385 },
        },
        "workflow": [
            // 图像识别,坐标记录
            //{ "type": "match", "value": "matchBtn", "templates": "chrome4.jpg", "matchs": "auto" },

            //点击开始按钮
            { type: 'click', displace: 'startBtn', delay: 1000 },
            { type: 'click', displace: 'listBtn3', delay: 1000 },
            { type: 'click', displace: 'siteBtn3', delay: 1000 },
            { type: 'wait', delay: 10000 },//等待跳转

            //到达第1场景点
            { type: 'keyHold', value: 'd',delay: 2000 },//移动
            { type: 'keyHold', value: 's',delay: 2500 },//移动
            { type: 'keyHold', value: 'd',delay: 2000 },//移动
            { type: 'wait', delay: 10000 },//等待战斗结束

            //到达第2场景点
            { type: 'keyHold', value: 'w',delay: 2000 },//移动
            { type: 'keyHold', value: 'd',delay: 4000 },//移动
            { type: 'keyHold', value: 'w',delay: 3000 },//移动
            { type: 'wait', delay: 15000 },//等待战斗结束

            //到达第3场景点
            { type: 'keyHold', value: 'w',delay: 2000 },//移动
            { type: 'keyHold', value: 'd',delay: 2000 },//移动
            { type: 'wait', delay: 10000 },//等待战斗结束

            { type: 'click', displace: 'backBtn', delay: 200 },//回主城
            { type: 'wait', delay: 10000 },//等待战斗结束
        ]
    };
}

// ====================== 插件主入口 ======================
async function writingRules(inputArray, outputNodeTemplate) {
    const outputDir = outputNodeTemplate.path // 临时目录绝对路径
    const inputPath = path.join(outputDir, '../inputDir');
    const outputPath = path.join(inputPath, 'data.xlsx') // 临时目录绝对路径

    console.log('游戏按键精灵启动');

    // 1. 加载配置文件
    const configFile = inputArray.find(item => item.normExt === 'json' && item.name === 'config');

    if (!configFile) {
        const jsonTemplate = createConfigTemplate();
        return [
            { ...outputNodeTemplate, content: '错误: 未找到配置文件 config.json 文件,示例文件已创建' },
            {...outputNodeTemplate, path: inputPath, fileName: 'config',normExt:'json', content: JSON.stringify(jsonTemplate, null, 2)}
        ];
    }

    const userConfig = JSON.parse(configFile.content);
    const config = {
        ...DEFAULT_CONFIG,
        ...userConfig,
        globals: { ...DEFAULT_CONFIG.globals, ...userConfig.globals },
    };

    // 读取循环次数（顶层 loop 字段）
    const loopTotal = config.loop || 1;
    let loopCount = loopTotal;
    console.log(`总循环次数: ${loopTotal}`);

    // 2. 初始等待（让用户切换到目标页面）
    console.log(`等待 ${config.globals.initialWait / 1000} 秒，请切换到目标页面...`);
    await sleep(config.globals.initialWait);

    const matchsItems = inputArray.filter(item => item.dir.endsWith('matchs'));
    const templatesItems = inputArray.filter(item => item.dir.endsWith('templates'));
    const debugPath = path.join(outputDir, '/debug');
    const context = {
        matchsItems:matchsItems,
        templatesItems:templatesItems,
        debugPath:debugPath
    }

    // 3. 循环执行工作流
    while (loopCount--) {
        console.log(`\n========== 第 ${loopTotal-loopCount}/${loopTotal} 次循环 ==========`);

        const workflow = config.workflow || [];
        console.log(`开始执行动作序列，共 ${workflow.length} 步`);
        for (let i = 0; i < workflow.length; i++) {
            console.log(`[${i + 1}/${workflow.length}]`, workflow[i]);
            await executeStep(workflow[i], config, context);
        }

        console.log(`第 ${loopTotal-loopCount} 次循环执行完成。`);
    }

    // 直接跑 workflow，不再循环 Excel 数据
    const workflow = config.workflow || [];
    console.log(`开始执行动作序列，共 ${workflow.length} 步`);
    for (let i = 0; i < workflow.length; i++) {
        console.log(`[${i + 1}/${workflow.length}]`, workflow[i]);
        await executeStep(workflow[i], config, context);
    }

    console.log('\n 所有动作执行完成！');
}

// ====================== 插件导出 ======================
module.exports = {
    name: 'gamePlay',
    version: '1.0.0',
    process: writingRules,
    description: '游戏按键精灵：纯JSON配置+键鼠模拟+图像识别(百炼英雄-刷经验)',
    notes: {
        node: '18.20.4',
        tips: [
            '1. 所有动作在 config.json 的 workflow 里配置',
            '2. 支持：click/match/input/keyTap/keyToggle/wait',
            '3. 坐标写在 positions，match 自动找图并写入 positions',
            '4. 不再依赖 Excel'
        ]
    },
    input: {
        normExt: ['json', 'png'],
        format: '上传：config.json + templates目录(找图模板)'
    },
    output: {
        normExt: ['txt', 'json', 'png']
    },
    rely: {
        'robotjs': '0.6.0',
        '@u4/opencv4nodejs': '7.1.2',
        'screenshot-desktop': '1.15.4',
    }
};