# cc adapters（端口契约） — 功能文档

> 对应 WBS：W3-004（adapters/cc 工具适配收口）+ T-P1-01～T-P1-03（按项目解析 / host 能力化 / session 收口）
> 源码：`server/adapters/ports.cjs`（唯一门）+ `server/adapters/cc/*.cjs`（7 端口实现）
> 测试：`tests/unit/ports-contract.test.js`、`tests/unit/ports.test.js`、`tests/unit/host.test.js`

## 功能描述

`server/adapters/` 是外部 CLI（当前 cc = Claude Code；`dsh` 已登记未落地）接入能力的**收口层**。
目标：把 `claude` / `tmux` 等命令与进程接入从 cli/server/plugin MCP/scripts 各处迁入 adapters，
外部源码只依赖「端口契约」，不直连具体实现。

`server/adapters/ports.cjs` 是**进入 adapters 的唯一门**：

- 声明 7 端口名册 `PORT_CONTRACT`。
- 以工厂 `createCcAdapters(opts)` 统一绑定**全部 7 个端口**（T-P1-03 起含 `session`）。
- 以按项目解析的入口 `resolveProjectAdapters(projectRoot, opts)` 返回 `{ name, ports, tools, impls, checks }`，
  生产侧（cli / server）优先经它取用（T-P1-01）。
- 以单端口句柄导出（`host` / `hook` / `oneshot` / `tooling` / `interactive` / `probe` / `shapes` / `extract` …），
  供平台无关的纯工具场景与默认 cc 场景取用。
- 加载即执行两处自检：`assertPortContract()`（端口契约）与 `assertAdapterRegistry()`（平台注册表）——
  未落地项缺 `note`/`responsible` 直接抛错。

## 按项目解析平台（T-P1-01 / C01）

```
resolveProjectAdapters(projectRoot, { sessionName, bootstrapScriptPath, env, … })
  → resolveAdapterName(projectRoot, { env })
       env.CC_ADAPTER ?? .awf/config.json 的 runtime.adapter ?? 'cc'
       （未知平台名 → 抛错；不静默回落）
  → 平台已落地？ 否 → 抛错并点名 responsible（当前 dsh → T-P2-01）
  → { name, ports: 7 个已绑定句柄, tools: 形状/资产工具, impls: 平台原始实现, checks: 依赖检查 }
```

| 平台 | status | 说明 |
|------|--------|------|
| `cc` | `factory` | tmux 会话 + hooks 回调；`checks()` 返回 tmux / claude / node |
| `dsh` | `not-landed` | P0 已实测机制（E-03/E-04）；生产适配器 `server/adapters/dsh/` 待建（T-P2-01） |

装配落点：`server/runtime/project.cjs` 的 `ctx.adapter` / `ctx.adapters`；`cli/lib/context.cjs` 的
`buildContext()` 同样附 `adapter` / `adapters`，两边同一解析。

## 执行流程

```
生产侧 require('server/adapters/ports.cjs')
  → 模块加载即跑 assertPortContract() + assertAdapterRegistry()（未落地缺 note/responsible → 抛错）
  → 二选一取用：
     ├─ resolveProjectAdapters(projectRoot, opts)   ← 按项目管理平台（首选）
     └─ 单端口句柄（host/hook/oneshot/tooling/interactive/probe/shapes/extract/…）
```

`createCcAdapters(opts)` 内部：

```
const host = createHost({ sessionName, execFileSync });        // ← server/adapters/cc/host.cjs
return {
  host,
  hook: createHookAdapter({ emit }),                           // ← server/adapters/cc/hook.cjs
  oneshot: PORT_IMPLS.oneshot,                                 // ← server/adapters/cc/oneshot.cjs
  tooling: PORT_IMPLS.tooling,                                 // ← server/adapters/cc/tooling.cjs
  interactive: PORT_IMPLS.interactive,                          // ← { launchDialog } 包装
  probe: createProbe({ host, status }),                        // ← server/adapters/cc/probe.cjs
  session: createSessionPort({ sessionName, bootstrapScriptPath, execFileSync }), // ← cc/session.cjs（T-P1-03）
};
```

## 核心常量 / 配置

| 常量 | 值 | 说明 |
|------|-----|------|
| `PORT_CONTRACT` | 7 项数组 | 每项 `{ name, status, role, methods[] }`；`methods` 是端口对象上**真实存在**的方法 |
| `PORT_NAMES` | `['host','hook','oneshot','tooling','interactive','probe','session']` | 端口名册，与 `mock.cjs` 覆盖集一致 |
| `ADAPTER_PLATFORMS` | `{ cc, dsh }` | 平台注册表（T-P1-01）；`assertAdapterRegistry()` 守未落地项 |
| `ADAPTER_ENV` / `ADAPTER_DEFAULT` | `'CC_ADAPTER'` / `'cc'` | 平台选择的环境覆盖名与缺省值 |
| `NON_PORT_TOOLS` | `shapes` / `extract` / `settings` / `profile` | 明确裁决**不在**名册内的工具，带理由 |
| `PORT_IMPLS` | 7 端口 + 4 个非端口工具的原始实现 | 平台注册表 `impls` 引用它 |

### 7 端口名册

| 端口 | status | role | 声明方法（`methods`） | 实现位置 |
|------|--------|------|----------------------|----------|
| `host` | factory | 会话原语 + 派发节奏 | `sessionName`、`hasSession()`、`sendText(text)`、`sendPrompt(text)`、`sendEnter()`、`sendCtrlC()`、`capture()` | `server/adapters/cc/host.cjs` |
| `hook` | factory | hook payload → 领域事件 | `hook(payload, ctx)` | `server/adapters/cc/hook.cjs` |
| `oneshot` | factory | 无状态 LLM 调用（claude -p） | `runOneShot()`、`spawnClaudeP()`、`claudePArgs()` | `server/adapters/cc/oneshot.cjs` |
| `tooling` | factory | plugin 安装 / 市场运维 | `install()`、`uninstall()`、`claudeAvailable()`、`buildMarketplaceAdd()`、`buildInstall()`、`buildUninstall()` | `server/adapters/cc/tooling.cjs` |
| `interactive` | factory | plan 交互对话（直开终端） | `launchDialog(opts)` | `server/adapters/cc/interactive.cjs`（包装层） |
| `probe` | factory | w-monitor 外部会话侦查 | `inspect()` | `server/adapters/cc/probe.cjs`（需 host/status 注入） |
| `session` | factory | 会话启动 / 复用探测 / 停止 / 接入观看 | `sessionName`、`exists()`、`cwd()`、`start({ projectRoot, env })`、`kill()`、`nudge()`、`attach({ stdio })` | `server/adapters/cc/session.cjs`（T-P1-03 收口） |

### `ctx.host` 能力化与 `sendPrompt`（T-P1-02）

`ctx.tmux` 曾是机制名泄漏（上层知道「tmux 注文本分两次发」）。现在：

- 出口叫 `ctx.host`（平台能力面），注入缝 `global.__CC_HOST__`、测试注入参数 `hostFactory`。
- `CC_ENTER_DELAY_MS` 的节奏下沉进 `cc/host.cjs` 的 `sendPrompt(text)`（文本 → 等节奏 → 回车），
  `server/config.cjs` 不再导出 `ENTER_DELAY_MS`；executor / web api 只说「提交一段输入」。

### `session` 端口收口（T-P1-03）

`cli/lib/session.cjs` 与 `cli/commands/attach.cjs` 原本 5 处 tmux 直连（display-message 取 cwd、
kill-session、bash bootstrap.sh、send-keys Enter、attach）全部下沉到 `cc/session.cjs`；
CLI 侧现在零 `tmux` 字面。「空 cwd 判为不存在」这条真机教训留在端口实现里。

### 为什么 `shapes` 不是端口

`cc/shapes.cjs` 构造回写**形状**（Stop block、permissionDecision deny），是**纯数据函数**
（无副作用、无可替换性诉求），且已被领域代码直接消费。裁决理由记在 `NON_PORT_TOOLS`：
端口 = 可替换的平台能力面（带会话/进程/外部依赖）。它**仍经 `ports.cjs` 这道门出口** ——
界线是「adapters 边界」，不是「只在名册里的才准出」。
（T-P1-01 把导出名由 `ccShapes` 改为 `shapes`：公共面不带 CLI 前缀。）

## 函数清单

| 函数 | 说明 |
|------|------|
| `assertPortContract(contract?)` | 端口契约自检；未收口缺 note/responsible 抛错 |
| `assertAdapterRegistry(platforms?)` | 平台注册表自检；not-landed 缺 note/responsible 抛错 |
| `resolveAdapterName(projectRoot, { env })` | 解析本项目平台名（唯一判定点） |
| `resolveProjectAdapters(projectRoot, opts)` | 解析并绑定平台，返回 `{ name, ports, tools, impls, checks }` |
| `createCcAdapters(opts)` | cc 平台工厂：绑定并返回 7 个端口 |
| `createHost({ sessionName, execFileSync })` | host 端口工厂（tmux 原语 + `sendPrompt` 节奏） |
| `createSessionPort({ sessionName, bootstrapScriptPath, execFileSync })` | session 端口工厂（T-P1-03） |
| `createHookAdapter({ emit })` | hook 端口工厂（payload → 领域事件） |
| `createProbe({ host, status })` | probe 端口工厂 |
| `blockDecision` / `denyPermission` | `shapes` 非端口工具 |
| `createMockAdapters()` | 测试夹具（7 端口全量 + `calls` 记录 + `reset`） |

## 接口 / 依赖

| 模块 | 用途 |
|------|------|
| `server/adapters/cc/host.cjs` | host 端口实现（tmux 原语 + `sendPrompt`；`tmux` 字面只在此与 session.cjs） |
| `server/adapters/cc/session.cjs` | session 端口实现（起/停/探测/补 Enter/attach） |
| `server/adapters/cc/hook.cjs` | hook 端口实现（hook → 领域事件） |
| `server/adapters/cc/{oneshot,tooling,interactive}.cjs` | `claude` 字面所在的三个端口实现 |
| `server/adapters/cc/{probe,shapes,extract,settings,profile}.cjs` | 侦查 / 形状 / 解析 / 资产构造 |
| `server/adapters/cc/checks.cjs` | 平台依赖清单（C02；init 经 `resolveProjectAdapters().checks()` 取） |
| `server/adapters/mock.cjs` | 测试夹具（方法集须与 `PORT_CONTRACT` 逐一对齐） |
| `scripts/bootstrap.sh` | 被 session 端口调用的起会话资产（脚本内拼 tmux + claude） |

## 验收标准

- [ ] `PORT_NAMES` 恰为 7 项且唯一，顺序为 host/hook/oneshot/tooling/interactive/probe/session（`tests/unit/ports-contract.test.js`）
- [ ] 每个 factory 端口声明的方法在 `createCcAdapters()` 返回对象上真实存在（typeof function）
- [ ] `createCcAdapters()` 返回 **7** 个端口（含已收口的 session）
- [ ] `session.start` 缺 `bootstrapScriptPath` → 明确抛错，不静默
- [ ] `resolveAdapterName` 缺省 cc、可被 config/env 覆盖；未知/未落地平台显式抛错（含责任 task id）
- [ ] `assertPortContract()` / `assertAdapterRegistry()` 对缺 note/responsible 的未落地项抛错
- [ ] `NON_PORT_TOOLS` 记录的 `shapes` 不出现在 7 端口名册
- [ ] `createMockAdapters()` 端口方法集与工厂逐一对齐（夹具不自说自话）
- [ ] 生产侧（cli/server）经 `ports.cjs` 取端口，不直连具体 adapter 文件
