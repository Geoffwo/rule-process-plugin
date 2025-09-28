function writingRules(inputArray,outputNodeTemplate) {
  // console.log(inputArray);

  // 生成数组
  const result = []

  // 找到java配置文件
  const jsonFile = inputArray.find(info => info.base==="java.json")

  if(!jsonFile){
    //给出json模板
    const jsonTemplate = `
{
  "controller": {
    "name": "DemoContorller",
    "mapping": "demo",
    "description": "控制层配置",
    "service": [
      {
        "name": "DemoService",
        "value": "demoService"
      }
    ],
    "methods": [
      {
        "name": "singleMapMethod",
        "description": "测试-返回对象",
        "return": {
          "type":"Result",
          "service": "demoService"
        },
        "annotation": "@PostMapping",
        "parameters": [
          {
            "name": "@RequestBody JSONObject",
            "value": "para"
          },
          {
            "name": "HttpServletRequest",
            "value": "request"
          }
        ],
        "exception": ["AppException"]
      },
      {
        "name": "listMapMethod",
        "description": "测试-返回对象数组",
        "return": {
          "type":"Result",
          "service": "demoService"
        },
        "annotation": "@PostMapping",
        "parameters": [
          {
            "name": "@RequestBody JSONObject",
            "value": "para"
          },
          {
            "name": "HttpServletRequest",
            "value": "request"
          }
        ],
        "exception": ["AppException"]
      },
      {
        "name": "pageMethod",
        "description": "测试-返回分页数据",
        "return": {
          "type":"Result",
          "service": "demoService"
        },
        "annotation": "@PostMapping",
        "parameters": [
          {
            "name": "@RequestBody JSONObject",
            "value": "para"
          },
          {
            "name": "HttpServletRequest",
            "value": "request"
          }
        ],
        "exception": ["AppException"]
      }
    ]

  },
  "service": {
    "name": "DemoService",
    "methods": [
      {
        "name": "singleMapMethod",
        "return": "Map<String, Object>",
        "parameters": [
          {
            "name": "JSONObject",
            "value": "para"
          },
          {
            "name": "HttpServletRequest",
            "value": "request"
          }
        ],
        "exception": ["AppException"]
      },
      {
        "name": "listMapMethod",
        "return": "List<Map<String, Object>>",
        "parameters": [
          {
            "name": "JSONObject",
            "value": "para"
          },
          {
            "name": "HttpServletRequest",
            "value": "request"
          }
        ],
        "exception": ["AppException"]
      },
      {
        "name": "pageMethod",
        "return": "Map<String, Object>",
        "parameters": [
          {
            "name": "JSONObject",
            "value": "para"
          },
          {
            "name": "HttpServletRequest",
            "value": "request"
          }
        ],
        "exception": ["AppException"]
      }
    ]
  },
  "serviceImpl": {
    "name": "DemoServiceImpl",
    "implements": "DemoService",
    "dao": [],
    "methods": [
      {
        "name": "singleMapMethod",
        "returnType": "singleMap",
        "description": "returnType类型不同，常用方法体不同，固定模式，singleMap/listMap/page",
        "body": {
          "params": [
            {
              "source": "para",
              "type": "String",
              "name": "screenType",
              "method": "getString"
            }
          ],
          "sqlOptions": {
            "sql": "select now() dateNow, ? from dual where 1=1 ",
            "sqlParams": ["screenType"],
            "sqlDecides": [
              {
                "sql": "and now() != ?",
                "sqlParam": "screenType",
                "sqlDecide": "StringUtils.isNotBlank(screenType)"
              }
            ],
            "sqlSuffix": "order by dateNow"
          }
        },
        "parameters": [
          {
            "name": "JSONObject",
            "value": "para"
          },
          {
            "name": "HttpServletRequest",
            "value": "request"
          }
        ],
        "exception": ["AppException"]
      },
      {
        "name": "listMapMethod",
        "returnType": "listMap",
        "description": "returnType类型不同，常用方法体不同，固定模式，singleMap/listMap/page",
        "body": {
          "params": [
            {
              "source": "para",
              "type": "String",
              "name": "screenType",
              "method": "getString"
            }
          ],
          "sqlOptions": {
            "sql": "select now() dateNow, ? from dual where 1=1 ",
            "sqlParams": ["screenType"],
            "sqlDecides": [
              {
                "sql": "and now() != ?",
                "sqlParam": "screenType",
                "sqlDecide": "StringUtils.isNotBlank(screenType)"
              }
            ],
            "sqlSuffix": "order by dateNow"
          }
        },
        "parameters": [
          {
            "name": "JSONObject",
            "value": "para"
          },
          {
            "name": "HttpServletRequest",
            "value": "request"
          }
        ],
        "exception": ["AppException"]
      },
      {
        "name": "pageMethod",
        "returnType": "page",
        "description": "returnType类型不同，常用方法体不同，固定模式，singleMap/listMap/page",
        "body": {
          "params": [
            {
              "source": "para",
              "type": "String",
              "name": "screenType",
              "method": "getString"
            }
          ],
          "sqlOptions": {
            "source": "para",
            "sql": "select now() dateNow, ? from dual where 1=1 ",
            "sqlParams": ["screenType"],
            "sqlDecides": [
              {
                "sql": "and now() != ?",
                "sqlParam": "screenType",
                "sqlDecide": "StringUtils.isNotBlank(screenType)"
              }
            ],
            "sqlSuffix": "order by dateNow"
          }
        },
        "parameters": [
          {
            "name": "JSONObject",
            "value": "para"
          },
          {
            "name": "HttpServletRequest",
            "value": "request"
          }
        ],
        "exception": ["AppException"]
      }
    ]
  }
}
`
    return [{ ...outputNodeTemplate, fileName:`java`,normExt:'json',content: jsonTemplate }];

  }

  // 获取信息
  const content = JSON.parse(jsonFile.content);

  // 定义模块路径映射（统一管理各层路径，便于后续修改）
  const MODULE_PATHS = {
    controller: 'controller',
    service: 'service',
    serviceImpl: 'service/impl' // 示例：ServiceImpl通常放在service的子目录impl中
  };

  // 提取通用文件生成函数（减少重复逻辑，统一处理路径、文件名和内容）
  const generateModuleFile = (moduleConfig, moduleType, templateFn) => {
    // 校验模块配置是否存在
    if (!moduleConfig) {
      console.warn(`跳过生成${moduleType}：配置不存在`);
      return null;
    }

    // 生成模块目录路径（基于输出根路径 + 模块专属路径）
    const moduleDir = `${outputNodeTemplate.path}/${MODULE_PATHS[moduleType]}`;

    // 生成文件内容
    const fileContent = templateFn(moduleConfig);
    if (!fileContent) {
      console.warn(`跳过生成${moduleType}：模板生成失败`);
      return null;
    }

    console.log('moduleConfig',moduleConfig);
    // 返回完整的文件信息对象
    return {
      ...outputNodeTemplate,
      path: moduleDir,        // 模块专属目录
      fileName: moduleConfig.name,  // 文件名（使用配置中的name）
      normExt: 'java',        // 文件后缀
      content: fileContent    // 生成的文件内容
    };
  };

  //获取controller层配置
  const controllerFile = generateModuleFile(
      content.controller,
      'controller',
      controllerTemplate
  );
  if (controllerFile) {
    result.push(controllerFile);
  }

  // 生成Service文件（复用同一函数，仅需传入不同参数）
  const serviceFile = generateModuleFile(
      content.service,
      'service',
      serviceTemplate
  );
  if (serviceFile) {
    result.push(serviceFile);
  }

  // 生成ServiceImpl文件
  const serviceImplFile = generateModuleFile(
      content.serviceImpl,
      'serviceImpl',
      serviceImplTemplate
  );
  if (serviceImplFile) {
    result.push(serviceImplFile);
  }

  // 返回结果对象
  return result;
}

const controllerTemplate = (controller) =>{
  // 遍历service数组，生成每个service对应的注解和变量定义
  const serviceAttributes = controller.service.map(service =>{
    return `    
     @Resource
     private ${service.name} ${service.value};`
  }).join('\n');

  // 遍历methods数组，生成每个methods对应的方法
  const controllerMethods = controller.methods.map(method =>{
    // 遍历每个参数，拼接成 "name value" 的形式
    const paramParts = method.parameters.map(param => `${param.name} ${param.value}`).join(', ');
    // 形参
    const params = method.parameters.map(param=>param.value).join(', ');
    //异常
    const exceptions=method.exception.join(', ');

    return `    
    ${method.annotation}("/${method.name}")
    @ApiOperation(value = "${method.description}", notes = "必须经过了OAuth授权")
    public ${method.return.type} ${method.name}(${paramParts}) throws ${exceptions} {
        return new ${method.return.type}(${method.return.service}.${method.name}(${params}));
    }`
  }).join('\n');


  return `
@Slf4j 
@RestController
@RequestMapping("/${controller.mapping}")
@Api(value = "${controller.mapping}", tags = {"${controller.description}"})  
public class ${controller.name} {
    ${serviceAttributes}
    
    ${controllerMethods}
} 
`;
}

const serviceTemplate = (service) =>{
  const serviceMethods = service.methods.map(method =>{
    // 遍历每个参数，拼接成 "name value" 的形式
    const paramParts = method.parameters.map(param => `${param.name} ${param.value}`).join(', ');
    //异常
    const exceptions=method.exception.join(', ');
    return ` 
    ${method.return} ${method.name}(${paramParts}) throws ${exceptions};   
    `
  }).join('\n')

  return `
public interface ${service.name} {
    ${serviceMethods}
} 
`;
}

const serviceImplTemplate = (serviceImpl) =>{
  // 遍历dao数组，生成每个dao对应的注解和变量定义
  const daoAttributes = serviceImpl.dao.map(dao =>{
    return `    
     @Resource
     private ${dao.name} ${dao.value};`
  }).join('\n');

  const serviceImplMethods = serviceImpl.methods.map(method =>{
    // 遍历每个参数，拼接成 "name value" 的形式
    const paramParts = method.parameters.map(param => `${param.name} ${param.value}`).join(', ');

    //异常
    const exceptions=method.exception.join(', ');

    if('singleMap' === method.returnType){//返回对象
      return singleMap(method,paramParts,exceptions)
    }

    if('listMap' === method.returnType){//返回对象数组
      return listMap(method,paramParts,exceptions)
    }

    if('page' === method.returnType){//返回分页数据
      return page(method,paramParts,exceptions)
    }
  }).join('\n')

  return `
@Service
public class ${serviceImpl.name} implements ${serviceImpl.implements} {
    ${daoAttributes}
    
    ${serviceImplMethods}
}
`;
}

const singleMap = (method,paramParts,exceptions)=>{
  // 遍历每个参数，拼接成 String dataDate = para.getString("dataDate"); 的形式
  const params = method.body.params && method.body.params.map(param => `${param.type} ${param.name} = ${param.source}.${param.method}("${param.name}");`).join('\n');

  // list.add(dataDate);
  const sqlParams = method.body.sqlOptions.sqlParams && method.body.sqlOptions.sqlParams.map(param => `list.add(${param});`).join('\n');

  //拼接条件
  const sqlDecides = method.body.sqlOptions.sqlDecides && method.body.sqlOptions.sqlDecides.map(param => {
    return `
    if (${param.sqlDecide}) {
      sb.append(" ${param.sql} ");
      list.add(${param.sqlParam});
    }`
  }).join('\n');

  return ` 
  @Override
  public Map<String, Object> ${method.name}(${paramParts}) throws ${exceptions} {
    ${params}

    Sql sql = new Sql();
    List<Object> list = new ArrayList<>();
    StringBuilder sb = new StringBuilder();
    sb.append("${method.body.sqlOptions.sql}");
    ${sqlParams}
    ${sqlDecides}
    sb.append("${method.body.sqlOptions.sqlSuffix}");
    
    sql.setSql(sb.toString());
    sql.setSqlParas(list);
    DataStore ds = sql.executeQuery();

    // 处理查询结果
    Map<String, Object> resultMap = new HashMap<>();
    if (ds != null && ds.rowCount() > 0) {
       // 获取第一行数据
       DataObject dataObject = ds.get(0);
       if (dataObject != null) {
           resultMap.putAll(dataObject);
       }
    }

    return resultMap;
  }
`;
}

const listMap = (method, paramParts, exceptions) => {
  // 遍历每个参数，拼接成 String dataDate = para.getString("dataDate"); 的形式
  const params = method.body.params && method.body.params.map(param => `${param.type} ${param.name} = ${param.source}.${param.method}("${param.name}");`).join('\n');

  // list.add(dataDate);
  const sqlParams = method.body.sqlOptions.sqlParams && method.body.sqlOptions.sqlParams.map(param => `list.add(${param});`).join('\n');

  //拼接条件
  const sqlDecides = method.body.sqlOptions.sqlDecides && method.body.sqlOptions.sqlDecides.map(param => {
    return `
    if (${param.sqlDecide}) {
      sb.append(" ${param.sql} ");
      list.add(${param.sqlParam});
    }`
  }).join('\n');

  return `
  @Override
  public List<Map<String, Object>> ${method.name}(${paramParts}) throws ${exceptions} {
    ${params}
    Sql sql = new Sql();
    List<Object> list = new ArrayList<>();
    StringBuilder sb = new StringBuilder();
    sb.append("${method.body.sqlOptions.sql}");
    ${sqlParams}
    ${sqlDecides}
    sb.append("${method.body.sqlOptions.sqlSuffix}");
    
    sql.setSql(sb.toString());
    sql.setSqlParas(list);
    DataStore ds = sql.executeQuery();

    List<Map<String, Object>> resultList = new ArrayList<>();
    if (ds != null) {
      for (int i = 0; i < ds.rowCount(); i++) {
        DataObject dataObject = ds.get(i);
        resultList.add(new HashMap<>(dataObject));
      }
    }
    return resultList;
  }
  `;
};

const page = (method, paramParts, exceptions) => {
  // 遍历每个参数，拼接成 String dataDate = para.getString("dataDate"); 的形式
  const params = method.body.params && method.body.params.map(param => `${param.type} ${param.name} = ${param.source}.${param.method}("${param.name}");`).join('\n');

  // list.add(dataDate);
  const sqlParams = method.body.sqlOptions.sqlParams && method.body.sqlOptions.sqlParams.map(param => `list.add(${param});`).join('\n');

  //拼接条件
  const sqlDecides = method.body.sqlOptions.sqlDecides && method.body.sqlOptions.sqlDecides.map(param => {
    return `
    if (${param.sqlDecide}) {
      sb.append(" ${param.sql} ");
      list.add(${param.sqlParam});
    }`
  }).join('\n');

  return `
  @Override
  public Map<String, Object> ${method.name}(${paramParts}) throws ${exceptions} {
    ${params}
    Sql sql = new Sql();
    List<Object> list = new ArrayList<>();
    StringBuilder sb = new StringBuilder();
    sb.append("${method.body.sqlOptions.sql}");
    ${sqlParams}
    ${sqlDecides}
    sb.append("${method.body.sqlOptions.sqlSuffix}");
    
    sql.setSql(sb.toString());
    sql.setSqlParas(list);

    MySqlPage page = new MySqlPage(${method.body.sqlOptions.source});
    return page.queryPage(sql);
  }
  `;
};


// module.exports = writingRules;

module.exports = {
  name: 'generateJavaMode',
  version: '1.0.0',
  process: writingRules,
  description: '首次默认创建java.json模板，基于java.json配置文件信息，生成通用java框架,可根据需求自行变更或扩展',
  notes:{
    node:'18.20.4',
  },
  input: {
    normExt: 'java.json文件'
  },
  output: {
    normExt: 'java文件',
    format: "生成java框架对应的格式数据"
  },
};