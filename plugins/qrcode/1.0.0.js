const QRCode = require("qrcode");
const path = require("path");

/**
 * 二维码生成插件
 *
 * 契约：{ name, version, process, rely }
 * - name/version：插件标识，供 global.getPlugin(name) 取用
 * - process(text, options)：被规则调用，返回 PNG Buffer
 * - rely：声明 npm 依赖版本，rule-process 运行时会自动安装到宿主 node_modules
 *
 * @param {string} text - 待编码文本
 * @param {object} [options] - 可选配置（width / margin / errorCorrectionLevel）
 * @returns {Promise<Buffer>} PNG 图片 Buffer
 */
async function generateQR(text, options = {}) {
  return QRCode.toBuffer(String(text), {
    errorCorrectionLevel: options.errorCorrectionLevel || 'M',
    width: options.width || 256,
    margin: options.margin || 2,
    color: { dark: '#000000', light: '#ffffff' }
  })
}

// 二维码生成规则：读取输入目录中的文本文件，按行调用 qrcode 插件生成 PNG
async function* writingRules(inputArray, outputNodeTemplate) {
  const outputDir = outputNodeTemplate.path;
  const inputPath = path.join(outputDir, '../inputDir');

  const configFile = inputArray.find(item => item.normExt === 'json' && item.name === 'config');
  if (!configFile) {
    console.log('未找到 config.json，已生成模板配置');
    const content = [{
      text: 'https://gitee.com/Geoffwo/file-rule-process',
      option: {
      }
    }]
    yield [
      { ...outputNodeTemplate, content: '错误: 未找到 config.json，已生成模板配置' },
      { ...outputNodeTemplate, path: inputPath, fileName: 'config', normExt: 'json', content: JSON.stringify(content, null, 2) }
    ];
    return;
  }

  const contents = JSON.parse(configFile.content);


  let index = 0
  for (const content of contents) {
    index++
    const text = content.text;
    const options = content.options;

    const pngBuffer = await generateQR(text,options)
    // 流式逐个产出输出节点（yield 必须是数组）
    yield [{
      ...outputNodeTemplate,
      fileName: `qr_${configFile.name}_${index}`,
      normExt: 'png',
      content: pngBuffer
    }]
  }
}

module.exports = {
  name: 'qrcode',
  version: '1.0.0',
  process: writingRules,
  description: '调用 qrcode 插件生成二维码图片',
  notes: {
    node: '18.20.4'
  },
  input: {
    normExt: 'config.json'
  },
  output: {
    normExt: 'png'
  },
  rely: {
    "qrcode": "1.5.4"
  },
}
