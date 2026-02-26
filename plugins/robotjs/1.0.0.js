const robot = require('robotjs');
const readline = require('readline');

/**
 * 坐标记录工具（极简版）
 * @param {Array} inputArray - 输入数组（未使用）
 * @param {Object} outputNodeTemplate - 输出节点模板
 * @returns {Promise<Array>} 返回包含结果的数组（适配全量模式）
 */
async function writingRules(inputArray, outputNodeTemplate) {
    // 基础配置：开启按键监听和原始模式
    readline.emitKeypressEvents(process.stdin);
    //判断当前程序是否运行在终端环境中 true：程序运行在终端
    const isTTY = process.stdin.isTTY;
    //setRawMode(true) 按 F3/F4 时，不需要按回车，按键会立即被 keypress 事件捕获；按 F3 不会在终端显示 “f3”，避免干扰界面；
    if (isTTY) process.stdin.setRawMode(true);

    // 简洁的操作提示
    console.log('===== 坐标记录工具 =====');
    console.log('操作：F3 记录坐标（可输入名称） | F4 导出退出\n');

    const content = [];
    // 创建极简的readline接口（仅用于读取名称输入）
    const rl = readline.createInterface({input: process.stdin, output: process.stdout});

    // 核心：返回Promise等待F4触发
    return new Promise((resolve) => {
        // 按键处理函数
        const handleKeypress = (str, key) => {
            // 1. 按F3记录坐标
            if (key.name === 'f3') {
                // 获取坐标和时间（核心数据）
                const {x, y} = robot.getMousePos();
                const time = new Date().toLocaleTimeString();

                // 临时恢复终端输入模式，让用户输入名称
                // 恢复默认输入模式，用户可以正常打字、按回车确认名称；
                if (isTTY) process.stdin.setRawMode(false);

                // 简单提问：输入名称（直接回车则为空）
                rl.question(`[${time}] 坐标(X:${x}, Y:${y})，请输入名称（回车跳过）：`, (name) => {
                    // 记录数据（名称去空格，无输入则为空字符串）
                    content.push({
                        name: name.trim() || '',
                        time,
                        X: x,
                        Y: y
                    });
                    console.log(`✅ 已记录：${name.trim() || '（未命名）'}\n`);

                    // 恢复原始模式，继续监听快捷键
                    if (isTTY) process.stdin.setRawMode(true);
                });
            }

            // 2. 按F4导出并退出
            if (key.name === 'f4') {
                console.log('\n📤 正在导出记录结果...');
                // 清理资源（极简版）
                rl.close();
                if (isTTY) process.stdin.setRawMode(false);
                process.stdin.removeAllListeners();
                process.stdin.destroy();

                // 全量返回结果
                resolve([{
                    ...outputNodeTemplate,
                    fileName: 'result',
                    normExt: 'json',
                    content: JSON.stringify(content, null, 2)
                }]);
            }
        };

        // 绑定按键监听
        process.stdin.on('keypress', handleKeypress);
    });
}

module.exports = {
    name: 'robotjs',
    version: '1.0.0',
    process: writingRules,
    description: '极简版坐标记录工具',
    notes: {
        node: '18.20.4'
    },
    input: {
        normExt: ''
    },
    output: {
        normExt: 'json文件'
    },
    rely: {
        'robotjs': '0.6.0'
    }
};