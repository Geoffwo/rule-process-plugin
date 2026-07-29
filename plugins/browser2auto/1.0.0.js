const puppeteer = require('puppeteer');
const xlsx = require('xlsx');
const path = require('path');

// ====================== 公共工具函数 ======================
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 模板渲染 {{key}}
 */
function renderTemplate(template, data) {
    if (typeof template !== 'string') return template;
    return template.replace(/\{\{([^{}]+)\}\}/g, (_, key) => {
        const keys = key.trim().split('.');
        let val = data;
        for (const k of keys) {
            val = val?.[k];
            if (val === undefined) break;
        }
        return val ?? '';
    });
}

/**
 * 读取Excel文件，返回结构化行数据（每行=1个task）
 */
function readExcel(file) {
    const workbook = xlsx.readFile(file.path);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    return xlsx.utils.sheet_to_json(worksheet);
}

/**
 * 生成示例Excel模板（无xlsx文件时自动生成）
 */
function createXlsxTemplate(outputPath) {
    const sampleData = [
        { reportId: 'R001', reportName: '一月份报表' },
        { reportId: 'R002', reportName: '二月份报表' },
        { reportId: 'R003', reportName: '三月份报表' }
    ];
    const workbook = xlsx.utils.book_new();
    const worksheet = xlsx.utils.json_to_sheet(sampleData);
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
    xlsx.writeFile(workbook, outputPath);
}

/**
 * 配置模板：浏览器/截图参数统一放在 option
 */
function createConfigTemplate() {
    return {
        "option": {
            "width": 1300,
            "height": 850,
            "scale": 1,
            "userAgent": "",
            "timeout": 30000,
            "fullPage": false,
            "selector": "",
            "transparent": false
        },
        "delay": 1200,
        "steps": [
            {
                "stepName": "登录后台",
                "once": true,
                "url": "https://demo.fastadmin.net/admin.php/index/login",
                "actions": [
                    {"waitSelector":"input[name='username']"}, // 1. 等账号输入框渲染出来
                    {"type":"input[name='username']","value":"admin"}, // 2. 输入用户名
                    {"type":"input[name='password']","value":"123456"}, // 3. 输入密码
                    {"click":"button[type='submit']"}, //4. 点击登录按钮
                    {"waitNavigation":"networkidle2"} //5. 等待页面跳转加载完成
                ]
            },
            {
                "stepName": "填入IP黑名单并截图",
                "type": "screenshot",
                "url": "https://demo.fastadmin.net/admin.php/general/config?ref=addtabs",
                "outputName": "系统配置_填写黑名单_{{reportId}}"
            }
        ]
    };
}

/**
 * 执行页面动作队列：waitSelector / type / click / waitNavigation / waitMs
 */
async function runPageActions(page, actions, ctx) {
    // 操作目标，初始为主页面page
    let target = page;

    for (const action of actions) {
        // ========== 新增iframe切换指令 ==========
        if (action.switchFrame) {
            let iframeEl;
            if (action.switchFrame === "auto") {
                iframeEl = await page.waitForSelector("iframe", { timeout: 12000 });
            } else {
                const sel = renderTemplate(action.switchFrame, ctx);
                iframeEl = await page.waitForSelector(sel, { timeout: 12000 });
            }
            const frame = await iframeEl.contentFrame();
            if (!frame) throw new Error("iframe 无法获取frame上下文");
            target = frame;
            continue;
        }
        if (action.resetFrame) {
            target = page;
            continue;
        }
        // ========================================

        if (action.waitSelector) {
            const sel = renderTemplate(action.waitSelector, ctx);
            await target.waitForSelector(sel, { timeout: 15000 });
        }
        if (action.type) {
            const sel = renderTemplate(action.type, ctx);
            const val = renderTemplate(action.value, ctx);
            await target.type(sel, val);
        }
        if (action.click) {
            const sel = renderTemplate(action.click, ctx);
            await target.click(sel);
        }
        if (action.evaluateClick) {
            const sel = renderTemplate(action.evaluateClick, ctx);
            await target.evaluate((selector) => {
                const el = document.querySelector(selector);
                if(el) el.click();
            }, sel);
        }
        if (action.waitNavigation) {
            await target.waitForNavigation({ waitUntil: action.waitNavigation });
        }
        if (action.waitMs) {
            await sleep(Number(action.waitMs));
        }
    }
}

/**
 * 截图函数：有selector尝试截元素，找不到自动降级整页
 */
async function takeScreenshot(page, opt, ctx) {
    const { transparent, fullPage, selector = '' } = opt;
    const screenshotOpt = {
        type: 'png',
        omitBackground: transparent
    };
    let buffer;
    const ELEMENT_WAIT_TIMEOUT = 10000;
    const realSelector = renderTemplate(selector, ctx);

    let targetElement = null;
    if (realSelector && realSelector.trim()) {
        try {
            targetElement = await page.waitForSelector(realSelector, { timeout: ELEMENT_WAIT_TIMEOUT });
        } catch (e) {
            console.log(`[automate提示] 选择器【${realSelector}】未找到，降级整页截图`);
        }
    }

    if (targetElement) {
        buffer = await targetElement.screenshot(screenshotOpt);
    } else {
        buffer = await page.screenshot({ ...screenshotOpt, fullPage });
    }
    return buffer;
}

// ====================== 核心入口 writingRules ======================
async function writingRules(inputArray, outputNodeTemplate) {
    const outputDir = outputNodeTemplate.path;
    const inputPath = path.join(outputDir, '../inputDir');
    const xlsxOutputPath = path.join(inputPath, 'data.xlsx');

    // 1. 读取config.json
    const configFile = inputArray.find(item => item.normExt === 'json' && item.name === 'config');
    if (!configFile) {
        const templateCfg = createConfigTemplate();
        return [
            { ...outputNodeTemplate, content: '错误: 未找到 config.json，已生成模板配置' },
            {
                ...outputNodeTemplate,
                path: inputPath,
                fileName: 'config',
                normExt: 'json',
                content: JSON.stringify(templateCfg, null, 2)
            }
        ];
    }

    const cfg = JSON.parse(configFile.content);
    const { option, delay = 800, steps = [] } = cfg;
    const {
        width,
        height,
        scale,
        userAgent,
        timeout,
        fullPage,
        selector,
        transparent
    } = option;

    // 2. 读取Excel文件，每行=1个task
    const xlsxFile = inputArray.find(item => item.normExt === 'xlsx' && item.name === 'data');
    if (!xlsxFile) {
        createXlsxTemplate(xlsxOutputPath);
        return [{ ...outputNodeTemplate, content: '错误: 未找到 data.xlsx，已生成示例Excel模板' }];
    }

    let tasks;
    try {
        tasks = readExcel(xlsxFile);
        console.log(`已加载 ${tasks.length} 条任务（来自 ${xlsxFile.path}）`);
    } catch (err) {
        return [{ ...outputNodeTemplate, content: `读取Excel失败: ${err.message}` }];
    }

    if (!Array.isArray(tasks) || tasks.length === 0) {
        return [{ ...outputNodeTemplate, content: '错误：Excel文件中未读取到有效任务数据' }];
    }

    // 3. once步骤执行标记（移除废弃 sharedCtx）
    const executedOnceStep = new Set();
    const outputFiles = [];

    // 4. 启动浏览器
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        // 5. 遍历Excel每行任务，循环执行steps流水线
        for (const task of tasks) {
            console.log(`\n开始执行任务：`, task);
            const ctx = { ...task };
            const page = await browser.newPage();

            try {
                await page.setViewport({
                    width,
                    height,
                    deviceScaleFactor: scale
                });
                if (userAgent) await page.setUserAgent(userAgent);

                // 顺序执行所有步骤
                for (let stepIdx = 0; stepIdx < steps.length; stepIdx++) {
                    const step = steps[stepIdx];

                    // once标记且已执行过，直接跳过
                    if (step.once && executedOnceStep.has(stepIdx)) {
                        console.log(`跳过once步骤: ${step.stepName}`);
                        continue;
                    }

                    const targetUrl = renderTemplate(step.url, ctx);
                    await page.goto(targetUrl, {
                        timeout: timeout,
                        waitUntil: 'networkidle2'
                    });

                    // 执行页面动作
                    if (Array.isArray(step.actions)) {
                        await runPageActions(page, step.actions, ctx);
                    }

                    // 标记该once步骤已经执行
                    if (step.once) executedOnceStep.add(stepIdx);

                    // 截图步骤：产出图片
                    if (step.type === 'screenshot') {
                        const buf = await takeScreenshot(page, { transparent, fullPage, selector }, ctx);
                        const fileName = renderTemplate(step.outputName, ctx);
                        outputFiles.push({
                            ...outputNodeTemplate,
                            fileName,
                            normExt: 'png',
                            content: buf
                        });
                    }
                    await sleep(delay);
                }
            } catch (err) {
                console.error('任务执行失败', err.message);
                outputFiles.push({
                    ...outputNodeTemplate,
                    fileName: `task_err_${Date.now()}`,
                    normExt: 'txt',
                    content: Buffer.from(JSON.stringify({ task, error: err.message }, null, 2))
                });
            } finally {
                await page.close();
            }
        }
    } finally {
        await browser.close();
    }

    // 6. 输出汇总日志json
    const successCount = outputFiles.filter(r => r.normExt === 'png').length;
    const failCount = outputFiles.length - successCount;
    outputFiles.push({
        ...outputNodeTemplate,
        fileName: 'automate_summary',
        normExt: 'json',
        content: JSON.stringify({
            total: tasks.length,
            success: successCount,
            fail: failCount
        }, null, 2)
    });
    return outputFiles;
}

// ====================== 插件导出 ======================
module.exports = {
    name: 'browser2auto',
    version: '1.0.0',
    process: writingRules,
    description: 'Excel驱动浏览器自动化，浏览器参数统一置于option，支持流水线steps、once单次执行优化、批量页面截图',
    notes: {
        node: '>=18.0.0',
        tips: 'inputDir放置data.xlsx + config.json；{{字段名}}直接读取Excel列；once避免重复登录'
    },
    input: {
        normExt: 'xlsx + json',
        description: 'data.xlsx 任务清单 + config.json 自动化流程配置'
    },
    output: {
        normExt: 'png,txt,json'
    },
    rely: {
        "puppeteer": "19.11.1",
        'xlsx': '0.18.0'
    }
};