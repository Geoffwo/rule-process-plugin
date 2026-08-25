const QRCode = require("qrcode");
const path = require("path");
const sharp = require("sharp");

/**
 * 生成美化二维码buffer（移除圆点/圆角美化，原生方块）
 * @param {string} text
 * @param {object} options
 * @param {Buffer} [logoBuffer]
 * @param {Buffer} [bgBuffer]
 * @returns {Promise<Buffer>}
 */
async function generateBeautyQR(text, options = {}, logoBuffer, bgBuffer) {
    const {
        width = 256,
        margin = 2,
        errorCorrectionLevel = "H",
        qrColor="#000000",
        qrBgColor="#ffffff",
        logo,
        background
    } = options;

    let svgRaw = await QRCode.toString(String(text), {
        type: "svg",
        width,
        margin,
        errorCorrectionLevel,
        color: { dark: qrColor, light: qrBgColor }
    });

    const qrTotalSize = width + margin * 2;
    let qrSharp = sharp(Buffer.from(svgRaw))
        .resize(qrTotalSize, qrTotalSize, {
            fit: "contain",
            background: { r: 255, g: 255, b: 255, alpha: 1 }
        });

    // 没有背景图，直接输出普通二维码
    if (!bgBuffer) {
        return qrSharp.png().toBuffer();
    }

    const { blur = 0, qrBgPadding = 20, qrBgRadius = 16 } = background || {};
    const outSize = qrTotalSize + qrBgPadding * 2;

    // 1.构建【二维码卡片】：白底+二维码，之后做圆角蒙版
    const cardSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${qrTotalSize}" height="${qrTotalSize}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <image href="data:image/png;base64,${(await qrSharp.toBuffer()).toString('base64')}" width="${qrTotalSize}" height="${qrTotalSize}"/>
</svg>`;

    // 2.圆角蒙版：clipPath 裁切卡片四角
    const maskSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${qrTotalSize}" height="${qrTotalSize}">
  <defs>
    <clipPath id="roundClip">
      <rect x="0" y="0" width="${qrTotalSize}" height="${qrTotalSize}" rx="${qrBgRadius}" ry="${qrBgRadius}"/>
    </clipPath>
  </defs>
  <g clip-path="url(#roundClip)">
    ${cardSvg}
  </g>
</svg>`;

    // 得到已经切好圆角的二维码卡片buffer
    const roundedCardBuffer = await sharp(Buffer.from(maskSvg)).png().toBuffer();

    // 背景画布
    let bgSharp = sharp(bgBuffer).resize(outSize, outSize, { fit: "cover" });
    if (Number(blur) > 0) {
        bgSharp = bgSharp.blur(blur);
    }

    const compositeLayers = [];
    // 贴已经做好圆角的卡片
    compositeLayers.push({
        input: roundedCardBuffer,
        top: qrBgPadding,
        left: qrBgPadding
    });

    // 叠加logo
    if (logoBuffer && logo?.scale) {
        const logoRealSize = Math.floor(qrTotalSize * logo.scale);
        const logoBuf = await sharp(logoBuffer)
            .resize(logoRealSize, logoRealSize, { fit: "inside", background: { r: 255, g: 255, b: 255, alpha: 0 } })
            .toBuffer();
        const offset = Math.floor((outSize - logoRealSize) / 2);
        compositeLayers.push({ input: logoBuf, top: offset, left: offset });
    }

    return bgSharp.composite(compositeLayers).png().toBuffer();
}


async function* writingRules(inputArray, outputNodeTemplate) {
    const outputDir = outputNodeTemplate.path;
    const inputPath = path.join(outputDir, "../inputDir");

    const configFile = inputArray.find(item => item.normExt === "json" && item.name === "config");
    if (!configFile) {
        console.log("未找到 config.json，已生成模板配置、示例logo、示例背景图");

        const demoLogoBuffer = await sharp({
            create: {
                width: 200,
                height: 200,
                channels: 4,
                background: { r: 30, g: 136, b: 229, alpha: 1 }
            }
        })
            .composite([{
                input: Buffer.from(`
<svg width="200" height="200">
  <circle cx="100" cy="100" r="80" fill="#ffffff"/>
  <text  x="100"  y="100"  font-size="90"  font-weight="bold"  font-family="Arial"  text-anchor="middle"  dominant-baseline="middle" fill="#1e88e5">G</text>
</svg>
    `)
            }])
            .png()
            .toBuffer();

        const demoBgBuffer = await sharp({
            create: {
                width: 800,
                height: 800,
                channels: 4,
                background: { r: 60, g: 120, b: 180, alpha: 1 }
            }
        })
            .png()
            .toBuffer();

        const template = [
            {
                text: "https://gitee.com/Geoffwo/file-rule-process",
                options: {
                    width: 400,
                    margin: 2,
                    qrColor: "#ffffff",
                    qrBgColor: "#1b65b9",
                    errorCorrectionLevel: "H",
                    logo: { refName: "logo", scale: 0.2 },
                    background: { refName: "bg", blur: 6, qrBgPadding: 20, qrBgRadius: 16 }
                }
            }
        ];

        yield [
            { ...outputNodeTemplate, content: "错误: 未找到 config.json，已生成模板配置+示例logo+示例背景图" },
            { ...outputNodeTemplate, path: inputPath, fileName: "config", normExt: "json", content: JSON.stringify(template, null, 2) },
            { ...outputNodeTemplate, path: inputPath, fileName: "logo", normExt: "png", content: demoLogoBuffer },
            { ...outputNodeTemplate, path: inputPath, fileName: "bg", normExt: "png", content: demoBgBuffer }
        ];
        return;
    }

    const contents = JSON.parse(configFile.content);
    let index = 0;

    for (const item of contents) {
        index++;
        const text = item.text;
        const opts = item.options || {};

        let logoBuffer = null;
        if (opts.logo?.refName) {
            const logoNode = inputArray.find(n => n.name === opts.logo.refName);
            if (logoNode?.content) logoBuffer = logoNode.content;
        }

        let bgBuffer = null;
        if (opts.background?.refName) {
            const bgNode = inputArray.find(n => n.name === opts.background.refName);
            if (bgNode?.content) bgBuffer = bgNode.content;
        }

        const pngBuffer = await generateBeautyQR(text, opts, logoBuffer, bgBuffer);

        yield [{
            ...outputNodeTemplate,
            fileName: `qr_${configFile.name}_${index}`,
            normExt: "png",
            content: pngBuffer
        }];
    }
}

module.exports = {
    name: "qrcode",
    version: "1.1.0",
    process: writingRules,
    description: "二维码生成：原生方块；背景圆角衬底；支持logo叠加、背景模糊；移除圆点/圆角美化逻辑",
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
        "qrcode": "1.5.4",
        "sharp": "0.34.5"
    }
};
