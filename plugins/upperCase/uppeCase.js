/**
 * 演示插件：upper-case（rule04 的前置依赖）
 * 契约：导出 { name, version, process }；process 即规则侧经 ctx.getPlugin 拿到的处理器。
 * 注意：plugin/ 目录被 gitignore，本文件丢失时可按 rule04 头部注释的片段重建。
 */
module.exports = {
    name: 'upperCase',
    version: '1.0.0',
    /**
     * 文本转大写
     * @param {string} text - 规则传入的文本内容
     * @returns {string} 转换后的文本
     */
    process(text) {
        return String(text).toUpperCase();
    }
};
