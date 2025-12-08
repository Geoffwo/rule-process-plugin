const sharp = require('sharp');

// 常用证件照标准尺寸（300DPI，像素）
const sizeConfig = [
  { width: 295, height: 413, name: '1寸', desc: '标准1寸（2.5×3.5cm）', dpi: 300 },
  { width: 220, height: 320, name: '护照', desc: '小1寸/护照（2.2×3.2cm）', dpi: 300 },
  { width: 413, height: 626, name: '2寸', desc: '标准2寸（3.5×5.3cm）', dpi: 300 },
  { width: 390, height: 567, name: '通行证', desc: '小2寸/港澳通行证（3.3×4.8cm）', dpi: 300 },
  { width: 220, height: 320, name: '驾驶证', desc: '驾驶证（2.2×3.2cm）', dpi: 300 }
]

// 主处理函数
async function writingRules(inputArray, outputNodeTemplate) {
  // 筛选图片文件
  const imgFiles = inputArray.filter(info =>
      info.path.endsWith('.jpg') ||
      info.path.endsWith('.jpeg') ||
      info.path.endsWith('.png') ||
      info.path.endsWith('.webp')
  );

  if (imgFiles.length === 0) {
    return [{...outputNodeTemplate, content: '错误: 未找到图片文件'}];
  }

  const contents = []
  for (const imgFile of imgFiles) {
    const inputFile = imgFile.path;//文件
    const imgExt = imgFile.normExt;
    const fileName = imgFile.name;
    const outputPath = outputNodeTemplate.path;
    // 图片处理逻辑
    const sharpInstance = sharp(inputFile);
    // 获取原图信息（用于日志）
    const metadata = await sharpInstance.metadata();
    console.log(`处理中：${fileName}（原图尺寸：${metadata.width}×${metadata.height}）`);

    for (const config of sizeConfig) {
      const outputFile = `${outputPath}/${fileName}_${config.name}.${imgExt}`
      // 调整尺寸（裁剪/留白二选一）
      await sharpInstance
          .resize(config.width, config.height, {
            fit: 'cover',
            position: 'center',
          })
          .withMetadata({
            density: config.dpi,
            unit: 'inch'
          })
          .toFormat(imgExt) // 统一输出格式
          .toFile(outputFile);
    }

    // 3. 生成结果
    contents.push({
      fileName: `${fileName}.${imgExt}`,
      size: `${metadata.width}×${metadata.height}`,
      content: '常用证件照生成成功'
    });
  }
  return [{...outputNodeTemplate,content:JSON.stringify(contents,null,2)}];
}

// module.exports = writingRules;

// 修正后的导出配置
module.exports = {
  name: 'img2format',
  version: '1.0.0',
  process: writingRules,
  description: '证件照转换：生成1寸/2寸等常用尺寸',
  notes:{
    node:'18.20.4'
  },
  input: {
    normExt: 'jpg/png/webp',
    format: "图片文件"
  },
  output: {
    normExt: 'jpg/png/webp',
    format: "图片文件"
  },
  rely: {
    'sharp': '0.34.5'
  }
};