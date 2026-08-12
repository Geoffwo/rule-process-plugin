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

        html += `<li class="${child.isDirectory ? 'dir' : 'file'}" data-name="${escapedName}" data-path="${escapedPath}"${hasChildren ? '' : ' data-leaf="1"'}>`;
        html += `<span class="row"${hasChildren ? ' onclick="toggleNode(this)"' : ''}>`;
        html += `<span class="toggle">${hasChildren ? '▼' : '·'}</span>`;
        html += `<span class="icon">${icon}</span>`;

        if (child.isDirectory) {
            // 目录：普通文本
            html += `<span class="name" title="${escapedPath}">${escapedName}</span>`;
        } else {
            // 文件：渲染为可点击链接（file:// 协议），新标签打开
            const fileUrl = pathToFileUrl(child.path);
            html += `<a class="name file-link" href="${fileUrl}" target="_blank" `;
            html += `title="点击打开: ${escapedPath}" `;
            html += `onclick="event.stopPropagation(); onFileClick(event, this)" `;
            html += `data-path="${escapedPath}">${escapedName}</a>`;
            // 复制路径按钮（兜底：浏览器拦截 file:// 时使用）
            html += `<button class="copy-btn" title="复制路径" onclick="event.stopPropagation(); copyPath(this)" data-path="${escapedPath}">📋</button>`;
        }

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

/**
 * 将本地路径转换为 file:// URL
 * Windows: D:\foo\bar.txt -> file:///D:/foo/bar.txt
 * Unix:    /foo/bar.txt    -> file:///foo/bar.txt
 * 分段编码，保留 / 分隔符
 */
function pathToFileUrl(p) {
    if (!p) return '#';
    const normalized = p.replace(/\\/g, '/');
    const isWindows = /^[A-Za-z]:/.test(normalized);
    const body = isWindows ? normalized : normalized.replace(/^\//, '');
    const encoded = body.split('/').map(seg => encodeURIComponent(seg)).join('/');
    return isWindows ? 'file:///' + encoded : 'file:///' + encoded;
}

function renderHTML(tree, inputArray) {
    const stats = {
        total: inputArray.length,
        files: inputArray.filter(n => n && !n.isDirectory).length,
        dirs: inputArray.filter(n => n && n.isDirectory).length
    };

    // 提取所有文件节点（不含目录）的元信息，供前端复制使用
    const filesData = inputArray
        .filter(n => n && !n.isDirectory && typeof n.path === 'string' && n.path.trim())
        .map(n => ({
            name: n.name || (n.path.split(/[/\\]/).pop() || ''),
            path: n.path,
            ext: n.normExt || (n.ext || '').replace(/^\./, '').toLowerCase(),
            size: n.size != null ? n.size : 0,
            sizeText: formatSize(n.size || 0)
        }));

    const filesDataJSON = JSON.stringify(filesData, null, 2);

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
  .toolbar .btn-copy {
    background: #67c23a;
    margin-left: 8px;
  }
  .toolbar .btn-copy:hover { background: #85ce61; }
  .toolbar .btn-copy.copied {
    background: #f56c6c;
  }
  .toolbar .btn-copy:first-of-type { margin-left: 16px; }
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
  .file-link {
    color: #409eff;
    text-decoration: none;
    cursor: pointer;
    padding: 1px 3px;
    border-radius: 3px;
    transition: all .15s;
  }
  .file-link:hover {
    color: #fff;
    background: #409eff;
    text-decoration: none;
  }
  .copy-btn {
    background: transparent;
    border: 1px solid transparent;
    cursor: pointer;
    font-size: 12px;
    padding: 0 4px;
    border-radius: 3px;
    margin-left: 6px;
    line-height: 1.6;
    opacity: .4;
    transition: all .15s;
  }
  .copy-btn:hover {
    opacity: 1;
    background: #f0f7ff;
    border-color: #d4e7ff;
  }
  .copy-btn.copied {
    opacity: 1;
    background: #f0f9eb;
    border-color: #e1f3d8;
  }
  .search-box {
    margin-bottom: 14px;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .search-box input {
    flex: 1;
    min-width: 240px;
    padding: 7px 12px;
    border: 1px solid #dcdfe6;
    border-radius: 4px;
    font-size: 13px;
    outline: none;
    transition: border-color .2s, box-shadow .2s;
  }
  .search-box input:focus {
    border-color: #409eff;
    box-shadow: 0 0 0 2px rgba(64,158,255,.15);
  }
  .search-box .search-info {
    color: #888;
    font-size: 12px;
    min-width: 80px;
  }
  .search-box .search-info em {
    color: #409eff;
    font-style: normal;
    font-weight: 600;
  }
  /* 命中高亮 */
  .name mark {
    background: #fff3a0;
    color: #d48806;
    padding: 0 2px;
    border-radius: 2px;
  }
  /* 匹配/非匹配状态 */
  li.filtered-out { display: none; }
  li.match > .row .name { background: #fff3a0; }
  /* 空结果提示 */
  .empty-tip {
    display: none;
    text-align: center;
    color: #999;
    padding: 30px 0;
    font-size: 13px;
  }
  .empty-tip.show { display: block; }
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
    <button class="btn-copy" onclick="copyFileList('json')">复制对象数组</button>
    <button class="btn-copy" onclick="copyFileList('names')">复制文件名</button>
    <button class="btn-copy" onclick="copyFileList('paths')">复制完整路径</button>
  </div>
  <div class="search-box">
    <input id="search-input" type="text" placeholder="输入关键字过滤文件名或路径（不区分大小写）..."
           oninput="onSearchInput(this.value)" />
    <span class="search-info" id="search-info"></span>
  </div>
  <div id="tree-container">
    ${treeToHTML(tree)}
  </div>
  <div class="empty-tip" id="empty-tip">未匹配到任何文件</div>
</div>
<script>
  // 后端注入的文件元数据，供复制功能使用
  window.__FILES__ = ${filesDataJSON};

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

  // 文件链接点击：浏览器拦截 file:// 时回退提示
  function onFileClick(event, el) {
    const href = el.getAttribute('href');
    const path = el.getAttribute('data-path') || '';
    // 检测是否在 file:// 协议下打开（本地 HTML 才能跳转 file:// 链接）
    if (location.protocol !== 'file:') {
      event.preventDefault();
      const ok = confirm(
        '浏览器在 http(s) 协议下会拦截 file:// 跳转。\\n\\n' +
        '请改用「直接打开本地 HTML 文件」的方式查看，或复制下方路径手动打开：\\n\\n' +
        path
      );
      if (ok) copyText(path, el);
      return;
    }
    // file 协议下：让浏览器默认行为继续（target=_blank 在新标签打开）
  }

  // 复制路径按钮
  function copyPath(btn) {
    const path = btn.getAttribute('data-path') || '';
    copyText(path, btn);
  }

  // 通用复制：优先使用 Clipboard API，回退到 textarea
  function copyText(text, triggerEl) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => markCopied(triggerEl)).catch(() => fallbackCopy(text, triggerEl));
    } else {
      fallbackCopy(text, triggerEl);
    }
  }
  function fallbackCopy(text, triggerEl) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      markCopied(triggerEl);
    } catch (e) {
      alert('复制失败，请手动复制：\\n' + text);
    }
  }
  function markCopied(el) {
    if (!el) return;
    const original = el.textContent;
    el.classList.add('copied');
    el.textContent = '✓';
    setTimeout(() => {
      el.classList.remove('copied');
      el.textContent = original;
    }, 1200);
  }

  // 批量复制文件信息
  // format: 'json' 对象数组 | 'names' 纯文件名 | 'paths' 完整路径
  function copyFileList(format) {
    const files = window.__FILES__ || [];
    if (files.length === 0) {
      alert('没有可复制的文件');
      return;
    }

    let text = '';
    let label = '';
    if (format === 'json') {
      // 对象数组 JSON：保留所有元信息，便于程序处理
      text = JSON.stringify(files, null, 2);
      label = '对象数组';
    } else if (format === 'names') {
      // 纯文件名清单（每行一个）
      text = files.map(f => f.name).join('\\n');
      label = '文件名';
    } else if (format === 'paths') {
      // 完整路径清单（每行一个）
      text = files.map(f => f.path).join('\\n');
      label = '完整路径';
    } else {
      return;
    }

    // 找到触发按钮，复制后给出反馈
    const btn = event && event.currentTarget ? event.currentTarget : null;
    copyText(text, btn);
    // 复制成功后短暂提示
    if (btn) {
      const orig = btn.textContent;
      btn.classList.add('copied');
      btn.textContent = '已复制 ' + files.length + ' 项';
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.textContent = orig;
      }, 1500);
    }
  }

  // ============ 搜索过滤 ============
  let searchTimer = null;

  function onSearchInput(value) {
    // 防抖：避免快速输入时频繁重算
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => doSearch(value), 120);
  }

  function doSearch(rawKeyword) {
    const keyword = (rawKeyword || '').trim().toLowerCase();
    const treeContainer = document.getElementById('tree-container');
    const emptyTip = document.getElementById('empty-tip');
    const info = document.getElementById('search-info');
    if (!treeContainer || !emptyTip) return;

    // 清理上次的高亮和过滤状态
    treeContainer.querySelectorAll('.filtered-out,.match').forEach(el => {
      el.classList.remove('filtered-out', 'match');
    });
    // 还原被搜索改写过的文本节点（移除 mark 标签）
    treeContainer.querySelectorAll('.name').forEach(restoreNameText);

    // 无关键字：恢复初始状态
    if (!keyword) {
      emptyTip.classList.remove('show');
      if (info) info.innerHTML = '';
      return;
    }

    // 遍历所有 li（根节点除外，根是 ul.tree.root > li，不参与过滤）
    const allLi = treeContainer.querySelectorAll('li.file, li.dir');
    let matchCount = 0;
    const matchedLiSet = new Set();

    // 第一遍：标记直接匹配的 li（同时匹配文件名和路径）
    allLi.forEach(li => {
      const name = (li.getAttribute('data-name') || '').toLowerCase();
      const path = (li.getAttribute('data-path') || '').toLowerCase();
      const hit = name.includes(keyword) || path.includes(keyword);
      if (hit) {
        li.classList.add('match');
        matchedLiSet.add(li);
        if (li.classList.contains('file')) matchCount++;
      }
    });

    // 第二遍：把匹配节点的所有祖先 li 标记为需要可见
    matchedLiSet.forEach(li => {
      let cur = li.parentElement;
      while (cur && cur !== treeContainer) {
        if (cur.tagName === 'LI') {
          matchedLiSet.add(cur);
          // 祖先是目录，自动展开（移除 collapsed）
          cur.classList.remove('collapsed');
          const toggle = cur.querySelector(':scope > .row > .toggle');
          if (toggle) toggle.textContent = '▼';
        }
        cur = cur.parentElement;
      }
    });

    // 第三遍：未在匹配集合里的 li 全部隐藏
    allLi.forEach(li => {
      if (!matchedLiSet.has(li)) {
        li.classList.add('filtered-out');
      } else {
        li.classList.remove('filtered-out');
      }
    });

    // 高亮匹配文件名中的命中片段
    matchedLiSet.forEach(li => {
      if (li.classList.contains('match')) highlightName(li, keyword);
    });

    // 更新提示
    if (info) {
      info.innerHTML = matchCount === 0
        ? '<em>0</em> 个匹配'
        : '匹配 <em>' + matchCount + '</em> 个文件';
    }
    emptyTip.classList.toggle('show', matchCount === 0);
  }

  // 高亮 name 元素中命中的关键字
  function highlightName(li, keyword) {
    const nameEl = li.querySelector(':scope > .row > .name');
    if (!nameEl) return;
    const text = nameEl.textContent;
    if (!text) return;
    const lower = text.toLowerCase();
    const idx = lower.indexOf(keyword);
    if (idx < 0) return;
    const before = text.slice(0, idx);
    const hit = text.slice(idx, idx + keyword.length);
    const after = text.slice(idx + keyword.length);
    nameEl.innerHTML = escapeHTMLExt(before)
      + '<mark>' + escapeHTMLExt(hit) + '</mark>'
      + escapeHTMLExt(after);
  }

  // 还原 name 元素为纯文本（移除 mark 标签）
  function restoreNameText(nameEl) {
    const text = nameEl.textContent;
    if (nameEl.querySelector('mark')) {
      nameEl.textContent = text;
    }
  }

  function escapeHTMLExt(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
</script>
</body>
</html>`;
}

module.exports = {
    name: 'file2html',
    version: '1.3.0',
    process: writingRules,
    mode: 'stream', // 声明为流式模式
    description: '将输入的文件数组拼接成树结构，输出可展开/收缩的 HTML 文件，支持点击打开/复制路径/批量复制，并新增关键字搜索过滤（命中高亮、自动展开祖先目录、空结果提示）',
    notes: {
        node: '18.20.4'
    },
    input: {
        normExt: '文件数组',
        format: '[{name, path, isDirectory, size, normExt}]'
    },
    output: {
        normExt: 'html',
        format: '可展开/收缩的文件树结构 HTML 文件，支持点击打开/复制路径/批量复制/关键字搜索过滤'
    }
};
