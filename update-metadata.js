const fs = require('fs');
const path = require('path');

// 插件目录和元数据文件路径
const pluginsDir = path.join(process.cwd(), 'plugins');
const metadataPath = path.join(process.cwd(), 'metadata.json');

// 获取单个插件的所有版本信息
function getPluginVersions(pluginPath, pluginName) {
  const files = fs.readdirSync(pluginPath).filter(f => f.endsWith('.js'));
  const versions = {};
  files.forEach(file => {
    const version = file.replace('.js', '');
    const relPath = `plugins/${pluginName}/${file}`;
    versions[version] = {
      gitee: `https://gitee.com/Geoffwo/rule-process-plugin/raw/master/${relPath}`,
      github: `https://gitee.com/Geoffwo/rule-process-plugin/raw/master/${relPath}`
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

// 写入 metadata.json
function updateMetadata() {
  const plugins = collectPlugins();
  console.log('plugins',plugins);
  // fs.writeFileSync(metadataPath, JSON.stringify({ plugins }, null, 2), 'utf-8');
  fs.writeFileSync(metadataPath, JSON.stringify(plugins, null, 2), 'utf-8');
  console.log('metadata.json 已自动更新');
  console.log(metadataPath);
}

updateMetadata();