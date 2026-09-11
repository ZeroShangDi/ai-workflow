# cc adapters（端口契约） — 功能文档

> 对应 WBS：W3-004（adapters/cc 工具适配收口）
> 源码：`src/adapters/ports.cjs`（唯一门）+ `src/adapters/{oneshot,tooling,interactive,probe,cc-shapes,mock}.cjs`
> 相关未收口实现：`src/server/host.cjs`、`src/server/hook-adapter.cjs`

## 功能描述

`src/adapters/` 是 Claude Code（cc）接入能力的**收口层**。目标（W3-004）：把 `claude` / `tmux`
等 cc 命令与进程接入从 cli/server/plugin MCP/scripts 各处迁入 adapters，外部源码只依赖
「端口契约」，不直连具体实现。

`src/adapters/ports.cjs` 是**进入 adapters 的唯一门**（T1-117）：

- 声明 7 端口名册 `PORT_CONTRACT`（`ports.cjs:42-90`）。
- 以工厂 `createCcAdapters()` 统一绑定已实现的端口（`ports.cjs:153-164`）。
- 以单端口句柄导出（`host` / `hook` / `oneshot` / `tooling` / `interactive` / `probe` / `ccShapes`，
  `ports.cjs:177-189`），供生产侧（`src/cli`、`src/server`）取用。
- 加载即执行契约自检 `assertPortContract()`（`ports.cjs:119`），未收口端口缺 `note`/`responsible`
  直接抛错。

生产消费者（均已改为经端口取用，不再直连具体 adapter 文件）：

| 消费者 | 取用方式 | 位置 |
|--------|----------|------|
| server | `const { ccShapes, oneshot: oneshotPort } = require('../adapters/ports.cjs')` | `src/server/server.cjs:22` |
| decision-gate | `const { ccShapes } = require('../adapters/ports.cjs')` | `src/server/decision-gate.cjs:48` |
| cli/init | `import { tooling } from '../adapters/ports.cjs'` | `src/cli/init.js:7`（`:71` 调 `tooling.claudeAvailable`） |
| cli/plugin | `import { tooling } from '../adapters/ports.cjs'` | `src/cli/plugin.js:8`（`:115/:121/:131` 调 `build*`/`buildMarketplaceAdd`） |
| cli/plan | `import { interactive } from '../adapters/ports.cjs'` | `src/cli/plan.js:5`（`:42` 调 `interactive.launchDialog`） |
| lib（注入式） | oneshot 端口由调用方注入，lib 不反向依赖 adapters | `src/lib/run-diagnosis.cjs:87`（缺注入即抛错） |

## 执行流程

```
生产侧 require/import 'src/adapters/ports.cjs'
  → 模块加载即跑 assertPortContract()（not-landed 缺 note/responsible → 抛错）
  → 二选一取用：
     ├─ createCcAdapters({ sessionName, bus, execFileSync, status })
     │     → 绑定 host/hook/oneshot/tooling/interactive/probe 六个端口（session 未收口，不绑）
     └─ 单端口句柄（host/hook/oneshot/tooling/interactive/probe/ccShapes）
```

`createCcAdapters()` 内部（`ports.cjs:153-164`）：

```
const host = createHost({ sessionName, execFileSync });   // ← src/server/host.cjs（未收口，见下）
return {
  host,
  hook: createHookAdapter({ emit }),                      // ← src/server/hook-adapter.cjs（未收口，见下）
  oneshot: PORT_IMPLS.oneshot,                            // ← src/adapters/oneshot.cjs
  tooling: PORT_IMPLS.tooling,                            // ← src/adapters/tooling.cjs
  interactive: PORT_IMPLS.interactive,                    // ← { launchDialog } 包装 launchInteractiveClaude
  probe: createProbe({ host, status }),                   // ← src/adapters/probe.cjs
};
```

## 核心常量 / 配置

| 常量 | 值 | 说明 |
|------|-----|------|
| `PORT_CONTRACT` | 7 项数组 | 每项 `{ name, status, role, methods[] }`；`methods` 是端口对象上**真实存在**的方法（非愿望清单） |
| `PORT_NAMES` | `['host','hook','oneshot','tooling','interactive','probe','session']` | 端口名册（`ports.cjs:121`），与 `mock.cjs` 覆盖集一致 |
| `NON_PORT_TOOLS` | `[{ name: 'cc-shapes', file: 'src/adapters/cc-shapes.cjs', reason }]` | 明确裁决**不在**名册内的工具（`ports.cjs:101-103`） |
| `PORT_IMPLS` | `{ host, hook, oneshot, tooling, interactive, probe, ccShapes }` | 端口实现句柄映射（`ports.cjs:135-143`） |
| `status: 'factory'` | — | 已由 `createCcAdapters()` 绑定（6 个端口） |
| `status: 'not-landed'` | — | 未收口，**必须**同时给 `note` + `responsible`（当前仅 `session`） |

### 7 端口名册

| 端口 | status | role | 声明方法（`methods`） | 实现位置 |
|------|--------|------|----------------------|----------|
| `host` | factory | tmux 会话原语（会话名参数化 cc-<sid>） | `sessionName`、`hasSession()`、`sendText(text)`、`sendEnter()`、`sendCtrlC()`、`capture()` | **`src/server/host.cjs`（未收口）** |
| `hook` | factory | hook payload → 领域事件 | `hook(payload, ctx)` | **`src/server/hook-adapter.cjs`（未收口）** |
| `oneshot` | factory | 无状态 LLM 调用（claude -p） | `runOneShot()`、`spawnClaudeP()`、`claudePArgs()` | `src/adapters/oneshot.cjs` |
| `tooling` | factory | plugin 安装 / 市场运维（claude plugin …） | `install()`、`uninstall()`、`claudeAvailable()`、`buildMarketplaceAdd()`、`buildInstall()`、`buildUninstall()` | `src/adapters/tooling.cjs` |
| `interactive` | factory | plan 交互对话（terminal 直开 cc） | `launchDialog(opts)` | `src/adapters/interactive.cjs`（包装层） |
| `probe` | factory | w-monitor 外部会话侦查 | `inspect()` | `src/adapters/probe.cjs`（需 host 注入） |
| `session` | **not-landed** | claude 会话启动 / 收口 | `start({ projectRoot, sid })`、`stop()` | 无（live 走 `scripts/bootstrap.sh`） |

### `interactive` 端口是包装

模块 `interactive.cjs` 导出的是 `launchInteractiveClaude`，而端口面叫 `launchDialog` ——
`PORT_IMPLS.interactive = { launchDialog: (opts) => launchInteractiveClaude(opts) }`（`ports.cjs:140`）。
照契约写消费者的人只看 `launchDialog`，不认模块导出名。

### 为什么 `cc-shapes` 不是端口

`cc-shapes.cjs` 构造 cc 回写**形状**（Stop block、permissionDecision deny），是**纯数据函数**
（无副作用、无可替换性诉求），且已被领域代码直接消费（`server.cjs:477`、`decision-gate.cjs:88`）。
裁决理由记在 `NON_PORT_TOOLS`（`ports.cjs:101-103`）：端口 = 可替换的 cc 能力面（带会话/进程/外部依赖），
cc-shapes 不构成能力面；塞进名册会让「7 端口」口径失真。但它**仍经 `ports.cjs` 这道门出口**
（`PORT_IMPLS.ccShapes` / 导出项 `ccShapes`）——界线是「adapters 边界」，不是「只在名册里的才准出」。

### 加载时契约自检

`assertPortContract()`（`ports.cjs:109-117`）：遍历 `PORT_CONTRACT`，`status === 'factory'` 跳过；
非 factory 缺 `note` 或 `responsible` → 抛
`ports: 端口 <name> 状态为 <status>，必须带 note + responsible（不允许沉默的未收口）`。
模块顶层 `assertPortContract();`（`ports.cjs:119`）使任何加载 ports.cjs 的进程都会先过这道自检。
单测也用负面用例直接调它（`tests/unit/ports-contract.test.js`）。

## 函数清单

| 函数 | 说明 | 位置 |
|------|------|------|
| `assertPortContract(contract?)` | 契约自检；未收口缺 note/responsible 抛错；返回 true | `src/adapters/ports.cjs:109` |
| `createCcAdapters({ sessionName, bus, execFileSync, status })` | 绑定并返回 6 个已实现端口（不含 session） | `src/adapters/ports.cjs:153` |
| `createHost({ sessionName, execFileSync })` | host 端口工厂（tmux 原语） | `src/server/host.cjs:18`（经 ports.cjs 转出） |
| `createHookAdapter({ emit })` | hook 端口工厂（payload → 领域事件） | `src/server/hook-adapter.cjs:79`（经 ports.cjs 转出） |
| `claudePArgs` / `spawnClaudeP` / `runOneShot` | oneshot 端口三方法 | `src/adapters/oneshot.cjs:15/24/45` |
| `install` / `uninstall` / `claudeAvailable` / `build*` | tooling 端口 | `src/adapters/tooling.cjs:25/32/39/10/15/20` |
| `launchInteractiveClaude` / `projectSettingsPath` | interactive 模块导出（端口面经 `launchDialog` 包装） | `src/adapters/interactive.cjs:18/35` |
| `createProbe({ host, status })` | probe 端口工厂 | `src/adapters/probe.cjs:10` |
| `blockDecision` / `denyPermission` | cc-shapes 非端口工具 | `src/adapters/cc-shapes.cjs:18/23` |
| `createMockAdapters()` | 测试夹具（7 端口全量 + `calls` 记录 + `reset`） | `src/adapters/mock.cjs:12` |

## 接口 / 依赖

| 模块 | 用途 |
|------|------|
| `src/adapters/oneshot.cjs` | oneshot 端口实现（claude -p；claude 字面只在此 adapter） |
| `src/adapters/tooling.cjs` | tooling 端口实现（`claude plugin …` 字面只在此 adapter） |
| `src/adapters/interactive.cjs` | interactive 端口实现（`claude` 直启字面只在此 adapter） |
| `src/adapters/probe.cjs` | probe 端口实现（组装 host + status 侦查报告） |
| `src/adapters/cc-shapes.cjs` | 非端口工具（cc 回写形状） |
| `src/adapters/mock.cjs` | 测试夹具（方法集须与 `PORT_CONTRACT` 逐一对齐） |
| `src/server/host.cjs` | host 端口实现（tmux 原语，会话名参数化）——**仍在 server，未收口** |
| `src/server/hook-adapter.cjs` | hook 端口实现（hook → 领域事件）——**仍在 server，未收口** |
| `src/lib/events.cjs` | hook-adapter 消费的事件定义（`HOOK_EVENT_MAP` / `createEvent`） |

## 当前未收口清单（如实）

W3-004 的目标是「claude 的一切从 cli/server/plugin MCP/scripts 各处迁入 adapters，外部只剩 ports 契约」。
**该目标只完成了一部分**，未完成部分登记为结构债，责任任务 **T1-113**（见
`.awf/reports/architecture-discipline-audit.md`）。当前实际状态：

| 项 | 现状 | 证据 |
|----|------|------|
| `session` 端口 | **not-landed**：live 走 `cli/run.js` → `scripts/bootstrap.sh`（shell 里拼 tmux + claude），适配器版从未接线 | `ports.cjs:82-89`（note + responsible T1-113）；`src/cli/run.js:251` |
| host/hook 实现仍在 server | `ports.cjs` 反向 `require('../server/host.cjs')`、`require('../server/hook-adapter.cjs')` —— 端口契约层依赖控制平面（审计 F3） | `ports.cjs:31-32` |
| `claude` / `tmux` 命令字面仍在 adapters 之外 | `src/server/tmux.cjs:18` `execFileSync('tmux', …)`；`src/server/host.cjs:20` `execFileSync('tmux', …)`；`scripts/bootstrap.sh` 拼 `tmux new-session … claude …`（审计 F5） | 见左 |
| cli 绕过端口边界 | `src/cli/run.js:9` 直接 `import { generateRunSettings } from '../server/run-settings.cjs'`（cc 格式产物应经端口/或经 client 取，审计 F4） | `src/cli/run.js:9` |
| 插件 MCP 计算路径回取 `src/` | `plugin/core/mcp/awf-oneshot/server.cjs:13` 以 `path.join(__dirname,…)` 回取 `src/adapters/oneshot.cjs`（审计 F6，降级路径，行为正确但自述失真） | 见左 |

因此：**`ports.cjs` 模块头「外部源码零 claude 命令字面（纪律 R-cc）」目前是目标而非事实** ——
`session` 端口已如实登记为未收口，但 host/hook 实现仍在 `src/server/`、tmux/claude 字面仍在
`src/server/tmux.cjs`、`src/server/host.cjs`、`scripts/bootstrap.sh`。文档按现状记录，勿据此认为已收口。

## 验收标准

- [ ] `PORT_NAMES` 恰为 7 项且唯一，顺序为 host/hook/oneshot/tooling/interactive/probe/session（`tests/unit/ports-contract.test.js`）
- [ ] 每个 factory 端口声明的方法在 `createCcAdapters()` 返回对象上真实存在（typeof function）
- [ ] `createCcAdapters()` 返回 6 个端口（不含未收口的 session）
- [ ] `assertPortContract()` 对缺 note/responsible 的 not-landed 端口抛错
- [ ] `NON_PORT_TOOLS` 记录的 cc-shapes 不出现在 7 端口名册
- [ ] `createMockAdapters()` 端口方法集与工厂逐一对齐（夹具不自说自话）
- [ ] 生产侧（cli/server）经 `ports.cjs` 取端口，不直连具体 adapter 文件
