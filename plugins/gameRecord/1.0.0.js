// 键鼠操作录制规则插件
// 通过 uiohook-napi 捕获全局键鼠事件，按 ESC 停止录制并输出标准 workflow 配置
const { uIOhook, UiohookKey } = require('uiohook-napi');
const { execSync } = require('child_process');

// ========== 默认参数 ==========
const DEFAULTS = {
    keyHoldThreshold: 150,      // 按键按下超过150ms判定为长按
    maxWaitMs: 30000,           // 两次操作间隔最长30秒，超过截断
    doubleClickInterval: 300,   // 300ms内连续两次点击判定为双击
    minWaitMs: 50,              // 间隔小于50ms忽略，不生成wait步骤
};

// ========== 高DPI缩放 ==========
function getScreenScaleFactor() {
    try {
        if (process.platform === 'win32') {
            const regVal = execSync(
                `reg query "HKCU\\Control Panel\\Desktop\\WindowMetrics" /v AppliedDPI`,
                { encoding: 'utf8', windowsHide: true }
            );
            const hexMatch = regVal.match(/0x([0-9a-fA-F]+)/);
            if (hexMatch) {
                const dpi = parseInt(hexMatch[1], 16);
                return Number((dpi / 96).toFixed(2));
            }
        }
        return 1;
    } catch { return 1; }
}

// ========== 按键名映射 ==========
const keyNames = {};
Object.entries(UiohookKey).forEach(([name, code]) => {
    if (typeof code !== 'number') return;
    const lowerName = name.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
    keyNames[code] = lowerName;
});

function getKeyName(keycode) {
    return keyNames[keycode] || `key${keycode}`;
}

function getMouseBtn(code) {
    if (code === 1) return 'left';
    if (code === 2) return 'right';
    return 'middle';
}

// ====================== 通用工具函数层 ======================
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ========== 事件 → workflow 转换（纯函数） ==========
function convertEventsToWorkflow(events, screenScale, config) {
    const workflow = [];
    const positions = {};
    let posCounter = 0;
    let lastTime = events[0];

    function addWait(delay) {
        if (delay > config.minWaitMs) {
            workflow.push({ type: 'wait', delay: Math.min(delay, config.maxWaitMs) });
        }
    }

    const pendingKeys = new Map();
    const pendingMouse = new Map();
    let lastClickInfo = null;

    for (const ev of events) {
        const gap = ev.time - lastTime.time;
        addWait(gap);
        lastTime = ev;

        if (ev.type === 'keydown') {
            if (!pendingKeys.has(ev.keycode)) {
                pendingKeys.set(ev.keycode, { startTime: ev.time });
            }
        } else if (ev.type === 'keyup') {
            const pending = pendingKeys.get(ev.keycode);
            if (!pending) {
                workflow.push({ type: 'keyTap', value: getKeyName(ev.keycode) });
                continue;
            }
            const holdMs = ev.time - pending.startTime;
            const keyName = getKeyName(ev.keycode);
            if (holdMs > config.keyHoldThreshold) {
                workflow.push({ type: 'keyHold', value: keyName, delay: holdMs });
            } else {
                workflow.push({ type: 'keyTap', value: keyName });
            }
            pendingKeys.delete(ev.keycode);
        } else if (ev.type === 'mousedown') {
            if (!pendingMouse.has(ev.button)) {
                pendingMouse.set(ev.button, { downEv: ev, start: ev.time });
            }
        } else if (ev.type === 'mouseup') {
            const pending = pendingMouse.get(ev.button);
            if (!pending) continue;

            // 双击检测
            const now = ev.time;
            let isDouble = false;
            if (lastClickInfo && lastClickInfo.btn === ev.button && (now - lastClickInfo.time) < config.doubleClickInterval) {
                isDouble = true;
            }
            lastClickInfo = { btn: ev.button, time: now };

            const x = Math.round(pending.downEv.x / screenScale);
            const y = Math.round(pending.downEv.y / screenScale);
            const btn = getMouseBtn(pending.downEv.button);
            const posId = `click_${++posCounter}`;
            positions[posId] = { x, y };

            workflow.push({
                type: 'click',
                displace: posId,
                button: btn,
                double: isDouble,
                delay: 200
            });
            pendingMouse.delete(ev.button);
        }
    }

    // 兜底：录制结束未松开的按键
    if (pendingKeys.size > 0) {
        console.log(`[auto-recorder] 存在${pendingKeys.size}个按键录制结束未松开，自动转为keyTap`);
        for (const kc of pendingKeys.keys()) {
            workflow.push({ type: 'keyTap', value: getKeyName(kc) });
        }
    }

    return {
        loop:1,
        globals: {
            initialWait: 10000,
            stepDelay: 200,
            clickDelay: 300,
            typeCharDelay: 180,
            matchThreshold: 0.65,
            debugMode: false
        },
        positions,
        workflow
    };
}

// ========== 规则入口 ==========
async function writingRules(inputArray, outputNodeTemplate) {
    const screenScale = getScreenScaleFactor();
    console.log(`[auto-recorder] 屏幕缩放比: ${screenScale}`);

    // 录制状态
    const events = [];
    let isStopping = false;

    // 2. 初始等待（让用户切换到目标页面）
    const initialWait = 10000;
    console.log(`等待 ${initialWait / 1000} 秒，请切换到目标页面...`);
    await sleep(initialWait);

    // 返回 Promise，ESC 或 SIGINT 时 resolve
    return new Promise((resolve, reject) => {
        // 录制事件回调
        function onKeydown(e) {
            // ESC 停止录制
            if (e.keycode === UiohookKey.Escape || e.keycode === 1 || e.keycode === 27) {
                stopAndResolve();
                return;
            }
            events.push({ type: 'keydown', time: Date.now(), keycode: e.keycode });
            const name = getKeyName(e.keycode);
            console.log(`[auto-recorder] ⌨️  KEY_DOWN  ${name} (${e.keycode})`);
        }

        function onKeyup(e) {
            events.push({ type: 'keyup', time: Date.now(), keycode: e.keycode });
            const name = getKeyName(e.keycode);
            console.log(`[auto-recorder] ⌨️  KEY_UP    ${name} (${e.keycode})`);
        }

        function onMousedown(e) {
            events.push({ type: 'mousedown', time: Date.now(), x: e.x, y: e.y, button: e.button });
            const logic = { x: Math.round(e.x / screenScale), y: Math.round(e.y / screenScale) };
            console.log(`[auto-recorder] 🖱️  MOUSE_DOWN ${getMouseBtn(e.button)} 逻辑坐标(${logic.x},${logic.y})`);
        }

        function onMouseup(e) {
            events.push({ type: 'mouseup', time: Date.now(), x: e.x, y: e.y, button: e.button });
            const logic = { x: Math.round(e.x / screenScale), y: Math.round(e.y / screenScale) };
            console.log(`[auto-recorder] 🖱️  MOUSE_UP   ${getMouseBtn(e.button)} 逻辑坐标(${logic.x},${logic.y})`);
        }

        // 停止录制并返回结果
        function stopAndResolve() {
            if (isStopping) return;
            isStopping = true;
            console.log('\n[auto-recorder] 停止录制，正在解析操作事件...');
            uIOhook.stop();

            // 清理监听器，防止内存泄漏
            uIOhook.off('keydown', onKeydown);
            uIOhook.off('keyup', onKeyup);
            uIOhook.off('mousedown', onMousedown);
            uIOhook.off('mouseup', onMouseup);

            if (events.length === 0) {
                console.log('[auto-recorder] 未捕获任何键鼠操作');
                resolve([{
                    ...outputNodeTemplate,
                    fileName: `record_${Date.now()}`,
                    content: '[auto-recorder] 未捕获任何键鼠操作'
                }]);
                return;
            }

            console.log(`[auto-recorder] 原始捕获事件总数：${events.length}`);
            const outputConfig = convertEventsToWorkflow(events, screenScale, DEFAULTS);

            resolve([{
                ...outputNodeTemplate,
                fileName: `config`,
                normExt: 'json',
                content: JSON.stringify(outputConfig, null, 2)
            }]);
        }

        // Ctrl+C 兜底保存
        function onSigint() {
            console.log('\n[auto-recorder] 收到终止信号，保存录制文件');
            stopAndResolve();
        }
        process.once('SIGINT', onSigint);

        // 注册监听
        uIOhook.on('keydown', onKeydown);
        uIOhook.on('keyup', onKeyup);
        uIOhook.on('mousedown', onMousedown);
        uIOhook.on('mouseup', onMouseup);

        // 启动钩子
        try {
            uIOhook.start();
        } catch (err) {
            console.error('[auto-recorder] 钩子启动失败：', err.message);
            reject(new Error('钩子启动失败，可能被杀毒/反作弊拦截'));
            return;
        }

        console.log(`
========================================
  [auto-recorder] 键鼠录制器已启动
  按 ESC 停止录制并生成配置JSON
========================================
`);
    });
}

module.exports = {
    name: 'auto-recorder',
    version: '1.0.0',
    process: writingRules,
    description: '键鼠操作录制器，按ESC停止并生成自动化workflow配置',
    notes: {
        node: '18.20.4',
        tips: [
            '1. 键盘/鼠标录制，支持点击，键盘长按，键盘敲击',
            '2. 将生成的config.json配置到inputDir目录下，配合gamePlay使用'
        ]
    },
    input: {
        normExt: [],
    },
    output: {
        normExt: ['json']
    },
    rely: {
        'uiohook-napi': '^0.3.0'
    },
};
