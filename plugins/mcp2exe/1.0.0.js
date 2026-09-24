/**
 * rule05 —— MCP 服务生成器（生成器规则：不消费输入，产出独立服务脚本）
 *
 * 运行本规则后自动完成两件事：
 *  1. 依赖下载：SERVER_SOURCE 中的 require('@modelcontextprotocol/sdk/...') 字面量
 *     被框架预安装扫描器（preprocess/modules.js）提取，配合 rely 的版本号，
 *     在 process 执行前自动 npm install 到宿主 cwd/node_modules（已装则跳过）；
 *  2. 生成服务：落盘 cwd/mcp/mcp-server.js —— 自包含的独立 MCP 服务脚本，
 *     `node mcp/mcp-server.js` 直接拉起。工具回调引擎的方式在生成时烤入绝对路径
 *     （node 可执行文件 + 引擎入口脚本 + 宿主目录），直接 spawn 不经 shell，
 *     不做运行时 PATH 查找——换机器/移动目录后重跑本规则或手改生成文件顶部常量即可；
 *     子进程 stdio 全量捕获，不污染 MCP 协议流。
 *
 * 注意：loadRuleFiles 会把 -r 传入的规则文件展开为整个规则目录按序执行，
 * 本规则放任意仅含本文件的目录中也可单独运行。
 */
const path = require('path');

// 生成的独立 MCP 服务源码。
// 约定：内部不使用反引号与 ${}（外层用模板字面量包裹），仅用单引号 + 拼接；
// 反斜杠依赖 String.raw 原样保留。源码中的 SDK require 字面量同时承担
// "依赖声明"职责——框架扫描 require 提取包名，rely 提供版本号触发自动安装。
// 占位符 __ENGINE_BIN__/__ENGINE_SCRIPT__/__HOST_DIR__ 在模板末尾替换为
// 生成时（本进程）的绝对路径：node 可执行文件、引擎入口脚本（pkg 打包时为 null）、
// 宿主目录。
const SERVER_SOURCE = String.raw`

/**
 * mcp/mcp-server.js —— 由 rule-process 规则 rule05 自动生成，请勿手改（重跑规则会覆盖）
 * 独立 MCP 服务脚本：node 直接拉起的常驻 service。
 *
 * 设计：
 *  1. 工具（run_rule / list_plugins / install_plugin）通过 spawn 引擎入口子进程回调，
 *     引擎的 node 可执行文件与入口脚本在生成时以绝对路径烤入（见下方 ENGINE_* 常量），
 *     不做 PATH 查找；换环境后重跑 rule05 或手动修改常量即可。
 *     子进程 stdio 全量捕获，绝不写本进程 stdout——MCP 协议流全程干净。
 *  2. 依赖 @modelcontextprotocol/sdk 已由 rule05 的 rely 自动下载到宿主 node_modules/
 *     （脚本拷贝到其他机器时先执行: npm i @modelcontextprotocol/sdk）
 *
 * 启动：
 *   node mcp/mcp-server.js
 */
const { spawn } = require('child_process');

// MCP SDK 是 ESM，CJS 项目用动态 import 引入
async function loadSdk() {
    const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    const { ListToolsRequestSchema, CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
    return { Server, StdioServerTransport, ListToolsRequestSchema, CallToolRequestSchema };
}

// ---------- 引擎入口（生成时烤入的绝对路径，换环境时改这里或重跑 rule05） ----------
const ENGINE_BIN = __ENGINE_BIN__;        // node 可执行文件（pkg 打包的引擎即 exe 本体）
const ENGINE_SCRIPT = __ENGINE_SCRIPT__;  // 引擎入口脚本（pkg 打包时为 null，exe 直接接参数）
const HOST_DIR = __HOST_DIR__;            // 宿主目录：引擎以它为 cwd 运行（config.ini / node_modules 所在）

/**
 * 调用 rule-process 引擎并全量捕获输出
 * 直接 spawn node + 入口脚本，不经 shell——参数数组原样传递，无 .cmd / 引号转义问题
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function callCli(args) {
    return new Promise((resolve, reject) => {
        const cliArgs = ENGINE_SCRIPT ? [ENGINE_SCRIPT].concat(args) : args;
        const child = spawn(ENGINE_BIN, cliArgs, { cwd: HOST_DIR, windowsHide: true });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', d => { stdout += d; });
        child.stderr.on('data', d => { stderr += d; });
        child.on('error', reject); // 可执行文件不存在等 spawn 失败
        child.on('close', code => resolve({ code, stdout, stderr }));
    });
}

// ---------- 工具实现 ----------
async function runRule(args) {
    const cliArgs = ['run'];
    if (args.input) cliArgs.push('-i', args.input);
    if (args.output) cliArgs.push('-o', args.output);
    if (args.rule) cliArgs.push('-r', args.rule);
    if (args.config) cliArgs.push('-c', args.config);

    const { code, stdout, stderr } = await callCli(cliArgs);
    const text = '规则处理完成（退出码 ' + code + '）。\n规则: ' + args.rule +
        (args.input ? '\n输入: ' + args.input : '') +
        (args.output ? '\n输出: ' + args.output : '') +
        '\n\n' + (stdout.trim() || stderr.trim());
    return { content: [{ type: 'text', text }], isError: code !== 0 };
}

async function listPlugins() {
    const { code, stdout, stderr } = await callCli(['list', '-t', 'local']);
    const text = (stdout + stderr).trim() || '当前未安装任何插件。';
    return { content: [{ type: 'text', text }], isError: code !== 0 };
}

async function installPlugin(args) {
    const plugins = args.plugins || [];
    if (!plugins.length) return { content: [{ type: 'text', text: '缺少必填参数 plugins' }], isError: true };
    const cliArgs = ['install'].concat(plugins, ['-s', args.source || 'gitee']);
    const { code, stdout, stderr } = await callCli(cliArgs);
    return {
        content: [{ type: 'text', text: '插件安装完成（退出码 ' + code + '）: ' + plugins.join(', ') + '\n\n' + (stdout + stderr).trim() }],
        isError: code !== 0
    };
}

// ---------- MCP Server 组装 ----------
const TOOLS = [
    {
        name: 'run_rule',
        description: '执行规则处理（等效于 CLI: rule-process run -r <rule> -i <input> -o <output>）。' +
            '传入规则目录/文件（可选）、输入目录（可选）、输出目录（可选），执行后返回 CLI 完整输出。',
        inputSchema: {
            type: 'object',
            properties: {
                rule: { type: 'string', description: '（可选）规则文件或规则目录的绝对路径' },
                input: { type: 'string', description: '（可选）输入目录绝对路径，默认使用 baseConfig.input' },
                output: { type: 'string', description: '（可选）输出目录绝对路径，默认使用 baseConfig.output' },
                config: { type: 'string', description: '（可选）配置文件路径（.js/.ini），用于覆盖默认配置' }
            },
            required: []
        }
    },
    {
        name: 'list_plugins',
        description: '列出本地已安装的插件（规则）清单，返回 name 与 version。',
        inputSchema: { type: 'object', properties: {} }
    },
    {
        name: 'install_plugin',
        description: '安装插件（等效于 CLI: rule-process install <plugins...>）。',
        inputSchema: {
            type: 'object',
            properties: {
                plugins: { type: 'array', items: { type: 'string' }, description: '插件名列表，例如 ["xlsx2json@1.0.0"]' },
                source: { type: 'string', description: '（可选）下载源，gitee/github，默认 gitee' }
            },
            required: ['plugins']
        }
    }
];

async function start() {
    const { Server, StdioServerTransport, ListToolsRequestSchema, CallToolRequestSchema } = await loadSdk();

    const server = new Server(
        { name: 'rule-process', version: '1.0.0' },
        { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        try {
            switch (name) {
                case 'run_rule': return await runRule(args || {});
                case 'list_plugins': return await listPlugins();
                case 'install_plugin': return await installPlugin(args || {});
                default:
                    return { content: [{ type: 'text', text: '未知工具: ' + name }], isError: true };
            }
        } catch (e) {
            return { content: [{ type: 'text', text: '工具[' + name + ']执行失败: ' + e.message }], isError: true };
        }
    });

    await server.connect(new StdioServerTransport());
    return server;
}

start().catch(err => {
    // 任何错误都走 stderr，绝不写 stdout（否则破坏 MCP 协议帧）
    process.stderr.write('[mcp-server] 启动失败: ' + (err && err.stack ? err.stack : err) + '\n');
    process.exit(1);
});

/* 客户端json配置（如果未配置环境变量，command需要配置node绝对路径地址）
{
  "mcpServers": {
    "rule-process": {
      "command": "node",
      "args": [
        __MCP_SERVER__
      ]
    }
  }
}
*/
`
    // 占位符替换为生成时的绝对路径（函数形式避免替换串中的 $ 序列被特殊解释）
    .replace('__ENGINE_BIN__', () => JSON.stringify(process.execPath))
    .replace('__ENGINE_SCRIPT__', () => process.pkg ? 'null' : JSON.stringify(path.resolve(process.argv[1])))
    .replace('__HOST_DIR__', () => JSON.stringify(process.cwd()))
    .replace('__MCP_SERVER__', () => JSON.stringify(path.join(process.cwd(), 'mcp', 'mcp-server.js')));

function writingRules(inputArray, outputNodeTemplate, ctx) {
    const mcpDir = path.join(process.cwd(), 'mcp'); // 宿主根目录下的 mcp/（与 examples/、config.ini 平级）

    console.log('生成独立 MCP 服务 -> ' + path.join(mcpDir, 'mcp-server.js'));

    return [{
        ...outputNodeTemplate,
        path: mcpDir,
        fileName: 'mcp-server',
        normExt: 'js',
        content: SERVER_SOURCE
    }];
}

module.exports = {
    name: 'mcp2exe',
    version: '1.0.0',
    process: writingRules,
    description: 'MCP 服务生成器(rule-process专属)：rely 自动下载 @modelcontextprotocol/sdk，并生成宿主 mcp/mcp-server.js 独立服务脚本',
    rely: {
        '@modelcontextprotocol/sdk': '1.30.0'
    },
};
