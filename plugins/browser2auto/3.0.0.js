const puppeteer = require('puppeteer');
const xlsx = require('xlsx');
const path = require('path');

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
            "headless": true//是否使用无头浏览器
        },
        "delay": 1200,
        "steps": [
            {
                "stepName": "登录系统",
                "ctxKey": "default",  // Context隔离键：相同值复用同一BrowserContext，cookie/localStorage共享；默认'default'
                "tabKey": "default",      // 标签页复用键：相同值复用同一Page，sessionStorage/DOM状态共享；默认'default'
                "once": true,             // 成功后跳过该step（按stepName标记，失败则下个任务重试）
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
                "ctxKey": "default",
                "tabKey": "default",
                "url": "http://10.23.20.18:8086/?__uid={{session.sessionStorage.__uid}}",
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
    const session = ctx.session

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
            console.log(`[Action] 捕获Cookie、localStorage、sessionStorage存入session`);
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

            // 写入局部session对象（随writingRules调用生命周期，不再用模块级全局变量）
            session.cookies = cookies;
            session.localStorage = storageData.localStorage;
            session.sessionStorage = storageData.sessionStorage;
            // ctx.session 已在主循环挂载，模板渲染用 {{session.sessionStorage.xxx}}
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
        headless = true
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

    let successCount = 0;          // 成功截图计数
    let failCount = 0;             // 失败任务计数
    const executedOnceStep = new Set();   // once标记：按stepName记录已成功执行的step

    // 双键池：ctxKey → BrowserContext，tabKey → Page
    // contextPool[ck] = { context, pagePool: { tk: Page }, session: {} }
    const contextPool = {};

    /**
     * 按双键取/建 Context + Page
     * ctxKey 决定 cookie/localStorage 隔离边界（不同值建独立 incognito context）
     * tabKey 决定 Page 复用（相同值复用同一标签页，保留 sessionStorage/DOM 状态）
     */
    async function getPage(ctxKey='default', tabKey='default') {
        // 首次使用该 ctxKey 时创建 Context（default 用默认 context，其余用 incognito 隔离）
        if (!contextPool[ctxKey]) {
            const context = (ctxKey === 'default')
                ? await browser.defaultBrowserContext()//浏览器默认上下文，所有页面共享 Cookie
                : await browser.createIncognitoBrowserContext();//无痕隔离上下文，和其他上下文完全隔离 Cookie、本地存储，用来做多账号登录互不干扰

            // 存入池子，同时附带一个子pagePool和一个独立session（按ctxKey隔离，多账号不混合）
            contextPool[ctxKey] = { context, pagePool: {}, session: { cookies: [], localStorage: {}, sessionStorage: {} } };
        }

        // 取出当前上下文对象
        const ctxObj = contextPool[ctxKey];
        // 首次使用该 tabKey 时创建 Page
        if (!ctxObj.pagePool[tabKey]) {
            const page = await ctxObj.context.newPage();//新建Page（新标签页）
            await page.setViewport({ width, height, deviceScaleFactor: scale });// 统一设置窗口大小、缩放
            if (userAgent) await page.setUserAgent(userAgent);// 统一设置UA
            ctxObj.pagePool[tabKey] = page;// 把新建页面存入该上下文的pagePool
        }
        // 返回复用的/新建好的Page
        return ctxObj.pagePool[tabKey];
    }

    const browser = await puppeteer.launch({
        headless,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        for (const task of tasks) {
            console.log(`\n========== 开始任务：`, task);
            const ctx = { ...task };   // 不挂全局session，每步按当前ctxKey动态挂载，避免多账号混合

            try {
                for (let stepIdx = 0; stepIdx < steps.length; stepIdx++) {
                    const step = steps[stepIdx];

                    // once：按 stepName 标记，仅当之前已成功执行过才跳过
                    if (step.once && executedOnceStep.has(step.stepName)) {
                        console.log(`跳过once步骤: ${step.stepName}`);
                        continue;
                    }

                    // 渲染双键（支持模板，如 ctxKey:"{{account}}"）
                    const ctxKey = renderTemplate(step.ctxKey || 'default', ctx);
                    const tabKey = renderTemplate(step.tabKey || 'default', ctx);
                    const page = await getPage(ctxKey, tabKey);

                    // 按当前ctxKey挂载该context的独立session，模板渲染用 {{session.xxx}}，多账号不混合
                    ctx.session = contextPool[ctxKey].session;

                    const targetUrl = renderTemplate(step.url, ctx);
                    console.log('访问地址：',targetUrl, `[context=${ctxKey}, tab=${tabKey}]`);
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

                    // once：仅当 step 全部 actions 成功后才标记，失败则下个任务重试
                    if (step.once) {
                        executedOnceStep.add(step.stepName);
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
        }
    } finally {
        // 统一关闭所有 Context（及其下所有 Page）
        for (const ck of Object.keys(contextPool)) {
            try { await contextPool[ck].context.close(); } catch (e) {}
        }
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
    version: '3.0.0',
    process: writingRules,
    description: 'Excel驱动puppeteer自动化；双键(ctxKey/tabKey)驱动会话隔离与标签页复用；once成功后跳过、iframe穿透；迭代器实时导出每张截图',
    notes: {
        node: '>=18.0.0',
        tips: `
【版本3.0重要变更】
1. 废弃 sessionMode（oneTab/newTab），改为双键驱动：
   - ctxKey：Context隔离键，相同值复用同一BrowserContext（cookie/localStorage共享）；默认'default'，不同值建incognito context隔离cookie
   - tabKey：标签页复用键，相同值复用同一Page（sessionStorage/DOM状态共享）；默认'default'
   两键均支持模板渲染（如 ctxKey:"{{account}}" 实现多账号隔离）
2. 废弃模块级 globalData，session 改为局部对象，随调用生命周期销毁
3. once 改为按 stepName 标记 + 成功后才跳过（失败则下个任务重试）
4. 模板渲染 {{session.sessionStorage.__uid}} 替代原 {{_data.sessionStorage.__uid}}

所有截图参数必须写在actions内screenshot指令：
{
  "screenshot":true,
  "value":"文件名_{{reportId}}",
  "fullPage":false
}

双键典型用法：
1. 单账号单页：ctxKey/tabKey 都不写（默认default）
2. 多账号隔离：ctxKey:"{{account}}"，Excel加account列
3. 同账号多页：tabKey:"login"/"work" 分离登录与操作

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