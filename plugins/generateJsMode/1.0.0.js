function writingRules(inputArray,outputNodeTemplate) {
  // console.log(inputArray);

  // 筛选所有js文件并获取文件名
  const jsFiles = inputArray.filter(info => info.path.endsWith('.js'))
      .map(info => info.name);//获取文件名


  const importStatements = jsFiles.map(file => {// 生成静态导入语句数组
    return `import ${file} from '@/js/${file}.js';`;
  }).join('\n');// 生成静态导入语句

  const modulesObjects = jsFiles.map(file => {// 生成模块对象数组
    return `  ${file},`;
  }).join('\n');// 生成模块对象


  // 生成完整的文件内容 ``会保留空格和换行，所以``之间不能格式化
  const fileContent = fileTemplate({
    importStatements,
    modulesObjects
  })

  const outputNode = outputNodeTemplate
  outputNode.content = fileContent
  outputNode.fileName = 'jsMode'
  outputNode.normExt = 'js'
  // 返回结果对象
  return [{...outputNodeTemplate,fileName:'jsMode',normExt:'js',content:fileContent}];
}

/**
 * 生成文件内容的模板函数
 * @param {object} options - 包含生成文件所需的信息的对象
 * @param {string} options.importStatements - 静态导入语句
 * @param {string} options.modulesObjects - 模块对象内容
 * @returns {string} - 生成的文件内容
 */
const fileTemplate = ({importStatements, modulesObjects}) =>
`${importStatements}

const module = {
${modulesObjects}
};

export default module;
`;

// module.exports = writingRules;

module.exports = {
  name: 'generateJsMode',
  version: '1.0.0',
  process: writingRules,
  description: '自动生成工具：扫描目录中的JS文件，自动生成模块化导入和导出配置',
  notes:{
    node:'14.18.0',
  },
  input: {
    normExt: 'js文件'
  },
  output: {
    normExt: 'js文件',
    format: "生成fileTemplate对应的格式数据"
  },
};