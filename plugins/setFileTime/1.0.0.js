const { exec } = require('child_process');
const fs = require('fs').promises;
const os = require('os');
const path = require("path");

/**
 * 通配符简单匹配，支持 *
 * @param {string} str 待匹配字符串（文件名）
 * @param {string} pattern 模式，如 *.pdf
 * @returns {boolean}
 */
function wildcardMatch(str, pattern) {
    const regStr = '^' + pattern.replace(/\*/g, '.*') + '$';
    return new RegExp(regStr).test(str);
}

async function setFileTimes(filePath, targetDate) {
    const timestampSec = Math.floor(targetDate.getTime() / 1000);
    await fs.utimes(filePath, timestampSec, timestampSec);
    if (os.platform() === 'win32') {
        await new Promise((resolve, reject) => {
            const isoStr = targetDate.toISOString();
            const psCmd = `powershell "(Get-Item '${filePath.replace(/'/g, "''")}').CreationTime='${isoStr}'"`;
            exec(psCmd, e => e ? reject(e) : resolve())
        })
    }
}

function defaultConfigTemplate(){
    return {
        "defaultDateTime": "2025-02-10 09:00:00",//默认修改值
        "skipUnMatch": false,//是否跳过 未匹配的文件 修改
        "timeRandomOffsetMinute": 120,//随机时间偏移±120
        "rules": [
            {
                "pattern": "*.pdf",
                "targetDateTime": "2025-01-05 14:20:00"
            },
            {
                "pattern": "photo_*.jpg",
                "targetDateTime": "2024-12-20 10:10:00"
            },
            {
                "pattern": "readme.md",
                "targetDateTime": "2025-03-01 17:30:00"
            }
        ],
        "note": "pattern支持*通配符；skipUnMatch=true不处理未匹配文件；defaultDateTime未命中规则时使用；时间格式 yyyy‑MM‑dd HH:mm:ss"
    };
}
async function writingRules(inputArray, outputNodeTemplate) {
    const outputDir = outputNodeTemplate.path;
    const inputPath = path.join(outputDir, '../inputDir');

    const configFileItem = inputArray.find(item => item.normExt === "json" && item.name === "config");

    console.log('configFileItem',configFileItem);
    if (!configFileItem) {
        return [
            { ...outputNodeTemplate, fileName: "tip", normExt: "txt", content: "错误: 未找到 config.json，已输出模板配置文件，请修改规则后重新运行" },
            { ...outputNodeTemplate, path: inputPath, fileName: "config", normExt: "json", content: JSON.stringify(defaultConfigTemplate(), null, 2) }
        ];
    }

    // stream 模式下用 node.stream() 读取文件流
    const stream = configFileItem.stream();
    let configContent = '';

    // 拼接流数据
    for await (const chunk of stream) {
        configContent += chunk;
    }

    const userConfig = JSON.parse(configContent);

    // 读取配置参数，兼容缺省
    const { rules = [], defaultDateTime, skipUnMatch = false,timeRandomOffsetMinute } = userConfig;
    const content = [];

    for (const item of inputArray) {
        const fileName = item.base;
        const path = item.path;
        const hitRule = rules.find(rule => wildcardMatch(fileName, rule.pattern));

        // 业务：没有匹配规则，且配置要求跳过，则记录日志，直接处理下一个文件
        if (!hitRule && skipUnMatch) {
            content.push({
                fileName,
                content: {success: true,skip: true,path: path,hitPattern: "unmatch‑skip",msg: "未命中任何规则，已跳过修改时间"}
            });
            continue;
        }

        let targetDate = new Date(defaultDateTime);
        let hitPattern = "default";

        if (hitRule) {
            targetDate = new Date(hitRule.targetDateTime);
            hitPattern = hitRule.pattern;
        }

        // 校验时间合法性
        if (isNaN(targetDate.getTime())) {
            content.push({
                fileName: fileName,
                content: {success: false,skip: false,path: path,hitPattern,err: "目标时间格式非法，请检查ISO时间字符串"}
            });
            continue;
        }

        // ±分钟随机偏移
        if(timeRandomOffsetMinute){
            const offsetMin = (Math.random()*2-1)*timeRandomOffsetMinute;
            targetDate.setMinutes(targetDate.getMinutes()+offsetMin);
        }

        // 执行修改
        try {
            await setFileTimes(item.path, targetDate);
            content.push({
                fileName: fileName,
                content: {success: true,skip: false,path: item.path,hitPattern,target: targetDate.toLocaleString()}
            })
        } catch (e) {
            content.push({
                fileName: fileName,
                content: {success: false,skip: false,path: item.path,hitPattern,err: e.message}
            })
        }
    }

    return [{
        ...outputNodeTemplate,
        fileName: `result`,
        normExt: 'json',
        content: JSON.stringify(content, null, 2)
    }];
}

module.exports = {
    name: 'setFileTime',
    version: '1.0.0',
    mode: 'stream', // 声明为流式模式
    process: writingRules,
    description: "配置规则表，不同文件名匹配不同时间；支持通配符*；可跳过未匹配文件。执行结束后，建议手动右键->刷新",
    notes: {
        node: '18.20.4'
    },
    input: {
        normExt: 'config.json'
    },
    output: {
        normExt: 'result.json'
    },
};
