/**
 * Windows UIA 自动化操作规则（PoC）
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 【这是什么】
 * 基于 Windows UI Automation（UIA，无障碍自动化接口）驱动桌面应用：
 *   按元素名定位控件（菜单项/按钮/树节点/输入框...）→ 模拟点击/输入/展开等操作。
 * 典型场景：自动打开 HIS 客户端的"病例树"（点击菜单 → 点击/展开树节点）。
 *
 * 【依赖选型：win-auto-ts】
 * 通过 Koffi FFI 直接调用微软 UIA COM 接口：
 *   - 纯 npm 安装（koffi 附带预编译二进制），无 node-gyp 编译、无 PowerShell、无 WinAppDriver
 *   - 依赖 1 个 npm 包：npm i win-auto-ts
 *   - 仅支持 Windows + Node >= 18
 * 注意：该包是 ESM 模块（"type": "module"），而本规则文件是 CommonJS，
 *       所以必须用动态 import() 加载（require() 会直接报错）。
 *
 * 【UIA 核心概念（不懂 UIA 的话看这里）】
 * 1. UIA 树：Windows 把每个窗口的控件组织成一棵树（窗口 → 菜单栏 → 菜单项...），
 *    每个控件有 Name（显示名）、ControlType（控件类型：button/edit/treeitem...）。
 * 2. 定位器 locator(窗口, 类型, 名称)：按"类型 + 名称"在整棵树里查找元素，
 *    找不到会按超时时间轮询等待（应对界面延迟加载）。
 * 3. 控制模式（Pattern）：UIA 操作控件的标准化方式。
 *    click()   → InvokePattern  "程序级点击"，不依赖鼠标焦点，窗口被遮挡也能点
 *    clickInput() → 物理鼠标点击，真实移动光标，用于不响应 Invoke 的控件
 *    typeValue()  → ValuePattern 直接设值（比键盘输入快且稳定）
 *    expand()/collapse() → 展开/收起树节点、下拉框
 *
 * 【使用方式】
 * 1. 安装依赖：npm i win-auto-ts
 * 2. 准备任务文件：把 *.uia.json 放入 inputDir（不存在时本规则会自动生成演示任务）
 * 3. 运行：rule-process run -r examples/ruleDir2/rule-uia.js -i examples/inputDir -o examples/outputDir
 * 4. 查看结果：outputDir/<任务名>_report.json（每一步的执行结果/耗时/读回值）
 *
 * 【如何找到目标控件的名称】
 * 任务里加 "inspect": true，运行后控制台会打印该窗口全部可用元素，
 * 形如 locator(appWindow, 'treeitem', '病例树')，把名称抄进任务 JSON 即可。
 * ─────────────────────────────────────────────────────────────────────────────
 */

const path = require('path');
const { spawn } = require('child_process');

/** 演示任务：启动记事本 → 输入文本 → 读回内容 → 点击"最小化"按钮 */
const DEMO_TASK = {
    app: {
        title: '记事本',       // 窗口标题（部分匹配）；已有同名窗口会直接附加，不再重复启动
        launch: 'notepad',     // 窗口不存在时才执行的启动命令；传 null 表示只附加不启动
        maximize: false        // 是否最大化窗口
    },
    inspect: false,            // true = 打印窗口内全部元素名（用于探索控件名称）
    continueOnError: false,    // true = 单步失败后继续执行后续步骤
    steps: [
        // Win11 记事本编辑区名称为"文本编辑器"；Win10 老版记事本可能为空名，
        // 此时把 inspect 设为 true 跑一次，从控制台抄实际名称回来改这一步
        { action: 'exists',    type: 'edit',   name: '文本编辑器', note: '等待编辑区就绪' },
        { action: 'typeValue', type: 'edit',   name: '文本编辑器', value: 'UIA PoC 自动化注入文本', note: '演示 ValuePattern 输入' },
        { action: 'getValue',  type: 'edit',   name: '文本编辑器', saveAs: 'editorText', note: '读回编辑区内容写入报告' },
        // 模拟点击演示：标题栏按钮名称跨应用稳定，是最安全的点击目标
        { action: 'click',     type: 'button', name: '最小化', note: '演示 InvokePattern 点击' }
    ]
};

/* HIS"病例树"任务示例（按贵院客户端实际元素名改写）：
 * {
 *   "app": { "title": "门诊医生站", "launch": null },
 *   "steps": [
 *     { "action": "click",  "type": "menuitem", "name": "病历管理" },
 *     { "action": "click",  "type": "treeitem", "name": "病例树" },
 *     { "action": "expand", "type": "treeitem", "name": "心血管内科" },
 *     { "action": "exists", "type": "treeitem", "name": "张三 - 住院号123456" }
 *   ]
 * }
 */

/**
 * 自实现"启动应用并等待窗口"：
 * 官方 launchAndFind 内部用 child_process.exec(cmd) 启动，exec 的子进程句柄
 * 会挂住 Node 事件循环直到目标应用退出（演示任务只"最小化"不关闭）→ 进程卡死无法退出。
 * 这里改用 detached + unref 的 spawn：目标应用与本进程生命周期解耦，不阻塞退出。
 */
async function launchAndFindWindow(wats, cmd, title, timeoutMs = 15000, pollMs = 500) {
    const child = spawn(cmd, { shell: true, detached: true, stdio: 'ignore' });
    child.unref(); // 关键：解除事件循环引用，目标应用不退出也不会卡住本进程

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const desktop = wats.getDesktop();
        const windows = wats.findChildren(desktop); // 顶层窗口 = 桌面的直接子元素
        let match = null;
        for (const win of windows) {
            if (!match && win.getName().includes(title)) {
                match = win;                        // 命中窗口自己保留，交给调用方 Release
            } else {
                try { win.Release(); } catch (e) {} // 其余窗口立即释放，避免 COM 句柄泄漏
            }
        }
        try { desktop.Release(); } catch (e) {}
        if (match) return match;
        await new Promise(r => setTimeout(r, pollMs));
    }
    throw new Error(`启动后 ${timeoutMs}ms 内未找到标题含 "${title}" 的窗口`);
}

/** 把一步任务的执行结果记录成统一结构 */
function makeStepResult(step, index, ok, detail, elapsedMs) {
    return {
        index,                                  // 步骤序号（从 1 开始）
        action: step.action,                    // 执行的动作
        target: `${step.type}:"${step.name}"`,  // 操作目标（类型:名称）
        note: step.note || '',                  // 任务作者写的备注，原样带回报告
        ok,                                     // 是否成功
        detail: detail || '',                   // 补充信息（读回值/错误原因）
        elapsedMs                               // 本步耗时，用于分析时序问题
    };
}

/** 执行单个步骤；返回结果记录。所有 UIA 调用都在这层兜底，单步异常不炸整个规则 */
async function runStep(wats, appWindow, step, index, vars) {
    const start = Date.now();
    try {
        // 定位元素：在窗口 UIA 树中按"类型+名称"查找；超时未指定则用全局 defaultTimeout
        const loc = wats.locator(appWindow, step.type, step.name, step.timeout);

        switch (step.action) {
            // —— 点击类 ——
            case 'click':     await loc.click(); break;      // 程序级点击（推荐）
            case 'clickInput': await loc.clickInput(); break; // 物理鼠标点击（兜底）
            case 'select':    await loc.select(); break;      // 选中列表项/Tab
            case 'toggle':    await loc.toggle(); break;      // 勾选/取消复选框

            // —— 树节点/下拉框 ——（病例树场景的主力动作）
            case 'expand':    await loc.expand(); break;      // 展开树节点
            case 'collapse':  await loc.collapse(); break;    // 收起树节点

            // —— 输入类 ——
            case 'typeValue':  await loc.typeValue(step.value ?? ''); break; // 直接设值
            case 'pressEnter': await loc.pressEnter(); break;              // 聚焦元素并回车

            // —— 断言/读取类 ——
            case 'exists': {                          // 元素是否存在（带轮询等待）
                const found = await loc.exists();
                if (!found) throw new Error(`超时未找到元素`);
                return makeStepResult(step, index, true, '元素存在', Date.now() - start);
            }
            case 'getValue': {                        // 读输入框的值
                const v = await loc.getValue();
                if (step.saveAs) vars[step.saveAs] = v;   // 存入报告 vars 字段
                return makeStepResult(step, index, true, `读到值: ${v}`, Date.now() - start);
            }
            case 'getText': {                         // 读静态文本
                const t = await loc.getText();
                if (step.saveAs) vars[step.saveAs] = t;
                return makeStepResult(step, index, true, `读到文本: ${t}`, Date.now() - start);
            }

            // —— 全局键盘（不定位元素，直接按键）——
            case 'pressKey':
                if (!step.key) throw new Error(`pressKey 需要 key 字段（如 "F5"/"Enter"/"Tab"）`);
                wats.pressKey(step.key);
                break;

            default:
                throw new Error(`未知 action: "${step.action}"`);
        }
        return makeStepResult(step, index, true, '', Date.now() - start);
    } catch (err) {
        return makeStepResult(step, index, false, err.message || String(err), Date.now() - start);
    }
}

/** 执行一个完整任务：附加/启动窗口 → 逐步执行 → 返回报告对象 */
async function runTask(task, taskName, ctx) {
    const report = {
        task: taskName,
        app: {
            title: task.app && task.app.title,
            mode: '' // mode: attach=附加已有窗口 / launch=新启动
        },
        startedAt: new Date().toISOString(),
        steps: [],
        vars: {},                                     // getValue/getText 用 saveAs 存的读回值
        summary: {
            total: 0,
            passed: 0,
            failed: 0,
            skipped: 0
        }
    };

    // UIA 实例封装了 COM 初始化，一个任务一个实例，用完 close() 释放
    const { WinAutoTS } = await import('win-auto-ts');
    const wats = new WinAutoTS();
    wats.defaultTimeout = task.timeout || 5000;      // 全局元素等待超时（ms）

    let appWindow = null;
    try {
        // ── 1. 定位目标窗口：优先附加已运行窗口（HIS 已登录场景），找不到再启动 ──
        const desktop = wats.getDesktop();            // 桌面根元素，其子元素即各顶层窗口
        console.log('desktop',desktop);
        appWindow = wats.findByName(desktop, task.app.title);
        if (appWindow) {
            report.app.mode = 'attach';
            ctx.logInfo(`[uia] 附加已运行窗口: ${task.app.title}`);
        } else if (task.app.launch) {
            appWindow = await launchAndFindWindow(wats, task.app.launch, task.app.title, task.launchTimeout || 15000);
            report.app.mode = 'launch';
            ctx.logInfo(`[uia] 启动并等待窗口: ${task.app.title}`);
        } else {
            throw new Error(`未找到标题含"${task.app.title}"的窗口，且未配置 launch`);
        }

        if (task.app.maximize) wats.maximizeWindow(appWindow);

        // ── 2. 可选：打印全部元素名（探索控件名称用，输出到控制台日志）──
        if (task.inspect) {
            ctx.logInfo(`[uia] inspect: 打印窗口元素清单到控制台`);
            wats.printControlIdentifiers({ appWindow });
        }

        // ── 3. 顺序执行步骤（单步失败默认终止，可用 continueOnError 放行）──
        const steps = task.steps || [];
        let aborted = false;
        for (let i = 0; i < steps.length; i++) {
            if (aborted) {  // 前面失败后跳过的步骤，也计入报告便于对照
                report.steps.push(makeStepResult(steps[i], i + 1, false, '已跳过（前序步骤失败）', 0));
                report.summary.skipped++;
                continue;
            }
            const step = steps[i];
            ctx.logInfo(`[uia] 步骤${i + 1}/${steps.length}: ${step.action} → ${step.type}:"${step.name}"`);
            const r = await runStep(wats, appWindow, step, i + 1, report.vars);
            report.steps.push(r);
            if (r.ok) report.summary.passed++;
            else {
                report.summary.failed++;
                ctx.logWarn(`[uia] 步骤${i + 1} 失败: ${r.detail}`);
                if (!task.continueOnError) aborted = true;
            }
        }
        report.summary.total = steps.length;
    } catch (err) {
        // 窗口定位/启动阶段的整体失败
        report.error = err.message || String(err);
        ctx.logError(`[uia] 任务 ${taskName} 失败: ${report.error}`);
    } finally {
        // ── 4. 资源释放：COM 元素必须显式释放，否则句柄泄漏 ──
        try { if (appWindow) appWindow.Release(); } catch (e) {}
        try { wats.close(); } catch (e) {}
    }

    report.finishedAt = new Date().toISOString();
    return report;
}

/**
 * 规则主流程（异步生成器，引擎逐批消费 yield 结果并落盘）
 * @param {Array}  inputArray          输入文件快照（节点带 content 字段）
 * @param {Object} outputNodeTemplate  输出节点模板（含输出目录 path）
 * @param {Object} ctx                 规则上下文：refreshInput 拉取最新快照 / 分级日志
 */
async function* writingRules(inputArray, outputNodeTemplate, ctx) {
    // ── 平台守卫：UIA 仅存在于 Windows，其他平台直接退出避免误跑 ──
    if (process.platform !== 'win32') {
        ctx.logWarn('[uia] 当前平台非 Windows，跳过 UIA 自动化');
        return;
    }

    // ── 依赖预检：提前给出可操作的提示，而不是让 import 在任务里莫名报错 ──
    try {
        await import('win-auto-ts');
    } catch (e) {
        ctx.logError('[uia] 缺少依赖 win-auto-ts，请先执行: npm i win-auto-ts');
        return;
    }

    const outputDir = outputNodeTemplate.path;                 // 输出目录绝对路径
    const inputDir = path.join(outputDir, '../inputDir');      // 约定：inputDir 与 outputDir 同级

    // ── 种子逻辑：inputDir 没有 config.json 时先生成演示任务（yield 后引擎自动落盘）──
    let configFile = inputArray.find(item => item.normExt === 'json' && item.name === 'config');
    if (!configFile) {
        ctx.logInfo('[uia] 未发现 config.json 任务文件，生成演示任务 config.json');
        yield [{
            ...outputNodeTemplate,
            path: inputDir,               // 写到 inputDir（模板默认 path 是 outputDir，这里改向）
            fileName: 'config',         // 落盘后即 config.json
            normExt: 'json',
            content: JSON.stringify(DEMO_TASK, null, 2)
        }];
        // yield 落盘是同步完成的，refreshInput 立刻能拿到新文件的快照（拉模型）
        // 注意：refreshInput 只返回新数组，旧变量 configFile 不会自动更新，必须重新查找
        inputArray = ctx.refreshInput();
        configFile = inputArray.find(item => item.normExt === 'json' && item.name === 'config');
        if (!configFile) {
            ctx.logError('[uia] 演示任务已落盘，但刷新输入后仍未找到 config.json');
            return;
        }
    }

    const base = configFile.base
    ctx.logInfo(`[uia] 开始任务: ${base}`);
    try {
        const task = JSON.parse(configFile.content);   // inputNode.content 引擎已按编码读好

        const report = await runTask(task, base, ctx);

        // 报告文件名：config.json → config_report.json（与任务名对应，方便配对查看）
        yield [{
            ...outputNodeTemplate,
            fileName: `${configFile.name}_report`,
            normExt: 'json',
            content: JSON.stringify(report, null, 2)
        }];
        ctx.logInfo(`[uia] 任务 ${base} 完成: 通过 ${report.summary.passed}/${report.summary.total}`);

    } catch (e) {
        ctx.logError(`[uia] ${base} JSON 解析失败: ${e.message}`);
    }
}

module.exports = {
    name: 'uia2auto',
    version: '1.0.0',
    process: writingRules,
    description: 'Windows UIA 自动化操作规则：按 *.uia.json 任务驱动桌面应用（定位元素/模拟点击/输入/展开树节点），产出执行报告',
    rely: {
        'win-auto-ts': '1.0.0'
    }
};
