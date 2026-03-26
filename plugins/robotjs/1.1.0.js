const robot = require('robotjs');

/**
 * 坐标记录工具（极简版）
 * @param {Array} inputArray - 输入数组（未使用）
 * @param {Object} outputNodeTemplate - 输出节点模板
 * @returns {Promise<Array>} 返回包含结果的数组（适配全量模式）
 */
async function writingRules(inputArray, outputNodeTemplate) {
    console.log('=========================================');
    console.log('🚀 鼠标坐标获取器（移动鼠标查看实时坐标）');
    console.log('按 Ctrl + C 退出');
    console.log('=========================================\n');

    // 每秒刷新一次坐标
    setInterval(() => {
        const mouse = robot.getMousePos();
        console.log(`当前鼠标坐标：x = ${mouse.x}, y = ${mouse.y}`)
    }, 1000);
}

module.exports = {
    name: 'robotjs',
    version: '1.1.0',
    process: writingRules,
    description: '极简版坐标记录工具-仅用于记录坐标',
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