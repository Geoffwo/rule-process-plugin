/**
 * file2html 规则
 * 将输入的文件数组拼接成树结构，输出可展开/收缩的 HTML 文件
 */

function writingRules(inputArray, outputNodeTemplate) {
    console.log('inputArray=>', inputArray);

    if (!Array.isArray(inputArray) || inputArray.length === 0) {
        return [{
            ...outputNodeTemplate,
            fileName: 'fileTree',
            normExt: 'html',
            content: '<!DOCTYPE html><html><body><h3>输入数组为空</h3></body></html>'
        }];
    }

    // 构建树结构
    const tree = buildTree(inputArray);

    // 生成 HTML 内容
    const html = renderHTML(tree, inputArray);

    return [{
        ...outputNodeTemplate,
        fileName: 'fileTree',
        normExt: 'html',
        content: html
    }];
}

/**
 * 将扁平的 inputArray 转为树形结构
 * 自动计算所有文件路径的最长公共前缀作为根节点，避免目录节点把前缀拉低产生冗余上层
 */
function buildTree(nodes) {
    // 收集所有有效路径的分段
    const validNodes = nodes.filter(n => n && typeof n.path === 'string' && n.path.trim());
    if (validNodes.length === 0) {
        return { name: 'root', path: '', isDirectory: true, children: new Map(), node: null };
    }

    // 关键：只用文件节点（路径最深）计算公共前缀，
    // 目录节点路径较短会拉低前缀长度，导致出现冗余的中间目录层
    const prefixSource = validNodes.filter(n => !n.isDirectory);
    const sourceNodes = prefixSource.length > 0 ? prefixSource : validNodes;

    const allParts = sourceNodes.map(n => n.path.split(/[/\\]/).filter(Boolean));

    // 计算所有路径的最长公共前缀
    const first = allParts[0];
    let prefixLen = 0;
    for (let i = 0; i < first.length; i++) {
        const seg = first[i];
        if (allParts.every(parts => parts[i] === seg)) {
            prefixLen = i + 1;
        } else {
            break;
        }
    }

    // 单文件回退：若唯一文件，根取其父目录，避免根就是文件本身
    if (sourceNodes.length === 1 && !sourceNodes[0].isDirectory) {
        prefixLen = Math.max(1, prefixLen - 1);
    }

    const prefixParts = first.slice(0, prefixLen);
    const prefixPath = prefixParts.join('/');

    // 根节点 = 公共前缀（取最后一段作为显示名）
    const root = {
        name: prefixParts.length ? prefixParts[prefixParts.length - 1] : 'root',
        path: prefixPath,
        isDirectory: true,
        children: new Map(),
        node: null,
        isRoot: true
    };

    // 把每个节点挂到根下（按相对前缀的剩余路径分层）
    for (const node of validNodes) {
        const parts = node.path.split(/[/\\]/).filter(Boolean);
        const relParts = parts.slice(prefixLen);

        // 节点本身就是根
        if (relParts.length === 0) {
            root.node = node;
            root.isDirectory = !!node.isDirectory;
            continue;
        }

        let current = root;
        for (let i = 0; i < relParts.length; i++) {
            const part = relParts[i];
            const isLast = i === relParts.length - 1;
            const currentPath = [...prefixParts, ...relParts.slice(0, i + 1)].join('/');

            if (!current.children.has(part)) {
                current.children.set(part, {
                    name: part,
                    path: currentPath,
                    isDirectory: isLast ? !!node.isDirectory : true,
                    children: new Map(),
                    node: isLast ? node : null
                });
            } else if (isLast && node) {
                const existing = current.children.get(part);
                existing.node = node;
                existing.isDirectory = !!node.isDirectory;
            }
            current = current.children.get(part);
        }
    }

    return root;
}

/**
 * 渲染根节点本身 + 其子树（根节点作为一个可展开的顶层项显示）
 */
function treeToHTML(root) {
    const hasChildren = root.children.size > 0;
    const icon = root.isDirectory ? '📁' : getFileIcon(root.name);
    const escapedName = escapeHTML(root.name);
    const escapedPath = escapeHTML(root.path);

    let html = '<ul class="tree root">';
    html += `<li class="dir"${hasChildren ? '' : ' data-leaf="1"'}>`;
    html += `<span class="row"${hasChildren ? ' onclick="toggleNode(this)"' : ''}>`;
    html += `<span class="toggle">${hasChildren ? '▼' : '·'}</span>`;
    html += `<span class="icon">${icon}</span>`;
    html += `<span class="name" title="${escapedPath}">${escapedName}</span>`;
    html += `</span>`;
    if (hasChildren) {
        html += childrenToHTML(root);
    }
    html += '</li>';
    html += '</ul>';
    return html;
}

/**
 * 递归渲染子节点列表
 */
function childrenToHTML(node) {
    const children = Array.from(node.children.values());
    if (children.length === 0) return '';

    // 排序：目录在前，文件在后；同类按名称排序
    children.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
    });

    let html = '<ul class="tree">';
    for (const child of children) {
        const hasChildren = child.children.size > 0;
        const icon = child.isDirectory ? (hasChildren ? '📁' : '📂') : getFileIcon(child.name);
        const sizeText = (child.node && child.node.size != null && !child.isDirectory)
            ? `<span class="size">${formatSize(child.node.size)}</span>`
            : '';
        const escapedName = escapeHTML(child.name);
        const escapedPath = escapeHTML(child.path);

        html += `<li class="${child.isDirectory ? 'dir' : 'file'}"${hasChildren ? '' : ' data-leaf="1"'}>`;
        html += `<span class="row"${hasChildren ? ' onclick="toggleNode(this)"' : ''}>`;
        html += `<span class="toggle">${hasChildren ? '▼' : '·'}</span>`;
        html += `<span class="icon">${icon}</span>`;
        html += `<span class="name" title="${escapedPath}">${escapedName}</span>`;
        html += sizeText;
        html += `</span>`;
        if (hasChildren) {
            html += childrenToHTML(child);
        }
        html += '</li>';
    }
    html += '</ul>';
    return html;
}

function getFileIcon(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    const map = {
        js: '📜', ts: '📜', json: '📋', md: '📝', txt: '📄',
        html: '🌐', css: '🎨', png: '🖼️', jpg: '🖼️', jpeg: '🖼️',
        gif: '🖼️', sql: '🗄️', xml: '📦', yml: '⚙️', yaml: '⚙️',
        ini: '⚙️', log: '🗒️', bat: '⚙️', sh: '⚙️'
    };
    return map[ext] || '📄';
}

function formatSize(bytes) {
    if (!bytes || bytes <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let size = bytes;
    while (size >= 1024 && i < units.length - 1) {
        size /= 1024;
        i++;
    }
    return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function escapeHTML(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderHTML(tree, inputArray) {
    const stats = {
        total: inputArray.length,
        files: inputArray.filter(n => n && !n.isDirectory).length,
        dirs: inputArray.filter(n => n && n.isDirectory).length
    };

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>文件树结构</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
    background: #f5f7fa;
    color: #2c3e50;
    margin: 0;
    padding: 24px;
  }
  .container {
    max-width: 960px;
    margin: 0 auto;
    background: #fff;
    border-radius: 8px;
    box-shadow: 0 2px 12px rgba(0,0,0,.08);
    padding: 24px 28px;
  }
  h1 {
    font-size: 18px;
    border-bottom: 2px solid #409eff;
    padding-bottom: 10px;
    margin: 0 0 12px 0;
    color: #1f2d3d;
  }
  .stats { color: #888; font-size: 13px; margin-bottom: 14px; }
  .stats span { margin-right: 18px; }
  .toolbar { margin-bottom: 14px; }
  .toolbar button {
    background: #409eff;
    color: #fff;
    border: none;
    padding: 6px 14px;
    border-radius: 4px;
    cursor: pointer;
    margin-right: 8px;
    font-size: 13px;
    transition: background .2s;
  }
  .toolbar button:hover { background: #66b1ff; }
  ul.tree {
    list-style: none;
    padding-left: 20px;
    margin: 0;
    border-left: 1px dashed #e0e0e0;
  }
  ul.tree.root { padding-left: 0; border-left: none; }
  li { line-height: 1.9; font-size: 14px; }
  .row {
    display: inline-flex;
    align-items: center;
    cursor: default;
    padding: 1px 4px;
    border-radius: 3px;
  }
  li.dir > .row { cursor: pointer; }
  li.dir > .row:hover { background: #f0f7ff; }
  .toggle {
    display: inline-block;
    width: 16px;
    text-align: center;
    color: #999;
    user-select: none;
    font-size: 11px;
  }
  .icon { margin-right: 6px; }
  .name { color: #2c3e50; }
  .dir > .row > .name { font-weight: 600; color: #1f2d3d; }
  .size { color: #aaa; font-size: 12px; margin-left: 10px; }
  li.collapsed > ul { display: none; }
</style>
</head>
<body>
<div class="container">
  <h1>文件树结构</h1>
  <div class="stats">
    <span>总计: ${stats.total}</span>
    <span>文件: ${stats.files}</span>
    <span>目录: ${stats.dirs}</span>
  </div>
  <div class="toolbar">
    <button onclick="expandAll()">全部展开</button>
    <button onclick="collapseAll()">全部收缩</button>
  </div>
  <div id="tree-container">
    ${treeToHTML(tree)}
  </div>
</div>
<script>
  function toggleNode(el) {
    const li = el.parentElement;
    const collapsed = li.classList.toggle('collapsed');
    const toggle = el.querySelector('.toggle');
    if (toggle) toggle.textContent = collapsed ? '▶' : '▼';
  }
  function expandAll() {
    document.querySelectorAll('li.collapsed').forEach(li => {
      li.classList.remove('collapsed');
      const toggle = li.querySelector(':scope > .row > .toggle');
      if (toggle) toggle.textContent = '▼';
    });
  }
  function collapseAll() {
    // 根节点本身保持展开，只收缩其下属的所有有子节点的 li
    const rootLi = document.querySelector('ul.tree.root > li');
    if (!rootLi) return;
    rootLi.querySelectorAll('li').forEach(li => {
      if (li.querySelector(':scope > ul')) {
        li.classList.add('collapsed');
        const toggle = li.querySelector(':scope > .row > .toggle');
        if (toggle) toggle.textContent = '▶';
      }
    });
  }
</script>
</body>
</html>`;
}

module.exports = {
    name: 'file2html',
    version: '1.0.0',
    process: writingRules,
    mode: 'stream', // 声明为流式模式
    description: '将输入的文件数组拼接成树结构，输出可展开/收缩的 HTML 文件',
    notes: {
        node: '18.20.4'
    },
    input: {
        normExt: '文件数组',
        format: '[{name, path, isDirectory, size}]'
    },
    output: {
        normExt: 'html',
        format: '可展开/收缩的文件树结构 HTML 文件'
    }
};
