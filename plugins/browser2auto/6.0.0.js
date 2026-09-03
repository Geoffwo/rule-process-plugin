const puppeteer = require('puppeteer');
const xlsx = require('xlsx');
const path = require('path');
const axios = require('axios');
const { URL } = require('url');
const http = require('http');
const vm = require('vm');
const { createRequire } = require('module');

// ====================== 公共工具函数 ======================
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 沙盒方式加载外部JS配置文本，模拟Node模块环境执行，返回模块导出对象
 * 区别于直接 require(filePath)：不会进入Node模块缓存，使用vm沙盒隔离运行
 * @param {Object} file - 文件对象，预先读取完毕
 * @param {string} file.path - js配置文件绝对物理路径
 * @param {string} file.content - js配置文件源码字符串（已经读取完成）
 * @returns {any} 配置文件 module.exports 的导出内容，通常为配置对象
 */
function loadJsConfig(file) {
    // 获取配置文件完整绝对路径
    const filePath = file.path
    // 拿到已经读取好的JS文件源码文本
    const code = file.content;

    // 模拟node模块里的 module.exports 对象，沙盒内代码会向这个对象写导出
    const moduleExports = {};

    // 获取配置文件所在文件夹路径，用于模拟 __dirname
    const cfgFileDir = path.dirname(filePath);

    // 利用module.createRequire 创建绑定该文件路径的require函数
    // 保证配置文件内部写 require('./xxx') 时，相对路径以当前配置文件位置作为基准，而不是调用方脚本位置
    const boundRequire = createRequire(filePath);

    // 构造 context 对象（手动模拟 Node 的模块环境）
    // vm沙盒执行环境，沙盒内的JS能访问这里定义的全部变量
    const context = {
        // 模拟node的module对象，exports指向我们预先定义好的空导出对象
        module: { exports: moduleExports },
        // 模拟顶层 exports 变量，和 module.exports 保持一致
        exports: moduleExports,
        // 注入绑定路径的require，支持配置内部引入其他js文件
        require: boundRequire,
        // 模拟node全局 __dirname：当前配置文件所在目录
        __dirname: cfgFileDir,
        // 模拟node全局 __filename：当前配置文件完整路径
        __filename: filePath
    };

    // vm 是 Node.js内置核心模块，不需要npm安装
    // new vm.Script：编译JS源码字符串，生成可执行脚本对象，语法错误会在这里抛出
    // filename 参数用于报错堆栈显示，出错时控制台会显示该文件名，方便调试
    const script = new vm.Script(code, { filename: filePath });

    // 在全新隔离的沙盒context中执行编译后的脚本
    // 配置文件里面的全部代码，都跑在这个隔离环境，不会污染主进程全局作用域
    script.runInNewContext(context);

    // 脚本执行完毕，沙盒内代码的 module.exports 数据已经写入 moduleExports
    // 返回配置文件导出的配置对象给上层调用者
    return context.module.exports;
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
 * createXlsxTemplate：生成搜索指令模板excel
 * @param {string} outputPath 输出文件路径
 */
function createXlsxTemplate(outputPath) {
    // 示例：必应高级搜索指令任务清单
    const sampleSearchTasks = [
        {
            taskId: "001",
            searchQuery: "site:zhihu.com 人工智能 filetype:pdf",
            title: "人工智能行业报告",
            url: "https://www.tup.tsinghua.edu.cn/upload/books/yz/107125-01.pdf"
        },
        {
            taskId: "002",
            searchQuery: "site:zhihu.com 人工智能 filetype:pdf",
            title: "人工智能发展报告",
            url: "https://www.qstheory.cn/20250914/6684ebcd16794a898ad15832e7fa793b/c.html"
        },
        {
            taskId: "003",
            searchQuery: "site:zhihu.com 人工智能 filetype:pdf",
            title: "人工智能百科",
            url: "https://www.caai.cn/"
        },
        {
            taskId: "004",
            searchQuery: "site:zhihu.com 人工智能 filetype:pdf",
            title: "人工智能百度",
            url: "https://baike.baidu.com/item/%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD/58131596"
        }
    ];
    const workbook = xlsx.utils.book_new();
    const worksheet = xlsx.utils.json_to_sheet(sampleSearchTasks);
    xlsx.utils.book_append_sheet(workbook, worksheet, 'SearchTasks');
    xlsx.writeFile(workbook, outputPath);
    console.log(`[模板] 已生成必应搜索任务Excel：${outputPath}`);
}

/**
 * 根据调试端口，自动获取webSocketDebuggerUrl
 * @param {number} port
 * @returns {Promise<string|null>}
 */
function getWsFromPort(port){
    return new Promise((resolve,reject)=>{
        const req = http.get(`http://127.0.0.1:${port}/json/version`,(res)=>{
            let buf = '';
            res.on('data',chunk=>buf+=chunk);
            res.on('end',()=>{
                try{
                    const info = JSON.parse(buf);
                    resolve(info.webSocketDebuggerUrl);
                }catch(e){
                    reject(e);
                }
            })
        })
        req.on('error',err=>reject(err));
        req.setTimeout(5000);
    })
}

/**
 * 递归遍历对象/数组，所有字符串执行模板渲染
 */
function deepRenderTemplate(obj, data) {
    if (typeof obj === 'string') {
        return renderTemplate(obj, data);
    }
    if (Array.isArray(obj)) {
        return obj.map(item => deepRenderTemplate(item, data));
    }
    if (obj && typeof obj === 'object') {
        const newObj = {};
        for (const k in obj) {
            newObj[k] = deepRenderTemplate(obj[k], data);
        }
        return newObj;
    }
    return obj;
}

// 放在外层作用域，只定义一次
function previewData(val, maxArr = 3, maxStr = 50) {
    if (typeof val === 'string') {
        return val.length > maxStr ? val.slice(0, maxStr) + '...' : val;
    }
    if (Array.isArray(val)) {
        const preview = val.slice(0, maxArr).map(item => previewData(item, maxArr, maxStr));
        if (val.length > maxArr) {
            preview.push(`...【省略 ${val.length - maxArr} 条】`);
        }
        return preview;
    }
    if (val && typeof val === 'object') {
        const newObj = {};
        const keys = Object.keys(val);
        keys.forEach(k => {
            newObj[k] = previewData(val[k], maxArr, maxStr);
        });
        return newObj;
    }
    return val;
}

/**
 * matchUrl 转 RegExp：* 通配任意字符，其余字符转义
 * 示例："http://localhost:8086/*" → /^http:\/\/localhost:8086\/.*$/
 */
function matchUrlToRegex(matchUrl) {
    // 1.临时把*替换为标记符，防止被正则转义吃掉
    const temp = matchUrl.replace(/\*/g, '\uFFFF');
    // 2.转义全部正则特殊符号
    const escaped = temp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 3.把临时标记换回 .*
    const final = escaped.replace(/\uFFFF/g, '.*');
    return new RegExp('^' + final + '$');
}

/**
 * createConfigTemplate 返回极简配置json，和你示例格式1:1对齐
 * {{query}} 取excel行的query字段作为bing搜索q参数
 */
function createConfigTemplate() {
    return {
        "option": {
            "width": 1366,
            "height": 900,
            "scale": 1,
            "userAgent": "",
            "timeout": 30000,
            // 第二轮完全不需要浏览器页面渲染，但是插件底层强制需要puppeteer实例，headless:true静默后台跑
            "headless": true
        },
        "delay": 1200,
        "cdp": {
            "port":9222,
            "url":"ws://127.0.0.1:9222/devtools/browser/5d3ce027-09d1-4a55-822f-e6a1b609b01b",
            "tabs":[
                {
                    "tabKey":"mifcp",
                    "matchUrl":"http://localhost:8086/*"
                },
                {
                    "tabKey":"crss",
                    "matchUrl":"http://10.23.20.155:8003/*"
                }
            ]
        },
        "steps":[
            {
                "stepName":"登录MIFCP系统",
                "ctxKey":"default",
                "tabKey":"mifcp",
                "url":"http://localhost:8086/login",
                "once": true,
                "actions":[
                    {"clearInput": "#login_name"},
                    {"input": "#login_name","value": "ecp"},
                    {"clearInput": "#password"},
                    {"input": "#password","value": "Dareway@2026"},
                    {"click": "#sbmit"},
                    { "waitNavigation": "networkidle2" },
                    { "updateCtx": true}
                ]
            },
            {
                "stepName":"登录CRSS系统",
                "ctxKey":"default",
                "tabKey":"crss",
                "url":"http://10.23.20.155:8003/login",
                "once": true,
                "actions":[
                    {"clearInput": "#login_name"},
                    {"input": "#login_name","value": "admin"},
                    {"clearInput": "#password"},
                    {"input": "#password","value": "Dareway@2024"},
                    {"click": "#sbmit"}
                ]
            },
            {
                "stepName":"进入首页",
                "ctxKey":"default",
                "tabKey":"mifcp",
                "url":"",
                "actions":[
                    { "waitSelector": ".treeview"},
                    { "click": ".treeview", "value": "物价管理" },

                    { "waitSelector": "a.nav-link"},
                    { "click": "a.nav-link", "value": "标准物价目录" },

                    { "switchFrame": "iframe[src*='medPriceManage/fwdStandardPriceManage']"},
                    { "waitSelector": ".container-fluid"},
                    { "select": "#gather_caliber", "text":"治疗费" },
                    { "click": "#btn_query" },
                    { "waitMs": 1000 },
                    { "screenshot": ".container-fluid","fullPage": false},

                    //文件下载
                    {"click": "#btn_download"},
                    { "waitMs": 1000 },

                    //文件上传
                    {"click": "#btn_import"},
                    // 切入导入弹窗的iframe
                    { "switchFrame": "iframe[src*='fwdImportPriceCompare']" },
                    // 现在才在弹窗iframe内部等待 #file_upload
                    { "waitSelector": "#file_upload" },
                    // fileUpload 上传文件
                    {"fileUpload": "#file_upload","value":"C:\\Users\\29976\\Downloads\\excel_{{title}}.xlsx"},
                    { "click": ".layui-layer-ico.layui-layer-close.layui-layer-close1" },
                    { "popFrame": true },

                    { "waitMs": 1000 },
                    {
                        "axiosApi": "http://localhost:8086/medPriceManage/exportPriceCompareExcel?__uid={{session.sessionStorage.__uid}}",
                        "method": "POST",
                        "responseType": "buffer",
                        "headers": {
                            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                            "Accept": "*/*"
                        },
                        "timeout": 25000,
                        "storeKey": "downloadBuf"
                    },
                    // 将buffer导出成磁盘文件
                    { "exportData": "downloadBuf","value": "excel_{{title}}","ext": "xlsx"},
                    // 清理本轮上下文变量，避免污染下一行task
                    { "ctxClear": ["downloadBuf"]},
                ]
            }
        ]
    };
}

// =========【新增：抽离公共浏览器fetch函数，和fetchApi action逻辑完全一致】=========
/**
 * @param {object} target page / frame
 * @param {string} apiUrl
 * @param {string} method
 * @param {object} reqHeaders
 * @param {any} rawBody
 * @param {string} responseType json|buffer|text
 */
async function innerBrowserFetch(target, apiUrl, method, reqHeaders, rawBody, responseType) {
    let bodyPayload = null;
    if (rawBody !== undefined && rawBody !== null && rawBody !== "") {
        // 对象自动序列化json；字符串直接使用（表单字符串）
        bodyPayload = typeof rawBody === "object" ? JSON.stringify(rawBody) : rawBody;
    }

    const respData = await target.evaluate(async (url, reqMethod, headersObj, bodyStr, respType) => {
        const opt = {
            method: reqMethod,
            credentials: "include", // 带上cookie，优先使用include
            headers: { ...headersObj }
        };

        // GET请求禁止附加body
        if (bodyStr && reqMethod !== "GET") {
            opt.body = bodyStr;
            // 没有手动设置Content-Type时默认json
            if (!opt.headers["Content-Type"] && !opt.headers["content-type"]) {
                opt.headers["Content-Type"] = "application/json";
            }
        }

        const res = await fetch(url, opt);

        if(respType === "buffer"){
            // 二进制文件：返回Uint8Array数组，传给node层转Buffer
            const ab = await res.arrayBuffer();
            return {
                __success: res.ok, // ✔修复：不要写死true，http状态判断
                __status: res.status,
                __isBinary: true,
                bytes: Array.from(new Uint8Array(ab))
            };
        } else if(respType === "json"){
            // 默认json模式，原有逻辑不变
            try {
                const json = await res.json();
                return {
                    __success: res.ok,
                    __status: res.status,
                    __isBinary: false,
                    data: json
                };
            } catch(e) {
                // 返回不是json文本，解析失败
                return {
                    __success: false,
                    __status: res.status,
                    __isBinary: false,
                    error: "json parse fail:" + e.message
                }
            }
        } else {
            // text/html兜底分支，防止返回undefined
            const text = await res.text();
            return {
                __success: res.ok,
                __status: res.status,
                __isBinary: false,
                data: text,
                __textMode: true
            }
        }
    }, apiUrl, method, reqHeaders, bodyPayload, responseType);

    if (respData.__isBinary) {
        return Buffer.from(respData.bytes);
    } else {
        return respData;
    }
}
// =================================================================================

/**
 * 执行页面动作队列（generator：截图实时 yield，支持迭代器实时导出）
 * 废弃全局截图参数，所有截图配置仅来自screenshot action
 */
async function* runPageActions(page, actions, ctx, outputTpl) {
    // iframe栈：每一次switchFrame就压入旧target；popFrame弹出恢复；栈底永远是page
    const frameStack = [page];
    // target 永远取栈顶
    let target = frameStack.at(-1);
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
            const fileName = renderTemplate(action.value || tmpTime, ctx);//解析文件名模板
            yield {
                ...outputTpl,
                fileName,
                normExt: 'png',
                content: buf
            };
            console.log(`[Action] 截图生成：${fileName}.png`);
            continue;
        }

        // ========== 【新增】DOM数据提取 Action ==========
        if (action.getData) {
            const sel = renderTemplate(action.getData, ctx);
            const storeKey = renderTemplate(action.storeKey, ctx); // 存入ctx的键名
            const attr = action.value || "textContent"; // 默认取文本，可填 innerHTML / value / href
            // 二次提取配置
            const collect = action.collect;

            await target.waitForSelector(sel, { timeout: 12000 });
            const data = await target.evaluate((selector, attrName, collect) => {
                const els = Array.from(document.querySelectorAll(selector));

                // 无collect：原有一维数组逻辑保持不变
                if (!collect) {
                    const list = els.map(el => el[attrName]?.trim() || "");
                    // 长度为1，直接返回字符串
                    return list.length === 1 ? list[0] : list;
                }

                // ============新增：对象数组模式===========
                if(Array.isArray(collect) && typeof collect[0] === "object"){
                    return els.map(el=>{
                        const rowObj = {};
                        collect.forEach(item=>{
                            const cell = el.querySelector(item.sel);
                            const val = cell ? (cell[item.value || attrName]?.trim() || "") : "";
                            rowObj[item.key] = val;
                        })
                        return rowObj;
                    })
                }

                // 有collect → 输出对象数组
                return els.map(el => {
                    const rowObj = {};

                    if (Array.isArray(collect) && collect.length > 0) {
                        collect.forEach((colSel, idx) => {
                            const cell = el.querySelector(colSel);
                            // key 默认 idx0、idx1、idx2……
                            rowObj[`idx${idx}`] = cell ? (cell[attrName]?.trim() || "") : "";
                        });
                    }

                    if (typeof collect === 'string') {
                        const cells = Array.from(el.querySelectorAll(collect));
                        cells.forEach((cell,idx)=>{
                            // key 默认 idx0、idx1、idx2……
                            rowObj[`idx${idx}`] = cell ? (cell[attrName]?.trim() || "") : "";
                        })
                    }

                    return rowObj;
                });
            }, sel, attr, collect);

            // 存入上下文，全局模板可直接 {{ctx.xxx}} 使用
            ctx[storeKey] = data;
            console.log(`[Action] getData 提取数据 ${storeKey} =`, previewData(data));
            continue;
        }

        // ========== 【新增】【轻爬虫】页面内请求接口（复用浏览器登录态） ==========
        if (action.fetchApi) {
            const apiUrl = renderTemplate(action.fetchApi, ctx);
            const method = (action.method || "GET").toUpperCase();
            // 使用deepRender 解析headers对象内部模板
            const reqHeaders = deepRenderTemplate(action.headers || {}, ctx);
            const rawBody = deepRenderTemplate(action.body, ctx);
            const storeKey = renderTemplate(action.storeKey, ctx);
            const responseType = renderTemplate(action.responseType || "json", ctx);

            try {
                // 【最小改动】直接复用已抽取公共函数，移除重复evaluate代码
                const res = await innerBrowserFetch(target, apiUrl, method, reqHeaders, rawBody, responseType);
                ctx[storeKey] = res;
            } catch (err) {
                console.error(`[Action] fetchApi 请求失败 url:${apiUrl}`, err.message);
            }
            continue;
        }

        // ==========【新增Action：axiosApi Node层Axios请求】==========
        if (action.axiosApi) {
            const apiUrl = renderTemplate(action.axiosApi, ctx);
            const method = (action.method || "GET").toUpperCase();
            const reqHeaders = deepRenderTemplate(action.headers || {}, ctx);
            const rawBody = deepRenderTemplate(action.body, ctx);
            const storeKey = renderTemplate(action.storeKey, ctx);
            const responseType = renderTemplate(action.responseType || "json", ctx);

            // puppeteer cookie数组转为请求Cookie头
            function cookiesToHeader(cookieList, targetUrl) {
                try {
                    const u = new URL(targetUrl);
                    const valid = cookieList.filter(c => {
                        const d = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
                        return u.hostname.endsWith(d);
                    });
                    return valid.map(c => `${c.name}=${c.value}`).join('; ');
                } catch {
                    return '';
                }
            }

            try {
                // 从当前ctxKey对应的session取出cookie
                const cookieStr = cookiesToHeader(ctx.session.cookies, apiUrl);
                if (cookieStr) {
                    reqHeaders['Cookie'] = cookieStr;
                }

                let bodyPayload = null;
                if (rawBody != null && method !== 'GET') {
                    bodyPayload = typeof rawBody === 'object' ? JSON.stringify(rawBody) : rawBody;
                }

                // =========核心修复：框架标记buffer，axios底层使用arraybuffer=========
                const axiosRespType = responseType === 'buffer' ? 'arraybuffer' : responseType;

                const resp = await axios({
                    url: apiUrl,
                    method,
                    headers: reqHeaders,
                    data: bodyPayload,
                    responseType: axiosRespType,
                    timeout: action.timeout ?? 30000
                });

                if (responseType === 'buffer') {
                    ctx[storeKey] = resp.data;
                    console.log(`[Action] axiosApi(buffer) 二进制完成，存入ctx.${storeKey}, size:${resp.data.length} bytes`);
                } else {
                    ctx[storeKey] = {
                        __success: true,
                        __status: resp.status,
                        __isBinary: false,
                        data: resp.data
                    };
                    console.log(`[Action] axiosApi(json/text) 请求成功 status:${resp.status}，存入ctx.${storeKey}`);
                }
            } catch (err) {
                console.error(`[Action] axiosApi 请求失败 url:${apiUrl}`, err.message);
                try {
                    const tempPage = await page.browser().newPage();
                    try {
                        if(reqHeaders?.["User-Agent"]){
                            await tempPage.setUserAgent(reqHeaders["User-Agent"]);
                        }
                        await tempPage.setRequestInterception(true);
                        tempPage.on('request', (req) => {
                            if(['image','media','font'].includes(req.resourceType())){
                                return req.abort();
                            }
                            req.continue();
                        });
                        await tempPage.goto(apiUrl, {
                            timeout: action.timeout ?? 25000,
                            waitUntil: "networkidle2"
                        });
                        await sleep(1200);
                        const fullHtml = await tempPage.content();
                        // 此处务必使用标准 utf-8
                        ctx[storeKey] = Buffer.from(fullHtml, "utf-8");
                        ctx[storeKey + "_source"] = "browser_fallback_goto";
                        console.log(`[Action] axiosApi降级成功，通过浏览器goto获取网页HTML，存入ctx.${storeKey}`);
                    } finally {
                        await tempPage.close();
                    }
                } catch (fbErr) {
                    console.error(`[Action] axiosApi 浏览器goto降级同样失败 url:${apiUrl}`, fbErr.message);
                    ctx[storeKey] = null;
                }
            }
            continue;
        }

        if (action.ctxClear) {
            //支持两种用法：数组清除多个key；true清除全部自定义key
            if (action.ctxClear === true) {
                // 保留session、ctxKey等系统内置字段，其余全部清空
                const keepKeys = ['session', 'ctxKey', 'tabKey'];
                Object.keys(ctx).forEach(k => {
                    if (!keepKeys.includes(k)) {
                        delete ctx[k];
                    }
                });
                console.log(`[Action ctxClear] 已清空全部业务上下文变量，保留系统key:${keepKeys.join(',')}`);
            }

            if (Array.isArray(action.ctxClear)) {
                //只清除指定的key数组
                action.ctxClear.forEach(key => {
                    delete ctx[key];
                });
                console.log(`[Action ctxClear] 已清除key: ${action.ctxClear.join(',')}`);
            }

            if (typeof action.ctxClear === 'string') {
                //单个字符串key
                delete ctx[action.ctxClear];
                console.log(`[Action ctxClear] 已清除key: ${action.ctxClear}`);
            }
            continue;
        }

        if (action.json2xlsx) {
            const data = renderTemplate(action.json2xlsx, ctx);
            const tmpTime = `auto_${Date.now()}`;
            const storeKey = renderTemplate(action.storeKey || tmpTime, ctx);
            const saveData = ctx[data];

            // 生成 xlsx buffer
            const ws = xlsx.utils.json_to_sheet(saveData);
            const wb = xlsx.utils.book_new();
            xlsx.utils.book_append_sheet(wb, ws, "Sheet1");
            const outputContent = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });
            ctx[storeKey] = outputContent;

            console.log(`[Action] json2xlsx 转化为 ctx.${storeKey}`);
            continue;
        }

        if (action.exportData) {
            const storeKey = renderTemplate(action.exportData, ctx);
            const tmpTime = `auto_${Date.now()}`;
            const fileName = renderTemplate(action.value || tmpTime, ctx);
            const ext = renderTemplate(action.ext || "txt", ctx);
            const saveData = ctx[storeKey];

            // txt/md/html/csv 等全部原样输出
            let outputContent = saveData || '';

            if (ext === "json") {
                // 优化：已经是字符串就不再序列化，避免双重转义
                if (typeof saveData === 'string') {
                    outputContent = saveData;
                } else {
                    outputContent = JSON.stringify(saveData, null, 2);
                }
            }

            yield {
                ...outputTpl,
                fileName,
                normExt: ext,
                content: outputContent
            };
            console.log(`[Action] exportData 导出数据文件 ${fileName}.${ext}`);
            continue;
        }

        if (action.switchFrame) {//iframe 切换，压栈保存上一层上下文
            let iframeEl = null;
            const selTemplate = renderTemplate(action.switchFrame, ctx);
            if (selTemplate === "auto") {
                iframeEl = await target.waitForSelector("iframe", { timeout: 4000 });
            } else {
                iframeEl = await target.waitForSelector(selTemplate, { timeout: 4000 });
            }
            if (!iframeEl) throw new Error("iframe DOM元素查找超时");

            const frame = await iframeEl.contentFrame();
            if (!frame) throw new Error("iframe 无法获取frame上下文");
            try {
                await frame.waitForFunction(
                    () => document.readyState === "complete",
                    { timeout: 8000 }
                );
            } catch (err) {
                console.warn("iframe内部页面ready等待超时，继续执行");
            }
            // ✅压栈：保存当前target，切换新frame
            frameStack.push(frame);
            target = frameStack.at(-1);
            console.log(`[Action] switchFrame 压栈，栈深度=${frameStack.length}`);
            continue;
        }

        if (action.popFrame) {
            // 弹出上一层iframe，回到进入弹窗iframe之前的上下文
            if(frameStack.length > 1){
                frameStack.pop();
                target = frameStack.at(-1);
                console.log(`[Action] popFrame 回退iframe，栈深度=${frameStack.length}`);
            }else{
                console.warn(`[Action] popFrame 已经是顶层页面，无需回退`);
            }
            continue;
        }

        if (action.resetFrame) {//切回主页面，清空全部iframe栈
            frameStack.length = 0;
            frameStack.push(page);
            target = frameStack.at(-1);
            console.log(`[Action] resetFrame 清空iframe栈，切回顶层主页面`);
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

        if (action.setCtx) {
            const op = renderTemplate(action.setCtx.op, ctx);
            const keyPath = renderTemplate(action.setCtx.key, ctx);
            const rawVal = action.setCtx.value;
            const realValue = renderTemplate(rawVal, ctx);

            if (!keyPath) throw new Error("[setCtx] key不能为空");

            // 按 a.b.c 路径读写对象
            const setNested = (obj, path, val) => {
                const parts = path.split(".");
                let cur = obj;
                for(let i = 0; i < parts.length - 1; i++){
                    const k = parts[i];
                    if(!cur[k]) cur[k] = {};
                    cur = cur[k];
                }
                const lastKey = parts.at(-1);
                if(op === "set"){
                    cur[lastKey] = val;
                }else if(op === "push"){
                    if(!Array.isArray(cur[lastKey])) cur[lastKey] = [];
                    cur[lastKey].push(val);
                }else if(op === "del"){
                    delete cur[lastKey];
                }else{
                    throw new Error(`[setCtx] 不支持op:${op}`);
                }
            };

            setNested(ctx, keyPath, realValue);
            console.log(`[Action] setCtx op=${op} key=${keyPath}`);
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
            await target.evaluate((selector) => {
                const el = document.querySelector(selector);
                if (!el) return;
                el.focus();
                el.select();
                // 模拟删除操作，触发标准Input事件
                const delEvt = new InputEvent('input', {
                    inputType: 'deleteContent',
                    bubbles: true,
                    cancelable: true
                });
                el.value = '';
                el.dispatchEvent(delEvt);
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }, sel);
            console.log(`[Action] clearInput 清空输入框 ${sel}`);
            continue;
        }

        if (action.click) {//点击元素
            const sel = renderTemplate(action.click, ctx);
            const matchText = renderTemplate(action.value || '', ctx);
            const matchIndex = renderTemplate(action.index || '0', ctx);

            await target.evaluate((selector, targetText, idxStr) => {
                const matchedEls = [];
                const list = document.querySelectorAll(selector);
                const text = targetText.trim();
                for (const el of list) {
                    const htmlStr = el.outerHTML;
                    if (text === '') {
                        matchedEls.push(el);
                    } else if (htmlStr.includes(text)) {
                        matchedEls.push(el);
                    }
                }
                // 字符串下标转数字
                const clickIndex = Number(idxStr);
                if (matchedEls[clickIndex]) {
                    matchedEls[clickIndex].click();
                } else {
                    console.warn(`[Click] 找不到下标${clickIndex}的匹配元素，匹配总数：${matchedEls.length}`);
                }
            }, sel, matchText, matchIndex);

            // 构建日志信息
            const logParts = [`[Action] click:${sel}`];
            if (matchText) logParts.push(`文本匹配:"${matchText}"`);
            // 只有index不等于默认0时才输出，如果你想要永远打印，删掉判断
            if (matchIndex !== '0') logParts.push(`索引匹配:${matchIndex}`);
            console.log(logParts.join(' '));
            continue;
        }

        // ==========【新增Action fileUpload 文件上传】==========
        if (action.fileUpload) {
            const sel = renderTemplate(action.fileUpload, ctx);
            // 文件绝对路径，支持模板，单个/数组
            let filePaths = renderTemplate(action.value, ctx);
            // 支持多文件上传，字符串转数组
            if(typeof filePaths === 'string'){
                filePaths = filePaths.split(/[,;]/).map(s=>s.trim()).filter(Boolean);
            }
            await target.waitForSelector(sel, { timeout:12000 });
            const fileInputEl = await target.$(sel);
            if(!fileInputEl){
                throw new Error(`[fileUpload] 找不到input[type="file"]选择器:${sel}`);
            }
            // puppeteer原生上传API，Node层调用，传入本地文件绝对路径
            await fileInputEl.uploadFile(...filePaths);
            console.log(`[Action] fileUpload ${sel} 上传文件:`, filePaths);
            // 部分页面需要手动触发change事件（部分框架不会自动触发）
            await target.evaluate((selector)=>{
                const el = document.querySelector(selector);
                if(el) el.dispatchEvent(new Event('change',{bubbles:true}));
            }, sel);
            continue;
        }

        // ==========【新增Action select下拉框选择】==========
        if (action.select) {
            const selSelector = renderTemplate(action.select, ctx);
            const selectText = renderTemplate(action.text || "", ctx);
            const selectValue = renderTemplate(action.value || "", ctx);
            const selectIndex = Number(renderTemplate(action.index ?? -1, ctx));

            await target.waitForSelector(selSelector, { timeout: 12000 });

            const ret = await target.evaluate((selector, txt, val, idx) => {
                const selEl = document.querySelector(selector);
                if (!selEl || selEl.tagName !== 'SELECT') return { ok: false, msg: "找不到select元素" };
                const options = Array.from(selEl.options);

                if (txt) {
                    // 按显示文本匹配
                    const found = options.find(o => o.textContent?.trim() === txt.trim());
                    if (found) {
                        selEl.value = found.value;
                    } else {
                        return { ok: false, msg: `文本[${txt}]未找到option` };
                    }
                } else if (val) {
                    // 按value匹配
                    selEl.value = val;
                } else if (idx >= 0) {
                    // 按下标选择
                    if(options[idx]) selEl.selectedIndex = idx;
                    else return { ok: false, msg: `下标${idx}超出option范围` };
                }
                // 触发change事件，框架必须
                selEl.dispatchEvent(new Event('change', { bubbles: true }));
                selEl.dispatchEvent(new Event('input', { bubbles: true }));
                return { ok: true, value: selEl.value, text: selEl.options[selEl.selectedIndex]?.textContent };
            }, selSelector, selectText, selectValue, selectIndex);

            const storeKey = renderTemplate(action.storeKey || "", ctx);
            if (storeKey) {
                ctx[storeKey] = ret;
            }
            console.log(`[Action] select ${selSelector} result:`, ret);
            continue;
        }

        if (action.pageJs) {
            const rawTpl = renderTemplate(action.pageJs, ctx);
            const paramKeys = Array.isArray(action.pageJsParams) ? action.pageJsParams : [];
            const passArgs = paramKeys.map(key => ctx[key]);
            const storeKey = renderTemplate(action.storeKey, ctx);

            const data = await target.evaluate((scriptBody, paramNames, paramValues) => {
                // 把参数名+参数值打包进闭包，再new Function
                const fn = new Function(...paramNames, scriptBody);
                return fn(...paramValues);
            }, rawTpl, paramKeys, passArgs);

            if (storeKey && typeof storeKey === 'string') {
                ctx[storeKey] = data;
                console.log(`[Action] pageJs 返回结果存入 ctx.${storeKey}`);
            }
            console.log(`[Action] pageJs 执行前端脚本`);
            continue;
        }

        if (action.ctxJs) {
            const rawCode = renderTemplate(action.ctxJs, ctx);
            const paramKeys = Array.isArray(action.ctxJsParams) ? action.ctxJsParams : [];
            const passArgs = paramKeys.map(k => ctx[k]);
            const storeKey = renderTemplate(action.storeKey, ctx);

            // 第一个入参固定为真实ctx对象，后面是ctxJsParams传入的参数
            const fn = new Function('ctx', ...paramKeys, rawCode);
            // await 支持脚本内部写 await
            const ret = await fn(ctx, ...passArgs);

            if (storeKey && typeof storeKey === 'string') {
                ctx[storeKey] = ret;
            }
            console.log(`[Action] ctxJs 执行Node本地脚本`);
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

    const configFile = inputArray.find(item => item.normExt === 'js' && item.name === 'config');
    if (!configFile) {
        const templateCfg = createConfigTemplate();
        const jsText = `module.exports = ${JSON.stringify(templateCfg, null, 2)};\n`;
        console.log('未找到 config.js，已生成模板配置');
        yield [
            { ...outputNodeTemplate, content: '错误: 未找到 config.js，已生成模板配置' },
            { ...outputNodeTemplate, path: inputPath, fileName: 'config', normExt: 'js', content: jsText }
        ];
        return;
    }

    const cfg = loadJsConfig(configFile);
    const { option, delay = 800, steps = [], cdp } = cfg;
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

        // ==========关键：每次getPage返回前，确保该标签页被激活==========
        const page = ctxObj.pagePool[tabKey];
        await page.bringToFront();//激活标签页

        // 返回复用的/新建好的Page
        return page;
    }

    // 兼容两种模式：1、直接配置ws url；2、配置port自动拉取ws地址
    let connectWsUrl = null;
    if(cdp?.url){
        console.log(`[CDP] 通过固定${cdp.url}地址，访问浏览器...`);
        connectWsUrl = cdp.url;
    }
    //优先级高 覆盖
    if(cdp?.port){
        console.log(`[CDP] 通过端口${cdp.port}自动获取WebSocket地址，访问浏览器...`);
        try{
            connectWsUrl = await getWsFromPort(cdp.port);
            console.log(`[CDP] 获取成功 ws=${connectWsUrl}`);
        }catch(e){
            throw new Error(`CDP端口${cdp.port}连接失败，请确认Edge已经启动 --remote-debugging-port=${cdp.port} --user-data-dir="C:\\edge_debug"，错误：${e.message}`);
        }
    }

    // connect 模式（cdp 存在）连远程浏览器；否则本地 launch
    const browser = connectWsUrl
        ? await puppeteer.connect({ browserWSEndpoint: connectWsUrl, defaultViewport: null })
        : await puppeteer.launch({
            headless,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

    try {
        // ===== tabs：接管已打开标签，注入 default context 的 pagePool =====
        // getPage 主体不动；命中的 tabKey 预注入后直接复用，未命中的走 newPage 原始逻辑
        if (connectWsUrl && Array.isArray(cdp.tabs) && cdp.tabs.length) {
            // 确保 default 池已初始化，以便注入
            if (!contextPool['default']) {
                contextPool['default'] = {
                    context: await browser.defaultBrowserContext(),//浏览器默认上下文，所有页面共享 Cookie
                    pagePool: {},
                    session: { cookies: [], localStorage: {}, sessionStorage: {} }
                };
            }
            const existPages = await contextPool['default'].context.pages();//获取cdp连接浏览器的所有标签页面
            for (const tab of cdp.tabs) {
                const url = matchUrlToRegex(tab.matchUrl);
                const matched = existPages.find(page => url.test(page.url()));//获取页面
                if (matched) {
                    await matched.setViewport({ width, height, deviceScaleFactor: scale });//设置参数
                    if (userAgent) await matched.setUserAgent(userAgent);//设置参数
                    contextPool['default'].pagePool[tab.tabKey] = matched;//存入上下文
                    console.log(`[tabs] 接管 ${tab.tabKey} <- ${matched.url()}`);
                }else{
                    console.log(`[tabs] 接管失败 ${tab.tabKey} -> ${tab.matchUrl} 页面不存在`);
                }
                // 未匹配：不注入，getPage 遇到该 tabKey 时走 newPage
            }
        }
        // ======================================================================

        for (const task of tasks) {
            console.log(`\n========== 开始任务：`, task);
            const ctx = { ...task };   // 不挂全局session，每步按当前ctxKey动态挂载，避免多账号混合

            try {
                for (let stepIdx = 0; stepIdx < steps.length; stepIdx++) {
                    const step = steps[stepIdx];

                    // 渲染双键（支持模板，如 ctxKey:"{{account}}"）
                    const ctxKey = renderTemplate(step.ctxKey || 'default', ctx);
                    const tabKey = renderTemplate(step.tabKey || 'default', ctx);

                    // once：按 stepName 标记，仅当之前已成功执行过才跳过
                    const markKey = `${step.stepName}||${ctxKey}`;
                    if (step.once && executedOnceStep.has(markKey)) {
                        console.log(`跳过once步骤: ${step.stepName} ctxKey:${ctxKey}`);
                        continue;
                    }

                    const page = await getPage(ctxKey, tabKey);

                    // 按当前ctxKey挂载该context的独立session，模板渲染用 {{session.xxx}}，多账号不混合
                    ctx.session = contextPool[ctxKey].session;

                    const targetUrl = renderTemplate(step.url, ctx);

                    // 目标URL与当前完全相等则跳过导航，避免刷新接管标签的已有状态
                    const sameUrl = targetUrl && page.url() === targetUrl;
                    if (!targetUrl) {
                        console.log('访问地址：[无step.url，复用tabKey页面]', `[context=${ctxKey}, tab=${tabKey}]`);
                    }else if (sameUrl) {
                        console.log('访问地址：[跳过导航]当前已是目标页', targetUrl, `[context=${ctxKey}, tab=${tabKey}]`);
                    } else {
                        console.log('访问地址：',targetUrl, `[context=${ctxKey}, tab=${tabKey}]`);
                        await page.goto(targetUrl, {
                            timeout: timeout,
                            waitUntil: 'networkidle2'
                        });
                    }

                    if (Array.isArray(step.actions)) {
                        const actions = runPageActions(page, step.actions, ctx, outputNodeTemplate);
                        for await (const outFile of actions) {
                            successCount++;
                            yield [outFile];
                        }
                    }

                    // once：仅当 step 全部 actions 成功后才标记，失败则下个任务重试
                    if (step.once) {
                        executedOnceStep.add(markKey);
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

        // =====================【新增：全局后置钩子 afterAllHook】=====================
        if (cfg.afterAllHook && Array.isArray(cfg.afterAllHook) && cfg.afterAllHook.length > 0) {
            console.log(`\n[afterAllHook] 全部任务执行完毕，开始执行全局后置钩子，共${cfg.afterAllHook.length}个action`);
            try {
                // afterAllHook 没有task，使用空ctx，只挂载default的session
                const globalCtx = {};
                const globalCtxKey = "default";
                // 读取default上下文session
                if(contextPool[globalCtxKey]){
                    globalCtx.session = contextPool[globalCtxKey].session;
                }

                // 获取一个page实例用于执行actions（复用default的tab）
                const page = await getPage(globalCtxKey, "default");
                // 复用已经存在的 runPageActions 迭代器，不需要重写action解析
                const hookActions = runPageActions(page, cfg.afterAllHook, globalCtx, outputNodeTemplate);
                for await (const outFile of hookActions) {
                    yield [outFile];
                }
                console.log(`[afterAllHook] 全局后置钩子执行完成`);
            } catch (hookErr) {
                console.error(`[afterAllHook] 后置钩子执行异常，不影响已完成任务：`, hookErr.message);
            }
        }
        // =========================================================================
    } finally {
        // 统一关闭所有 Context（及其下所有 Page）
        for (const ck of Object.keys(contextPool)) {
            try { await contextPool[ck].context.close(); } catch (e) {}
        }
        // connect 模式仅断开连接（保留远程浏览器与已开标签），launch 模式关闭本地浏览器
        if (cdp?.url || cdp?.port) {
            browser.disconnect();
            console.log("\n已断开远程浏览器连接（远程进程保留）");
        } else {
            await browser.close();
            console.log("\n浏览器实例已关闭");
        }
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
    version: '6.0.0',
    process: writingRules,
    description: 'Excel驱动puppeteer自动化；双键(ctxKey/tabKey)驱动会话隔离与标签页复用；once成功后跳过、iframe穿透；迭代器实时导出；getData采集、select原生下拉选择、fetchApi浏览器上下文请求、axiosApi Node层axios请求、json2xlsx转换、exportData多格式导出、ctxClear上下文清理；cdp远程CDP连接+tabs接管已开标签+goto同URL跳过刷新',
    notes: {
        node: '>=18.0.0',
        tips: `
【核心机制说明】
1. 双键会话隔离
ctxKey：BrowserContext隔离键；相同值共享Cookie、localStorage；不同值创建无痕上下文实现多账号隔离，默认default；支持模板渲染 {{字段}}
tabKey：Page标签复用键；相同值复用同一个页面，保留DOM与sessionStorage，默认default；支持模板渲染 {{字段}}
2. once机制：step标记once=true，整段actions全部执行成功后永久跳过；任务失败不标记，下一条任务重试
3. CDP远程连接与标签接管（cdp.url + cdp.tabs）
url：cdp 内配置，有值时通过CDP(ws://host:9222/devtools/browser/xxx)连接远程浏览器，本地launch的headless/args失效；无值时本地launch保持原逻辑
tabs：顶层配置数组[{tabKey,matchUrl}]，connect后按matchUrl(glob，*通配任意字符)匹配已开标签，命中的注入default context的pagePool，getPage直接复用(继承登录态)，未命中走newPage原始逻辑
port：通过端口自动获取WebSocket地址，需要与CDP启动时设置的【--remote-debugging-port=xxx端口 --user-data-dir="C:\\edge_debug"】保持一致
goto同URL跳过：step.url与当前page.url()完全相等时跳过导航，避免刷新接管标签的已有状态(about:blank不跳过)
关闭语义：connect模式用browser.disconnect()保留远程浏览器与已开标签，launch模式用browser.close()

【完整Action指令清单】
◆ screenshot 区域/整页截图
{
  "screenshot":"选择器/auto",
  "value":"输出文件名_{{reportId}}",
  "fullPage":false
}
screenshot="auto"：整页截图；填写CSS选择器：元素截图
fullPage：仅auto模式生效，true=完整长页面，false=可视区域

◆ select 原生select下拉框选择（仅支持html原生select，el-select/ant-select模拟下拉用click）
{
  "select":"#province",
  "text":"山东省",
  "value":"370000",
  "index":0,
  "storeKey":"selResult"
}
text：按option显示文本匹配；value：按option value匹配；index：按下标选择；三选一；自动派发change、input事件；结果存入ctx.selResult={ok,value,text}；支持模板变量 {{excel字段}}

◆ getData DOM数据采集
{
  "getData":"table tbody tr",
  "collect":["td:nth-child(1)","td:nth-child(2)"] / "td" / [{"sel":"td:nth-child(1)","key":"name","value":"textContent"}],
  "value":"textContent",
  "storeKey":"tableList"
}
getData：父行选择器；value：取值属性 textContent / innerHTML / value / href
collect = 字符串：el.querySelectorAll，输出[{idx0,idx1}...]
collect = 简单数组：多个独立子选择器el.querySelector，输出[{idx0,idx1}...]
collect = 对象数组：自定义key与子选择器，输出[{name:"xxx",...}]
无collect：直接提取getData匹配元素属性；结果数组长度=1自动拆包为字符串
storeKey：数据存入ctx变量，全局模板 {{tableList}} 读取

◆ exportData 多格式文件导出(json/txt/csv/md/html)
{"exportData":"tableList","value":"detail_{{reportId}}","ext":"json"}
exportData：ctx内数据key；value：输出文件名；ext：输出后缀

◆ json2xlsx 将ctx内JSON数组转为xlsx二进制Buffer存入ctx
{"json2xlsx":"tableList","storeKey":"excelBuf"}
后续可结合exportData导出xlsx文件

◆ ctxClear 清理ctx业务变量，保留session、ctxKey、tabKey系统字段
{"ctxClear":true} //清空全部业务key
{"ctxClear":["a","b"]} //清空指定key数组
{"ctxClear":"tableList"} //清空单个key

◆ fetchApi 在浏览器页面上下文发起请求（自动携带当前Cookie、credentials:include）
{
  "fetchApi":"接口地址",
  "method":"POST",
  "headers":{},
  "body":{},
  "responseType":"json|text|buffer",
  "storeKey":"respData"
}
method 默认GET；body对象自动序列化为JSON；GET请求忽略body
responseType：
  json(默认): {__success:boolean, __status:状态码, __isBinary:false, data:{...}}
  text: {__success:boolean, __status:状态码, __isBinary:false, data:"文本"}
  buffer: 下载二进制，ctx[storeKey]直接得到Node Buffer对象
元字段__success/__status/__isBinary为框架内部标记，非业务数据；网络异常ctx[storeKey]={__success:false,error:"xxx"}

◆ axiosApi Node层axios请求，自动同步当前ctxKey对应的浏览器Cookie
{
  "axiosApi":"接口地址",
  "method":"POST",
  "headers":{},
  "body":{},
  "responseType":"json|text|buffer",
  "timeout":30000,
  "storeKey":"axiosResp"
}
responseType=buffer：ctx得到原始Buffer；json/text返回 {__success,__status,data}
会自动把当前ctxKey下browserContext的有效Cookie注入请求头Cookie

◆ switchFrame / resetFrame iframe上下文切换
{"switchFrame":"iframe[src*='medPriceManage']"}
{"switchFrame":"auto"} // 匹配页面第一个iframe
{"resetFrame":true} // 切回顶层主页面

◆ waitSelector 等待DOM元素渲染
{"waitSelector":"input[name='item_code']"}

◆ input 输入文本
{"input":"选择器","value":"{{reportId}}"}

◆ clearInput 清空输入框，触发input/change事件
{"clearInput":"选择器"}

◆ click 点击元素（支持文本模糊匹配outerHTML、索引）
{
  "click":"a.nav-link",
  "value":"标准物价目录",
  "index":"0"
}
value：匹配元素outerHTML包含指定文本，空则匹配全部元素
index：选中匹配列表内第N个元素，默认0

◆ waitMs 固定延时
{"waitMs":1200}

◆ waitNavigation 等待页面跳转加载
{"waitNavigation":"networkidle2"}

◆ pageJs 在页面执行原生JS脚本，支持传参、结果存入ctx
{"pageJs":"return document.title;","pageJsParams":["xxx"],"storeKey":"titleVal"}

◆ humanWait 人工介入暂停，控制台回车继续
{"humanWait":"请完成验证码操作后回车"}

◆ updateCtx 捕获当前target(page/iframe)Cookie、localStorage、sessionStorage存入session
{"updateCtx":true}
模板读取示例 {{session.sessionStorage.__uid}}

【双键典型用法】
1. 单账号单页：ctxKey/tabKey 都不写（默认default）
2. 多账号隔离：ctxKey:"{{account}}"，Excel增加account列
3. 同账号多标签：tabKey:"login"/"work" 分离登录步骤与业务操作

【重要注意事项】
1. FastAdmin addtabs框架禁止 switchFrame:"auto"，使用精确iframe src选择器
2. 所有字符串配置支持模板渲染 {{ctx字段}}、{{session.sessionStorage.xxx}}
3. getData、click、input、waitSelector等选择器均支持模板变量
4. fetchApi运行在浏览器evaluate沙盒，不能直接访问node对象；二进制buffer通过__isBinary标记跨上下文序列化
5. axiosApi运行在Node主线程，读取浏览器cookie再发起http请求，不受页面JS沙盒限制
        `
    },
    input: {
        normExt: 'xlsx + json',
        description: 'data.xlsx 任务清单 + config.json 自动化流程配置'
    },
    output: {
        normExt: 'png,txt,json,xlsx'
    },
    rely: {
        "puppeteer": "19.11.1",
        "xlsx": "0.18.0",
        "axios": "1.6.0"
    }
};