const puppeteer = require('puppeteer');
const xlsx = require('xlsx');
const path = require('path');

// =========新增全局持久存储，跨任务不销毁=========
let globalData = null;

// ====================== 公共工具函数 ======================
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 模板渲染 {{key}} 空值容错，支持多层对象 {{user.name}}
 */
function renderTemplate(template, data) {
    if (typeof template !== 'string') return template;
    return template.replace(/\{\{([^{}]+)\}\}/g, (_, key) => {
        const keys = key.trim().split('.');
        let val = data;
        for (const k of keys) {
            val = val?.[k];
            if (val === undefined || val === null) break;
        }
        return val ?? '';
    });
}

/**
 * 读取Excel文件，空白单元格填充空字符串
 */
function readExcel(file) {
    const workbook = xlsx.readFile(file.path);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    return xlsx.utils.sheet_to_json(worksheet, { defval: "" });
}

/**
 * 生成示例Excel模板
 */
function createXlsxTemplate(outputPath) {
    const sampleData = [
        { reportId: '001', reportName: '截图1' },
        { reportId: '002', reportName: '截图2' },
        { reportId: '003', reportName: '截图3' }
    ];
    const workbook = xlsx.utils.book_new();
    const worksheet = xlsx.utils.json_to_sheet(sampleData);
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
    xlsx.writeFile(workbook, outputPath);
}

/**
 * 更新配置模板
 * 废弃option内 fullPage / selector / transparent，截图参数仅写在action内
 */
function createConfigTemplate() {
    return {
        "option": {
            "width": 1300,
            "height": 850,
            "scale": 1,
            "userAgent": "",
            "timeout": 30000,
            "headless": true,//是否使用无头浏览器
            "sessionMode": "oneTab"   // oneTab | newTab
        },
        "delay": 1200,
        "steps": [
            {
                "stepName": "登录系统",
                "once": true,
                "url": "http://10.23.20.18:8086/login",
                "actions": [
                    { "waitSelector": "input[name='login_name']" },
                    { "input": "input[name='login_name']", "value": "ecp" },
                    { "input": "input[name='password']", "value": "Dareway@2026" },
                    { "click": "#sbmit" },
                    { "waitNavigation": "networkidle2" },
                    { "updateCtx": true}
                ]
            },
            {
                "stepName": "进入首页",
                "url": "http://10.23.20.18:8086/?__uid={{_data.sessionStorage.__uid}}",
                "actions": [
                    { "screenshot": "auto","value": "初始_{{reportName}}","fullPage": false},
                    { "waitSelector": ".treeview"},
                    { "click": ".treeview", "value": "物价管理" },

                    { "waitSelector": "a.nav-link"},
                    { "click": "a.nav-link", "value": "标准物价目录" },

                    { "switchFrame": "iframe[src*='medPriceManage/fwdStandardPriceManage']"},
                    { "waitSelector": ".container-fluid"},
                    { "clearInput": "input[name='item_code']"},
                    { "input": "input[name='item_code']", "value": "{{reportId}}" },
                    { "click": "#btn_query" },
                    { "waitMs": 1000 },
                    { "screenshot": ".container-fluid","fullPage": false}
                ]
            }
        ]
    };
}

/**
 * 执行页面动作队列（generator：截图实时 yield，支持迭代器实时导出）
 * 废弃全局截图参数，所有截图配置仅来自screenshot action
 */
async function* runPageActions(page, actions, ctx, outputTpl) {
    let target = page;
    for (const action of actions) {

        // ========== 截图Action ==========
        if (action.screenshot) {//截图指令分支
            const selector = action.screenshot === 'auto' ? "" : action.screenshot;
            const shotOpt = {
                fullPage: !!action.fullPage,//布尔兜底，配置不写该字段默认 false
                selector: renderTemplate(selector, ctx)//解析文件名模板
            };
            // 增加第三个参数 target（当前上下文：page / iframe frame）
            const buf = await takeScreenshot(page, shotOpt, ctx, target);//调用 takeScreenshot 得到 png 二进制 buffer
            const tmpTime = `auto_${Date.now()}`;
            const fileName = renderTemplate(action.value ? action.value : tmpTime, ctx);//解析文件名模板
            yield {
                ...outputTpl,
                fileName,
                normExt: 'png',
                content: buf
            };
            console.log(`[Action] 截图生成：${fileName}.png`);
            continue;
        }

        if (action.switchFrame) {//iframe 切换
            let iframeEl = null;
            const selTemplate = renderTemplate(action.switchFrame, ctx);//解析文件名模板
            if (selTemplate === "auto") {//特殊值 auto = 匹配页面第一个<iframe>；否则使用自定义选择器；
                iframeEl = await page.waitForSelector("iframe", { timeout: 4000 });
            } else {
                iframeEl = await page.waitForSelector(selTemplate, { timeout: 4000 });
            }
            if (!iframeEl) throw new Error("iframe DOM元素查找超时");

            const frame = await iframeEl.contentFrame();//获取 iframe 内部独立的页面上下文 Frame 对象
            if (!frame) throw new Error("iframe 无法获取frame上下文");
            try {
                await frame.waitForFunction(//在 iframe 内部执行 JS
                    () => document.readyState === "complete",//iframe 内部页面所有资源加载完毕（等同于页面完全加载完成）
                    { timeout: 8000 }//最长等待 8 秒
                );
            } catch (err) {
                console.warn("iframe内部页面ready等待超时，继续执行");
            }

            target = frame;
            console.log(`[Action] 切换至iframe`);
            continue;
        }

        if (action.resetFrame) {//切回主页面
            target = page;//把操作上下文重置回顶层页面，退出 iframe 环境
            console.log(`[Action] 切回主页面`);
            continue;
        }

        if (action.humanWait) {
            console.log(`[人工干预] ${action.humanWait}`);
            console.log("等待人工完成操作，在控制台按下回车继续...");
            // 等待终端回车输入
            await new Promise(resolve => {
                process.stdin.once('data', () => {
                    resolve();
                })
            });
            continue;
        }

        if (action.updateCtx) {
            console.log(`[Action] 捕获Cookie、localStorage、sessionStorage存入ctx`);
            // 1. 获取cookie（page级别，不需要frame）
            const cookies = await page.cookies();

            // 2. 在当前target（page/iframe frame）执行JS读取本地存储
            const storageData = await target.evaluate(() => {
                const ls = {};
                const ss = {};
                // localStorage
                for (let i = 0; i < localStorage.length; i++) {
                    const k = localStorage.key(i);
                    ls[k] = localStorage.getItem(k);
                }
                // sessionStorage
                for (let i = 0; i < sessionStorage.length; i++) {
                    const k = sessionStorage.key(i);
                    ss[k] = sessionStorage.getItem(k);
                }
                return {localStorage: ls, sessionStorage: ss};
            });

            // 【修复】存入全局，跨任务保留
            globalData = {
                cookies,
                localStorage: storageData.localStorage,
                sessionStorage: storageData.sessionStorage
            };
            // 当前任务ctx同步更新
            ctx._data = globalData;
            // console.log(`捕获成功_data.cookies/.localStorage/.sessionStorage已存入`);
            continue;
        }

        if (action.waitSelector) {//等待元素出现
            const sel = renderTemplate(action.waitSelector, ctx);
            await target.waitForSelector(sel, { timeout: 15000 });//等待目标 DOM 渲染完成，15 秒超时
            console.log(`[Action] 等待元素 ${sel}`);
            continue;
        }

        if (action.input) {//模拟输入
            const sel = renderTemplate(action.input, ctx);
            const val = renderTemplate(action.value, ctx);
            await target.type(sel, val);
            console.log(`[Action] type ${sel}`);
            continue;
        }

        if (action.clearInput) {
            const sel = renderTemplate(action.clearInput, ctx);
            await target.click(sel);
            await sleep(150); // 增加延时，让iframe内部输入框获取焦点
            // 重点：键盘API固定使用page，不要使用target
            await page.keyboard.down('Control');
            await page.keyboard.press('a');
            await page.keyboard.up('Control');
            await page.keyboard.press('Backspace');
            console.log(`[Action] clearInput 清空输入框 ${sel}`);
            continue;
        }

        if (action.click) {//点击元素
            const sel = renderTemplate(action.click, ctx);

            if(action.value){
                const matchText = renderTemplate(action.value, ctx);
                await target.evaluate((selector, targetText) => {
                    // 这里是浏览器环境！
                    const list = document.querySelectorAll(selector);
                    const keyword = targetText.trim();
                    for (const el of list) {
                        // outerHTML：当前元素+所有子节点完整HTML源码
                        const htmlStr = el.outerHTML;
                        //包含
                        if (htmlStr.includes(keyword)) {
                            el.click();
                            break;
                        }
                    }
                }, sel, matchText);
                console.log(`[Action] click 文本匹配：${matchText}`);
                continue;
            }

            await target.click(sel);
            console.log(`[Action] click ${sel}`);
            continue;
        }

        if (action.pageJs) {
            const fnCode = renderTemplate(action.pageJs, ctx);
            await target.evaluate((script) => {//target.evaluate：底层原生 API
                return new Function(script)();
            }, fnCode);
            console.log(`[Action] pageJs 执行前端脚本`);
            continue;
        }
        if (action.waitNavigation) {//等待页面跳转
            await target.waitForNavigation({ waitUntil: action.waitNavigation });//networkidle2 网络空闲
            console.log(`[Action] 等待页面加载完成`);
            continue;
        }

        if (action.waitMs) {//固定延时等待
            const ms = Number(action.waitMs);
            await sleep(ms);
            console.log(`[Action] 等待 ${ms}ms`);
        }
    }
}

/**
 * 截图函数
 */
async function takeScreenshot(page, opt, ctx, target) {
    const { fullPage, selector = '' } = opt;
    const screenshotOpt = {
        type: 'png',
        omitBackground: true
    };
    let buffer;
    const realSelector = renderTemplate(selector, ctx);

    let targetElement = null;
    if (realSelector && realSelector.trim()) {
        try {
            targetElement = await target.waitForSelector(realSelector, { timeout: 10000 });
        } catch (e) {
            console.log(`[automate提示] 选择器【${realSelector}】未找到，降级整页截图`);
        }
    }

    await sleep(300);
    if (targetElement) {
        buffer = await targetElement.screenshot(screenshotOpt);
    } else {
        buffer = await page.screenshot({ ...screenshotOpt, fullPage });
    }
    return buffer;
}

// ====================== 核心入口 writingRules（迭代器实时导出）======================
async function* writingRules(inputArray, outputNodeTemplate) {
    const outputDir = outputNodeTemplate.path;
    const inputPath = path.join(outputDir, '../inputDir');
    const xlsxOutputPath = path.join(inputPath, 'data.xlsx');

    const configFile = inputArray.find(item => item.normExt === 'json' && item.name === 'config');
    if (!configFile) {
        const templateCfg = createConfigTemplate();
        console.log('未找到 config.json，已生成模板配置');
        yield [
            { ...outputNodeTemplate, content: '错误: 未找到 config.json，已生成模板配置' },
            { ...outputNodeTemplate, path: inputPath, fileName: 'config', normExt: 'json', content: JSON.stringify(templateCfg, null, 2) }
        ];
        return;
    }

    const cfg = JSON.parse(configFile.content);
    const { option, delay = 800, steps = [] } = cfg;
    const {
        width,
        height,
        scale,
        userAgent,
        timeout,
        headless = true,
        sessionMode = "oneTab"
    } = option;

    const xlsxFile = inputArray.find(item => item.normExt === 'xlsx' && item.name === 'data');
    if (!xlsxFile) {
        createXlsxTemplate(xlsxOutputPath);
        console.log('未找到 data.xlsx，已生成示例Excel模板');
        yield [{ ...outputNodeTemplate, content: '错误: 未找到 data.xlsx，已生成示例Excel模板' }];
        return;
    }

    const tasks = readExcel(xlsxFile);
    console.log(`已加载 ${tasks.length} 条任务`);

    let successCount = 0;          // 成功截图计数（替代原 outputFiles 累积数组）
    let failCount = 0;             // 失败任务计数
    const executedOnceStep = new Set();

    const browser = await puppeteer.launch({
        headless,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        let sharedPage = null;
        if (sessionMode === "oneTab") {
            sharedPage = await browser.newPage();
            await sharedPage.setViewport({ width, height, deviceScaleFactor: scale });
            if (userAgent) await sharedPage.setUserAgent(userAgent);
        }

        for (const task of tasks) {
            console.log(`\n========== 开始任务：`, task);
            const ctx = { ...task };
            // 把登录持久数据挂载到局部ctx，供模板渲染 {{_data.xxx}}
            console.log('globalData',globalData);
            if(globalData){
                ctx._data = globalData;
            }

            let page;

            if (sessionMode === "oneTab") {
                page = sharedPage;
            }
            if (sessionMode === "newTab") {
                page = await browser.newPage();
                await page.setViewport({ width, height, deviceScaleFactor: scale });
                if (userAgent) await page.setUserAgent(userAgent);
            }

            try {
                for (let stepIdx = 0; stepIdx < steps.length; stepIdx++) {
                    const step = steps[stepIdx];

                    if (step.once && executedOnceStep.has(stepIdx)) {
                        console.log(`跳过once步骤: ${step.stepName}`);
                        continue;
                    }

                    const targetUrl = renderTemplate(step.url, ctx);
                    console.log('访问地址：',targetUrl);
                    await page.goto(targetUrl, {
                        timeout: timeout,
                        waitUntil: 'networkidle2'
                    });

                    if (Array.isArray(step.actions)) {
                        const actions = runPageActions(page, step.actions, ctx, outputNodeTemplate);
                        for await (const outFile of actions) {
                            successCount++;
                            yield [outFile];
                        }
                    }

                    if (step.once) {
                        executedOnceStep.add(stepIdx);
                    }

                    await sleep(delay);
                }
            } catch (err) {
                console.error(`任务执行失败：`, err.message);
                await sleep(1000);
                failCount++;
                yield [{
                    ...outputNodeTemplate,
                    fileName: `task_err`,
                    normExt: 'txt',
                    option: { flag: 'a' },
                    content: Buffer.from(JSON.stringify({ task, error: err.message }, null, 2))
                }];
            }

            if (sessionMode === "newTab") {
                await page.close();
            }
        }
    } finally {
        await browser.close();
        console.log("\n浏览器实例已关闭");
    }

    yield [{
        ...outputNodeTemplate,
        fileName: 'automate_summary',
        normExt: 'json',
        content: JSON.stringify({
            total: tasks.length,
            success: successCount,
            fail: failCount
        }, null, 2)
    }];
    console.log(`\n====执行汇总 | 总任务:${tasks.length} | 成功截图:${successCount} | 失败任务:${failCount}`);
}

// ====================== 插件导出 ======================
module.exports = {
    name: 'browser2auto',
    version: '2.1.2',
    process: writingRules,
    description: 'Excel驱动puppeteer自动化，共享/独立双会话；once单次执行、iframe穿透；迭代器实时导出每张截图；变更：废弃step.type=screenshot；废弃顶层option内fullPage/selector/transparent，截图参数仅在screenshot Action中配置',
    notes: {
        node: '>=18.0.0',
        tips: `
【版本2.1重要变更】
writingRules 改为 async generator，截图/错误/汇总通过 yield 实时导出，无需等待全部任务完成
所有截图参数必须写在actions内screenshot指令：
{
  "screenshot":true,
  "outputName":"文件名_{{reportId}}",
  "selector":"",
  "fullPage":false,
  "transparent":false
}

sessionMode说明：
1. oneTab：全局单页面，登录状态复用，速度快（推荐单账号批量）
2. newTab：每条任务新建页面，会话隔离，适合多账号场景

【重要】FastAdmin带addtabs页面禁止使用switchFrame:"auto"，使用 switchFrame:"iframe[src*='路由']"
        `
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
        "xlsx": "0.18.0"
    }
};