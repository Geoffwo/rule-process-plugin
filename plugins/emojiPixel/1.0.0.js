const sharp = require('sharp');
const path = require('path');

// ========== 工具函数 ==========
const random = arr => arr[Math.floor(Math.random() * arr.length)];
const weightRandom = (items) => {
  const total = items.reduce((sum, i) => sum + i.weight, 0);
  let rand = Math.random() * total;
  for (const item of items) {
    rand -= item.weight;
    if (rand <= 0) return item.value;
  }
  return items[0].value;
};

// ========== 默认参数 ==========
const DEFAULTS = {
  blockSize: 12,
  logicWidth: 24,
  logicHeight: 28,
  count: 6
};

// ========== 配色库 ==========
const PALETTE = {
  stroke: '#2D2D2D', // 统一描边深灰，比纯黑柔和
  skin: ['#FFDAB9', '#F5DEB3', '#DEB887', '#D2B48C', '#C69A79'],
  skinDark: ['#E5C4A3', '#DCC49A', '#C8A376', '#B89A78', '#A88263'],
  hair: [
    '#1A1A1A', '#4A2C1A', '#8B4513', '#D2691E',
    '#FFD700', '#FF69B4', '#9370DB', '#00CED1'
  ],
  hairDark: [
    '#000000', '#2E1A0E', '#5D2906', '#8B4513',
    '#B8860B', '#C71585', '#6A5ACD', '#008B8B'
  ],
  hairHigh: [
    '#444444', '#7A4A32', '#B87333', '#E8945A',
    '#FFE55C', '#FF9AC9', '#B19CD9', '#4DD0E1'
  ],
  eye: ['#1A1A1A', '#1E5AAF', '#A0522D', '#2E8B57', '#9932CC'],
  mouth: ['#FF6B6B', '#FF4D4D', '#E63946', '#D62828'],
  blush: ['#FFB6C1', '#FF9999', '#FFA07A'],
  clothes: [
    '#E63946', '#1D3557', '#457B9D', '#2A9D8F',
    '#F4A261', '#E76F51', '#9B5DE5', '#00BBF9'
  ],
  clothesDark: [
    '#B82E38', '#15253D', '#36617A', '#1F7A70',
    '#C2824E', '#B85940', '#7A4BB8', '#0096CC'
  ],
  bg: ['#F7F9FC', '#FFF5E6', '#F0F8FF', '#FFFAF0', '#F5F0FF', '#F0FFF4']
};

// ========== 稀有度配置 ==========
const RARITY = [
  { value: 'normal', weight: 60 },
  { value: 'rare', weight: 30 },
  { value: 'legendary', weight: 10 }
];

// ========== 发型库 ==========
const HAIR_STYLES = [
  {
    name: 'bangs',
    outline: [[4,3],[5,2],[6,2],[7,2],[8,2],[9,2],[10,2],[11,2],[12,2],[13,2],[14,2],[15,2],[16,2],[17,2],[18,3],[4,4],[18,4],[4,5],[18,5],[4,6],[17,6]],
    main: [[5,3],[6,3],[7,3],[8,3],[9,3],[10,3],[11,3],[12,3],[13,3],[14,3],[15,3],[16,3],[17,3],[5,4],[6,4],[7,4],[8,4],[9,4],[10,4],[11,4],[12,4],[13,4],[14,4],[15,4],[16,4],[17,4],[5,5],[6,5],[7,5],[8,5],[9,5],[10,5],[11,5],[12,5],[13,5],[14,5],[15,5],[16,5],[17,5],[5,6],[6,6],[7,6],[8,6],[9,6],[10,6],[11,6],[12,6],[13,6],[14,5],[15,6],[16,6]],
    bangs: [[6,7],[7,7],[8,7],[9,7],[10,7],[11,7],[12,7],[13,7],[14,7],[15,7],[16,7],[7,8],[8,8],[9,8],[10,8],[11,8],[12,8],[13,8],[14,8],[15,8]],
    highlight: [[7,4],[8,4],[9,4]]
  },
  {
    name: 'sideBangs',
    outline: [[4,3],[5,2],[6,2],[7,2],[8,2],[9,2],[10,2],[11,2],[12,2],[13,2],[14,2],[15,2],[16,2],[17,2],[18,3],[4,4],[18,4],[4,5],[18,5],[4,6],[17,6]],
    main: [[5,3],[6,3],[7,3],[8,3],[9,3],[10,3],[11,3],[12,3],[13,3],[14,3],[15,3],[16,3],[17,3],[5,4],[6,4],[7,4],[8,4],[9,4],[10,4],[11,4],[12,4],[13,4],[14,4],[15,4],[16,4],[17,4],[5,5],[6,5],[7,5],[8,5],[9,5],[10,5],[11,5],[12,5],[13,5],[14,5],[15,5],[16,5],[17,5],[5,6],[6,6],[7,6],[8,6],[9,6],[10,6],[11,6],[12,6],[13,6],[14,6],[15,6],[16,6]],
    bangs: [[6,7],[7,7],[8,7],[9,7],[10,7],[11,7],[7,8],[8,8],[9,8],[10,8],[8,9],[9,9]],
    highlight: [[13,4],[14,4],[15,4]]
  },
  {
    name: 'bun',
    outline: [[10,0],[11,0],[12,0],[13,0],[9,1],[10,1],[11,1],[12,1],[13,1],[14,1],[4,3],[5,2],[6,2],[7,2],[8,2],[9,2],[10,2],[11,2],[12,2],[13,2],[14,2],[15,2],[16,2],[17,2],[18,3],[4,4],[18,4],[4,5],[18,5],[4,6],[17,6]],
    main: [[10,0],[11,0],[12,0],[13,0],[9,1],[10,1],[11,1],[12,1],[13,1],[14,1],[5,3],[6,3],[7,3],[8,3],[9,3],[10,3],[11,3],[12,3],[13,3],[14,3],[15,3],[16,3],[17,3],[5,4],[6,4],[7,4],[8,4],[9,4],[10,4],[11,4],[12,4],[13,4],[14,4],[15,4],[16,4],[17,4],[5,5],[6,5],[7,5],[8,5],[9,5],[10,5],[11,5],[12,5],[13,5],[14,5],[15,5],[16,5],[17,5],[5,6],[6,6],[7,6],[8,6],[9,6],[10,6],[11,6],[12,6],[13,6],[14,6],[15,6],[16,6]],
    bangs: [[6,7],[7,7],[8,7],[9,7],[10,7],[11,7],[12,7],[13,7],[14,7],[15,7],[16,7],[7,8],[8,8],[9,8],[10,8],[11,8],[12,8],[13,8],[14,8]],
    highlight: [[11,1],[12,1],[8,4],[9,4]]
  },
  {
    name: 'short',
    outline: [[4,4],[5,3],[6,2],[7,2],[8,2],[9,2],[10,2],[11,2],[12,2],[13,2],[14,2],[15,2],[16,2],[17,3],[18,4],[4,5],[18,5],[4,6],[18,6],[5,7],[17,7]],
    main: [[5,4],[6,3],[7,3],[8,3],[9,3],[10,3],[11,3],[12,3],[13,3],[14,3],[15,3],[16,3],[17,4],[5,5],[6,5],[7,5],[8,5],[9,5],[10,5],[11,5],[12,5],[13,5],[14,5],[15,5],[16,5],[17,5],[5,6],[6,6],[7,6],[8,6],[9,6],[10,6],[11,6],[12,6],[13,6],[14,6],[15,6],[16,6],[17,6],[6,7],[7,7],[8,7],[9,7],[10,7],[11,7],[12,7],[13,7],[14,7],[15,7],[16,7]],
    bangs: [[7,8],[8,8],[9,8],[10,8],[11,8],[12,8],[13,8],[14,8]],
    highlight: [[8,4],[9,4],[10,4]]
  }
];

// ========== 嘴型库 ==========
const MOUTH_STYLES = [
  { name: 'smile', pixels: [[10,13],[11,13],[12,13],[9,14],[13,14]] },
  { name: 'grin', pixels: [[9,13],[10,13],[11,13],[12,13],[13,13],[9,14],[13,14]], teeth: [[10,14],[11,14],[12,14]] },
  { name: 'pout', pixels: [[10,13],[11,13],[10,14],[11,14]] },
  { name: 'surprised', pixels: [[10,13],[11,13],[10,14],[11,14],[10,15],[11,15]] }
];

// ========== 配饰库 ==========
const ACCESSORIES = [
  {
    name: 'glasses', weight: 6,
    pixels: [[6,9],[7,9],[8,9],[9,9],[10,9],[14,9],[15,9],[16,9],[17,9],[6,10],[10,10],[14,10],[17,10],[6,11],[7,11],[8,11],[9,11],[10,11],[14,11],[15,11],[16,11],[17,11],[11,10],[12,10],[13,10]],
    color: '#2D2D2D'
  },
  {
    name: 'bow', weight: 5,
    pixels: [[4,5],[5,5],[6,5],[4,6],[5,6],[6,6],[5,4]],
    color: '#FF6B6B'
  },
  {
    name: 'cap', weight: 4,
    pixels: [[5,2],[6,2],[7,2],[8,2],[9,2],[10,2],[11,2],[12,2],[13,2],[14,2],[15,2],[16,2],[17,2],[5,3],[6,3],[7,3],[8,3],[9,3],[10,3],[11,3],[12,3],[13,3],[14,3],[15,3],[16,3],[17,3],[4,4],[5,4],[6,4],[7,4],[8,4],[9,4],[10,4],[11,4],[12,4],[13,4],[14,4],[15,4],[16,4],[17,4],[18,4]],
    color: '#E63946'
  }
];

// ========== 核心生成逻辑 ==========
function generateAvatar(config) {
  const { logicWidth, logicHeight } = config;
  const rarity = weightRandom(RARITY);

  const skinIdx = Math.floor(Math.random() * PALETTE.skin.length);
  const skin = PALETTE.skin[skinIdx];
  const skinDark = PALETTE.skinDark[skinIdx];

  let hairColor, hairDark, hairHigh;
  if (rarity === 'legendary') {
    const specialColors = ['#FFD700', '#FF00FF', '#00FFFF', '#7FFF00', '#FF4500'];
    hairColor = random(specialColors);
    hairDark = random(specialColors);
    hairHigh = '#FFFFFF';
  } else {
    const hairIdx = Math.floor(Math.random() * PALETTE.hair.length);
    hairColor = PALETTE.hair[hairIdx];
    hairDark = PALETTE.hairDark[hairIdx];
    hairHigh = PALETTE.hairHigh[hairIdx];
  }

  const eyeColor = random(PALETTE.eye);
  const mouthColor = random(PALETTE.mouth);
  const blushColor = random(PALETTE.blush);
  const clothIdx = Math.floor(Math.random() * PALETTE.clothes.length);
  const clothColor = PALETTE.clothes[clothIdx];
  const clothDark = PALETTE.clothesDark[clothIdx];
  const bgColor = random(PALETTE.bg);

  const pixels = Array.from({ length: logicHeight }, () => Array(logicWidth).fill(bgColor));

  // 身体外轮廓
  const bodyOutline = [[5,17],[6,16],[17,16],[18,17],[4,18],[19,18],[4,19],[19,19],[5,20],[18,20],[6,21],[17,21]];
  bodyOutline.forEach(([x, y]) => {
    if (y >= 0 && y < logicHeight && x >= 0 && x < logicWidth) pixels[y][x] = PALETTE.stroke;
  });

  // 身体主体
  for (let y = 17; y <= 21; y++) {
    let startX = 5, endX = 18;
    if (y === 21) { startX = 6; endX = 17; }
    for (let x = startX; x <= endX; x++) {
      if (pixels[y][x] === bgColor) pixels[y][x] = clothColor;
    }
  }

  // 衣服阴影
  for (let y = 20; y <= 21; y++) {
    for (let x = 7; x <= 16; x++) {
      if (pixels[y][x] === clothColor) pixels[y][x] = clothDark;
    }
  }

  // 领口
  [[10,17],[11,17],[12,17],[13,17],[10,18],[11,18],[12,18],[13,18]].forEach(([x, y]) => {
    if (y < logicHeight) pixels[y][x] = skin;
  });

  // 手
  [[3,18],[4,18],[3,19],[4,19],[19,18],[20,18],[19,19],[20,19]].forEach(([x, y]) => {
    if (y < logicHeight) pixels[y][x] = skin;
  });

  // 腿
  [[7,22],[8,22],[14,22],[15,22],[7,23],[8,23],[14,23],[15,23]].forEach(([x, y]) => {
    if (y < logicHeight) pixels[y][x] = PALETTE.stroke;
  });
  for (let y = 22; y <= 23; y++) {
    for (let x = 8; x <= 9; x++) { if (y < logicHeight) pixels[y][x] = clothDark; }
    for (let x = 14; x <= 15; x++) { if (y < logicHeight) pixels[y][x] = clothDark; }
  }

  // 鞋
  [[6,24],[7,24],[8,24],[9,24],[10,24],[13,24],[14,24],[15,24],[16,24],[17,24],[7,25],[8,25],[9,25],[14,25],[15,25]].forEach(([x, y]) => {
    if (y < logicHeight) pixels[y][x] = PALETTE.stroke;
  });

  // 头部轮廓
  const headOutline = [[5,4],[6,3],[7,3],[8,3],[9,3],[10,3],[11,3],[12,3],[13,3],[14,3],[15,3],[16,3],[17,3],[18,4],[4,5],[19,5],[4,6],[19,6],[4,7],[19,7],[4,8],[19,8],[4,9],[19,9],[4,10],[19,10],[4,11],[19,11],[4,12],[19,12],[4,13],[19,13],[4,14],[19,14],[5,15],[18,15],[6,16],[17,16],[7,17],[16,17]];
  headOutline.forEach(([x, y]) => {
    if (y >= 0 && y < logicHeight && x >= 0 && x < logicWidth) pixels[y][x] = PALETTE.stroke;
  });

  // 肤色
  for (let y = 5; y <= 16; y++) {
    let startX = 5, endX = 18;
    if (y === 5 || y === 16) { startX = 6; endX = 17; }
    if (y === 17) { startX = 7; endX = 16; }
    for (let x = startX; x <= endX; x++) pixels[y][x] = skin;
  }
  for (let y = 7; y <= 15; y++) pixels[y][18] = skinDark;
  for (let x = 8; x <= 15; x++) pixels[16][x] = skinDark;

  // 发型
  const hairStyle = random(HAIR_STYLES);
  hairStyle.outline.forEach(([x, y]) => { if (y >= 0 && y < logicHeight && x >= 0 && x < logicWidth) pixels[y][x] = PALETTE.stroke; });
  hairStyle.main.forEach(([x, y]) => { if (y >= 0 && y < logicHeight && x >= 0 && x < logicWidth) pixels[y][x] = hairColor; });
  hairStyle.bangs.forEach(([x, y]) => { if (y >= 0 && y < logicHeight && x >= 0 && x < logicWidth) pixels[y][x] = hairDark; });
  hairStyle.highlight.forEach(([x, y]) => { if (y >= 0 && y < logicHeight && x >= 0 && x < logicWidth) pixels[y][x] = hairHigh; });

  // 眼睛
  [[7,10],[7,11],[16,10],[16,11]].forEach(([x, y]) => pixels[y][x] = '#FFFFFF');
  [[8,10],[9,10],[8,11],[9,11],[14,10],[15,10],[14,11],[15,11]].forEach(([x, y]) => pixels[y][x] = eyeColor);
  pixels[10][8] = '#FFFFFF';
  pixels[10][14] = '#FFFFFF';

  // 嘴型
  const mouthStyle = random(MOUTH_STYLES);
  mouthStyle.pixels.forEach(([x, y]) => pixels[y][x] = mouthColor);
  if (mouthStyle.teeth) mouthStyle.teeth.forEach(([x, y]) => pixels[y][x] = '#FFFFFF');

  // 腮红
  [[6,12],[7,12],[16,12],[17,12]].forEach(([x, y]) => {
    if (pixels[y][x] === skin || pixels[y][x] === skinDark) pixels[y][x] = blushColor;
  });

  // 配饰
  let accessory = null;
  const accessoryChance = rarity === 'legendary' ? 0.6 : rarity === 'rare' ? 0.25 : 0.1;
  if (Math.random() < accessoryChance) {
    accessory = weightRandom(ACCESSORIES.map(a => ({ value: a, weight: a.weight })));
    accessory.pixels.forEach(([x, y]) => {
      if (y >= 0 && y < logicHeight && x >= 0 && x < logicWidth) pixels[y][x] = accessory.color;
    });
  }

  return { pixels, bgColor, rarity, hairStyle: hairStyle.name, mouthStyle: mouthStyle.name, accessory: accessory?.name || null };
}

// ========== 渲染图片Buffer ==========
async function renderAvatarBuffer(pixels, config) {
  const { blockSize, logicWidth, logicHeight } = config;
  const canvasWidth = logicWidth * blockSize;
  const canvasHeight = logicHeight * blockSize;

  const composites = [];
  for (let y = 0; y < logicHeight; y++) {
    for (let x = 0; x < logicWidth; x++) {
      composites.push({
        input: { create: { width: blockSize, height: blockSize, channels: 4, background: pixels[y][x] } },
        left: x * blockSize,
        top: y * blockSize
      });
    }
  }

  return await sharp({
    create: { width: canvasWidth, height: canvasHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  }).composite(composites).png().toBuffer();
}

// ========== 默认配置模板 ==========
function createConfigTemplate() {
  return {
    blockSize: 12,// 单个逻辑像素的实际大小
    logicWidth: 24,// 逻辑画布宽度
    logicHeight: 28,// 逻辑画布高度
    count: 6 // 生成的数量
  };
}

// ========== 插件主入口 ==========
async function writingRules(inputArray, outputNodeTemplate) {
  const outputDir = outputNodeTemplate.path;
  const inputPath = path.join(outputDir, '../inputDir');

  // 查找config.json
  const configFile = inputArray.find(item => item.normExt === 'json' && item.name === 'config');
  if (!configFile) {
    const template = createConfigTemplate();
    return [
      { ...outputNodeTemplate, content: '错误: 未找到 config.json 文件，示例配置已创建' },
      { ...outputNodeTemplate, path: inputPath, fileName: 'config', normExt: 'json', content: JSON.stringify(template, null, 2) }
    ];
  }

  const config = { ...DEFAULTS, ...JSON.parse(configFile.content) };
  const results = [];
  const summary = [];

  for (let i = 1; i <= config.count; i++) {
    const avatarData = generateAvatar(config);
    const buffer = await renderAvatarBuffer(avatarData.pixels, config);
    const fileName = `avatar_${i}_${Math.random().toString(36).slice(2, 10)}`;

    results.push({
      ...outputNodeTemplate,
      fileName,
      normExt: 'png',
      content: buffer
    });

    summary.push({ index: i, file: `${fileName}.png`, rarity: avatarData.rarity, hair: avatarData.hairStyle, mouth: avatarData.mouthStyle, accessory: avatarData.accessory });
    console.log(`生成头像 ${i}/${config.count} | 稀有度:${avatarData.rarity}${avatarData.accessory ? ' | 配饰:' + avatarData.accessory : ''}`);
  }

  // 额外输出一份汇总JSON
  results.push({
    ...outputNodeTemplate,
    fileName: 'avatar_summary',
    normExt: 'json',
    content: JSON.stringify({ total: config.count, generatedAt: new Date().toLocaleString(), avatars: summary }, null, 2)
  });

  return results;
}

module.exports = {
  name: 'emojiPixel',
  version: '1.0.0',
  process: writingRules,
  description: '随机像素小人头像生成插件，支持稀有度、发型、嘴型、配饰随机组合',
  notes: {
    node: '18.20.4'
  },
  input: {
    normExt: 'json配置文件(可选blockSize/logicWidth/logicHeight/count)',
  },
  output: {
    normExt: 'png',
  },
  rely: {
    'sharp': '0.34.5'
  }
};
