const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

/**
 */
async function writingRules(inputArray, outputNodeTemplate) {
    const outputPath = outputNodeTemplate.path;
    const inputPath = path.join(outputPath, '../inputDir');
    // 1. 过滤出需要合并的文件（默认只处理DOCX，可扩展其他文本类文件）
    const htmlFiles = inputArray.filter(item =>
        item.normExt === 'html'
    );

    // 2. 校验输入
    if (htmlFiles.length === 0) {
        const errorMsg = '错误：未找到html文件';
        const sourceHtml = generateSourceHtml()
        return [
            { ...outputNodeTemplate, path:inputPath,fileName:'source',normExt:'html',content: sourceHtml },
            { ...outputNodeTemplate, content: errorMsg }
        ];
    }

    const result = []

    htmlFiles.forEach(htmlFile=>{
        const jsResult = convertHtmlToJs(htmlFile);
        result.push({
            ...outputNodeTemplate,
            fileName:htmlFile.name,
            normExt:'js',
            content: jsResult
        })

        const testHtml = generateTestHtml(htmlFile.name)
        result.push({
            ...outputNodeTemplate,
            fileName:`test-${htmlFile.name}`,
            normExt:'html',
            content: testHtml
        })
    })

    return result;
}

function generateSourceHtml(){
    return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>支持外部资源的测试页面</title>
    <!-- 内联CSS -->
    <style>
        #content {
            font-size: 18px;
            margin-top: 20px;
        }

        .card {
            width: 400px;
            margin: 50px auto;
            padding: 20px;
            border: 1px solid #e0e0e0;
            border-radius: 8px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        }
        #toggleBtn {
            padding: 10px 20px;
            background: #007bff;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
        }
    </style>
</head>
<body>
<div class="card">
    <button id="toggleBtn">点击切换</button>
    <div id="content">初始内容</div>
</div>

<!-- 内联JS -->
<script>
    // 补充交互逻辑
    document.getElementById('toggleBtn').addEventListener('click', () => {
    const content = document.getElementById('content');
    content.textContent = content.textContent === '初始内容'
        ? '外部JS触发的内容'
        : '初始内容';
    });
</script>
</body>
</html>
    `
}

function generateTestHtml(jsName){
    return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>纯JS生成的页面</title>
</head>
<body>
<script src="${jsName}.js"></script>
</body>
</html>
    `
}

/**
 * HTML转纯JS（支持外部CSS/JS引入）
 */
function convertHtmlToJs(htmlFile){
    // 1. 读取并解析HTML
    const htmlContent = htmlFile.content;
    const inputHtmlPath = htmlFile.path
    const $ = cheerio.load(htmlContent);

    // 2. 提取并整合所有CSS（内联style + 外部link）
    let totalCssContent = '';

    // 2.1 处理内联<style>标签
    $('style').each((_, styleEl) => {
        const $style = $(styleEl);
        const inlineCss = $style.html() || '';
        totalCssContent += inlineCss + '\n';
    });

    // 2.2 处理外部<link rel="stylesheet">标签
    $('link').each((_, linkEl) => {
        const $link = $(linkEl);
        // 只处理样式表链接
        if ($link.attr('rel') === 'stylesheet' && $link.attr('href')) {
            const href = $link.attr('href').trim();
            const cssAbsPath = resolveResourcePath(inputHtmlPath, href);
            const externalCss = readExternalFile(cssAbsPath, 'CSS');
            totalCssContent += externalCss + '\n';
        }
    });

    // 3. 提取并整合所有JS（内联script + 外部script[src]）
    let totalJsContent = '';

    // 3.1 处理外部<script src="">标签
    $('script').each((_, scriptEl) => {
        const $script = $(scriptEl);
        const src = $script.attr('src');
        if (src) {
            // 外部JS：读取内容并整合
            const jsAbsPath = resolveResourcePath(inputHtmlPath, src);
            const externalJs = readExternalFile(jsAbsPath, 'JS');
            totalJsContent += externalJs + '\n\n';
        } else {
            // 内联JS：提取内容
            const inlineJs = $script.html() || '';
            if (inlineJs) {
                totalJsContent += inlineJs + '\n\n';
            }
        }
    });

    // 4. 生成DOM创建代码（仅保留body内的有效元素）
    const bodyChildren = $('body').children();
    if (bodyChildren.length === 0) {
        throw new Error('HTML的body标签内无有效DOM内容');
    }

    const varNameMap = new Map();
    let domCreateCode = '';
    let rootVarNames = [];

    bodyChildren.each((_, child) => {
        const childJs = convertElementToJS($, child, varNameMap);
        if (childJs) {
            domCreateCode += childJs;
            rootVarNames.push(generateUniqueVarName(child, varNameMap));
        }
    });

    // 5. 生成挂载根元素的代码
    const mountCode = rootVarNames.map(varName =>
        `  document.body.appendChild(${varName});`
    ).join('\n');

    // 6. 转义CSS特殊字符，拼接最终JS代码
    const escapedCss = escapeSpecialChars(totalCssContent);
    // 清理JS空行，避免冗余
    const cleanedJs = totalJsContent.trim() || '// 无JS逻辑';

    const finalJsCode = `
/**
 * 自动生成的纯JS页面（整合内联+外部CSS/JS）
 * 依赖：无（原生JS，可直接在浏览器运行）
 */
(function initDynamicPage() {
  'use strict';

  // === 步骤1：注入所有CSS（内联+外部） ===
  const styleElement = document.createElement('style');
  styleElement.type = 'text/css';
  styleElement.textContent = \`${escapedCss}\`;
  document.head.appendChild(styleElement);

  // === 步骤2：动态创建DOM结构 ===
${domCreateCode}

  // === 步骤3：挂载根元素到body ===
${mountCode}

  // === 步骤4：执行所有JS（内联+外部） ===
  ${cleanedJs}

})();
    `.trim();

    return finalJsCode;
}

/**
 * 解析外部资源的绝对路径（基于HTML文件目录）
 * @param {string} htmlFilePath - HTML文件路径
 * @param {string} resourcePath - 资源的相对/绝对路径
 * @returns {string} 资源的绝对路径
 */
function resolveResourcePath(htmlFilePath, resourcePath) {
    // 如果是绝对路径，直接返回
    if (path.isAbsolute(resourcePath)) {
        return resourcePath;
    }
    // 相对路径：基于HTML文件所在目录解析
    const htmlDir = path.dirname(htmlFilePath);
    return path.resolve(htmlDir, resourcePath);
}

/**
 * 读取外部文件内容（CSS/JS）
 * @param {string} filePath - 文件绝对路径
 * @param {string} type - 文件类型（css/js），用于报错提示
 * @returns {string} 文件内容
 */
function readExternalFile(filePath, type) {
    try {
        if (!fs.existsSync(filePath)) {
            throw new Error(`外部${type}文件不存在：${filePath}`);
        }
        return fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        throw new Error(`读取外部${type}文件失败【${filePath}】：${error.message}`);
    }
}

/**
 * 生成DOM的唯一变量名（避免重复，缓存已生成的变量名）
 * @param {Object} element - cheerio元素对象
 * @param {Map} varNameMap - 变量名缓存映射（避免重复）
 * @returns {string} 唯一变量名
 */
function generateUniqueVarName(element, varNameMap) {
    if (varNameMap.has(element)) {
        return varNameMap.get(element);
    }

    let varName;
    if (element.attribs && element.attribs.id) {
        varName = `el_${element.attribs.id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
    } else {
        varName = `el_${Math.random().toString(36).slice(2, 10)}`;
    }

    varNameMap.set(element, varName);
    return varName;
}

/**
 * 转义特殊字符（防止生成的JS语法错误）
 * @param {string} str - 待转义字符串
 * @returns {string} 转义后的字符串
 */
function escapeSpecialChars(str) {
    return str
        .replace(/'/g, "\\'") // 转义单引号
        .replace(/`/g, '\\`') // 转义反引号
        .replace(/\n/g, '\\n') // 转义换行
        .replace(/\r/g, '\\r'); // 转义回车
}

/**
 * 递归转换HTML元素为JS创建DOM的代码
 * @param {Function} $ - cheerio解析后的$对象
 * @param {Object} element - cheerio DOM元素
 * @param {Map} varNameMap - 变量名缓存映射
 * @param indent - 缩进
 * @returns {string} JS代码片段
 */
function convertElementToJS($, element, varNameMap,indent=`  `) {
    const tagName = element.tagName.toLowerCase();

    // 过滤无需生成的标签：link(样式)、script(外部/内联)、style(内联样式)
    if (['link', 'script', 'style'].includes(tagName)) {
        return '';
    }

    const $el = $(element);
    const attrs = $el.attr() || {};
    const elVarName = generateUniqueVarName(element, varNameMap);

    // 1. 创建元素的基础代码
    let jsCode = `${indent}const ${elVarName} = document.createElement('${tagName}');\n`;

    // 2. 处理元素属性（class -> className）
    Object.entries(attrs).forEach(([key, value]) => {
        if (!value) return;
        const attrKey = key === 'class' ? 'className' : key;
        const escapedValue = escapeSpecialChars(value);
        jsCode += `${indent}${elVarName}.${attrKey} = '${escapedValue}';\n`;
    });

    // 3. 处理文本内容（仅当无嵌套子元素时）
    const textContent = $el.text().trim();
    if ($el.children().length === 0 && textContent) {
        const escapedText = escapeSpecialChars(textContent);
        jsCode += `${indent}${elVarName}.textContent = '${escapedText}';\n`;
    }

    // 4. 递归处理子元素
    $el.children().each((_, child) => {
        const childIndent = indent+'  '
        const childJs = convertElementToJS($, child, varNameMap,childIndent);
        if (!childJs) return;
        const childVarName = generateUniqueVarName(child, varNameMap);
        jsCode += childJs;
        jsCode += `${indent}${elVarName}.appendChild(${childVarName});\n`;
        jsCode += `\n`;
    });

    return jsCode;
}

// 插件导出
module.exports = {
    name: 'html2js', // 插件名称：HTML转JS转换器
    version: '1.0.0',
    process: writingRules, // 核心处理函数
    description: 'HTML文件转纯JS动态生成页面插件，支持整合内联/外部CSS、内联/外部JS，生成可独立运行的纯JS文件（无需依赖外部资源），同时生成配套测试HTML文件用于验证转换效果',
    notes: {
        node: '18.20.4', // 兼容的Node.js版本
    },
    input: {
        normExt: 'html', // 支持的输入文件格式
        format: 'HTML文件内容'
    },
    output: {
        normExt: ['js', 'html'], // 输出文件格式（JS为核心，HTML为测试载体）
        format: `
            1. JS文件：整合HTML内的所有CSS（内联+外部）、JS（内联+外部），通过原生JS动态生成DOM结构，可独立运行；
            2. HTML文件：
               - 无输入HTML时：生成带错误提示的基础HTML；
               - 有输入HTML时：生成配套测试HTML（仅引入转换后的JS文件，用于验证效果）
        `
    },
    rely: {
        'cheerio': '1.0.0-rc.12' // 强制依赖版本（确保解析兼容性）
    }
};