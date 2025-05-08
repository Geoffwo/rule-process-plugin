const fs = require('fs');
const path = require('path');

// 插件目录和元数据文件路径
const pluginsDir = path.join(process.cwd(), 'plugins');
const metadataPath = path.join(process.cwd(), 'metadata.json');
const readmePath = path.join(process.cwd(), 'README.md');

// 获取单个插件的所有版本信息
function getPluginVersions(pluginPath, pluginName) {
  const files = fs.readdirSync(pluginPath).filter(f => f.endsWith('.js'));
  const versions = {};
  files.forEach(file => {
    const version = file.replace('.js', '');
    const relPath = `plugins/${pluginName}/${file}`;
    versions[version] = {
      gitee: `https://gitee.com/Geoffwo/rule-process-plugin/raw/master/${relPath}`,
      github: `https://raw.githubusercontent.com/Geoffwo/rule-process-plugin/master/${relPath}`
    };
  });
  return versions;
}

// 收集所有插件信息
function collectPlugins() {
  const plugins = {};
  fs.readdirSync(pluginsDir).forEach(pluginName => {
    const pluginPath = path.join(pluginsDir, pluginName);
    if (fs.statSync(pluginPath).isDirectory()) {
      const versions = getPluginVersions(pluginPath, pluginName);
      if (Object.keys(versions).length > 0) {
        plugins[pluginName] = { versions };
      }
    }
  });
  return plugins;
}

//更新readme
function updateReadme(plugins) {
  try {
    let readmeContent = fs.readFileSync(readmePath, 'utf-8');

    // 生成Markdown表格内容
    let tableContent = '| 插件名称 | 版本 | Gitee 链接 | GitHub 链接 |\n';
    tableContent += '|----------|------|------------|-------------|\n';

    // 按插件名称排序
    const sortedPlugins = Object.keys(plugins).sort();
    for (const pluginName of sortedPlugins) {
      const versions = plugins[pluginName].versions;
      // 按版本号降序排序（语义化版本）
      const sortedVersions = Object.keys(versions).sort((a, b) => {
        const aParts = a.split('.').map(Number);
        const bParts = b.split('.').map(Number);
        for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
          const aVal = aParts[i] || 0;
          const bVal = bParts[i] || 0;
          if (aVal !== bVal) return bVal - aVal;
        }
        return 0;
      });

      // 填充表格行
      sortedVersions.forEach(version => {
        const { gitee, github } = versions[version];
        tableContent += `| ${pluginName} | ${version} | [下载](${gitee}) | [下载](${github}) |\n`;
      });
    }

    // 替换注释标记间的内容
    const startMarker = '<!-- PLUGIN_LIST_START -->';
    const endMarker = '<!-- PLUGIN_LIST_END -->';
    const newSection = `${startMarker}\n${tableContent}\n${endMarker}`;
    const regex = new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`, 'g');
    const updatedContent = readmeContent.replace(regex, newSection);

    if (updatedContent === readmeContent) {
      console.error('未找到插件列表标记，README未更新。请添加%s和%s。', startMarker, endMarker);
      return;
    }

    fs.writeFileSync(readmePath, updatedContent, 'utf-8');
    console.log('README.md 已自动更新');
  } catch (err) {
    console.error('更新README失败:', err);
  }
}

function autoUpdate() {
  const plugins = collectPlugins();
  fs.writeFileSync(metadataPath, JSON.stringify(plugins, null, 2), 'utf-8');
  console.log('metadata.json 已自动更新');
  updateReadme(plugins);
}

autoUpdate();