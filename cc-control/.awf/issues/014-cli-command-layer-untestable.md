---
id: "014"
title: "新 CLI 是 CJS：vi.mock 不拦 require，命令层执行路径无法单测"
status: open
labels: [testability, cli, tech-debt]
assignee: null
milestone: null
priority: medium
created: 2026-09-13
updated: 2026-09-13
deps: []
related: ["T1-113", "007"]
---

# 新 CLI 是 CJS：vi.mock 不拦 require，命令层执行路径无法单测

**一句话**：旧 CLI 是 ESM（`"type":"module"` + `.js`），旧测试靠 `vi.mock` 拦截它的 `import`；
新 CLI 全是 `.cjs` + `require()`，而 **vitest 不拦截 CJS 模块里的 `require`** —— 于是「拦住进程/网络
再断言」的整类测试在新树上不成立，收口时这批测试整体失效。

## 一、现场（2026-09-13 旧树收口）

`tests/unit/cli-aux.test.js` 旧版 24 条断言，全部建立在拦截之上（`vi.mock('.../ui/log.js')` 拦日志、
`vi.mock('node:child_process')` 拦 exec/spawn）。改指新树后 **24/24 全红**，其中
`plugin install --scope global` 一路真跑到了 `claude plugin uninstall figma@claude-plugins-official`
（mock 没拦住的直接证据）。同类受影响：`run.test.js`(16)、`init.test.js`(6)、`plugin-config.test.js`(1)。

## 二、根因（机制，不是配置）

最小复现（两条都失败）：

```js
vi.mock('../../server/adapters/ports.cjs', () => ({ profile: { installProfile: spy } }));
import { pluginCommand } from '../../cli/commands/plugin.cjs';
await pluginCommand('install');
// → spy 调用次数 0（真实现跑了）
```

- `vi.mock('node:child_process', …)` 同样拦不住 `.cjs` 里的 `require('node:child_process')`；
- 加 `server.deps.inline: [/cli\//, /server\//]` 无效；
- 对照：`src/cli/*.js`（ESM）配同样的 `vi.mock` 是**有效**的 —— 这正是旧测试一直能跑的原因。

**新树自己也印证了这个约束**：`tests/unit/server-*.test.js` / `cli-thin` / `batch-transport` 等
18 个文件**零 `vi.mock`**，一律走「纯函数 / 真临时目录 / 显式注入端口」。

## 三、本轮处置（不加产线缝）

按用户裁定：**不给 CLI 加注入缝**，能真测的真测，其余登记在此。

`cli-aux.test.js` 已重写为 19 条真链路断言（plugin local 真落盘并断言文件内容、runPerSpec 注入假 run、
server 只 stub 全局 fetch、open 用命令自带的可注入 `browser` 参数换成无副作用的 `true`、attach 只走
「会话不存在 → 报错退出」）。**比旧版更强**，但以下执行路径无单测：

| 未覆盖 | 说明 |
|---|---|
| `globalPlugin` 的 `claude plugin marketplace add` / `install` / `uninstall` 真执行 | 只单测了逐 spec 的批处理逻辑（`runPerSpec`） |
| `marketplace add` 失败路径 | 现为「失败即中止」，无断言 |
| `serverCommand('start')` 的 spawn 分支 | 只测了「已在运行」「旧版占用报错」两条分支 |
| `openCommand` 的 spawn 参数与浏览器选择 | 只断言了打印出的 URL |
| `attachCommand` 成功路径 | 需要真 tmux 会话 |

**现有兜底**：`npm run test:real`（真机 regression 的 `init` / `mcp` / `web` / `lifecycle` case）+
手测。也就是说这些路径**有真机覆盖，但没有可回归的单测**。

## 四、出路（择一，待定）

1. **CLI 改回 ESM** —— 恢复 `vi.mock` 能力，测试写法与旧树一致。代价：`cli/` 全面改后缀/导入语法，
   且 `require` 与 `import` 混用会带来互操作约束。
2. **加注入缝** —— 照 `global.__CC_TMUX__` / `global.__CC_RUN_HOST_DEPS__` 的先例，让命令接受可注入
   deps（ports / exec / spawn / fetch）。代价：产线代码改一圈，与「薄客户端」定位有一定拉扯。
3. **维持现状** —— 命令层只靠 integration + `test:real`，本 issue 长期挂着。

倾向：先观察一轮真实使用；若命令层再出故障，优先考虑 1（一次性收益最大，且能顺带消掉
「ESM/CJS 具名导出」那类坑，见 `.awf/bugs` 中该形态的历史事故）。

## 五、关联

- 受影响测试：`tests/unit/cli-aux.test.js`（已重写）、`run.test.js`、`init.test.js`、`plugin-config.test.js`
- 产线：`cli/commands/*.cjs`、`cli/lib/*.cjs`
- 相关记忆：`.awf/issues/007`（eval 命令命名空间漂移 —— 同属「测试与实现静默脱节」）
