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
  → 平台已落地（status=factory）？ 否 → 抛错并点名 responsible
  → { name, ports: 7 个已绑定句柄, tools: 形状/资产工具, impls: 平台原始实现, checks: 依赖检查 }
```

| 平台 | status | 说明 |
|------|--------|------|
| `cc` | `factory` | tmux 会话 + hooks 回调；`checks()` 返回 tmux / claude / node |
| `dsh` | `factory` | 适配器 + 插件 host 半侧在位（P2-6a 转 factory）：单后台多项目、会话级 MCP、派发/落账/快照/停止（含子 Agent 逐个打断）均**真机跑通** |

装配落点：`server/runtime/project.cjs` 的 `ctx.adapter` / `ctx.adapters`；`cli/lib/context.cjs` 的
`buildContext()` 同样附 `adapter` / `adapters`，两边同一解析。

### 怎么知道「现在跑在哪个环境」（诊断第一问）

平台是**按项目**解析的（不是按机器/进程）：同一个常驻 AWF server 可以同时服务 cc 项目与 dsh 项目。

**怎么选平台（初始化时）**：

```bash
awf init --adapter dsh      # 推荐：写进 .awf/config.json，之后所有命令都按项目解析
CC_ADAPTER=dsh awf init     # 等价（一次性环境变量，不落配置；init 仍会把它记进项目）
# 也可以先手写 .awf/config.json 的 runtime.adapter=dsh 再 awf init
```

显式 `--adapter` 会**覆盖**配置里已有的值（用户明确要的平台优先）；未知平台名立即报错退出（exit 2）。

| 手段 | 看到什么 |
|---|---|
| `awf server status` | 首行 `平台：dsh（来自 .awf/config.json 的 runtime.adapter）`；JSON 里另有 `adapter` / `adapterSource` |
| `GET /status?p=<项目>` | 同上两个字段（`adapterSource` = `env` \| `config` \| `default`） |
| 离线看 | `<项目>/.awf/config.json` 的 `runtime.adapter`（缺省即 `cc`）；`CC_ADAPTER` 环境变量优先于它 |
| `awf init` / `awf plugin install` 回显 | dsh → `已装配 DSH profile …`；cc → `已本地注册 → …/.claude/settings.json` |
| 行为差异 | `awf attach`：dsh 打印网页会话地址；cc 占住终端（tmux attach）。`awf plugin install`：dsh 无 `--scope global` |
| 进程内日志 | 子 Agent 落账行带 `（via dsh）`/`（via cc）`；DSH 侧 `[awf-dsh][…]` 前缀 |

优先级：`CC_ADAPTER` > `.awf/config.json` 的 `runtime.adapter` > 缺省 `cc`；未知平台名**直接抛错**。

## DSH 平台（`server/adapters/dsh/`，P2-4 起）

DSH 与 cc 的机制不同（会话控制器 + 平台事件，而非 tmux + hooks），因此 DSH 的端口实现全部
**经指令通道发给 DSH 插件**执行，AWF 侧不做任何会话调度判断。

```
server/adapters/dsh/
  bridge.cjs   指令通道（传输无关）：三种送达结论 + ack/result 两段窗口 + 事件上行 + 平台事实
  index.cjs    createDshAdapters({ bridge, bus, sessionName }) → 7 端口 + checkPrerequisites()
server/web/
  bridge-channel.cjs  传输侧单例：WS 升级 /bridge/dsh（插件连上即 attach）
                      + POST /bridge/dsh/callback（accepted/result/event 回传）
dsh-plugin/            对侧：AWF 的 DSH host 半侧（Cordis ESM 插件）
  index.js             装配：读 awfBase（config 或 AWF_DSH_BASE）→ 起指令通道；ctx.effect 管生命周期
  lib/bridge-client.js 连 WS / 收指令 → **先回 accepted 再回 result**；断线退避重连不重放；事件上行
  lib/ops.js           指令实现表：session.facts/nudge/open/create/interrupt/stop/prompt/snapshot/
                       tools/children、plan.launch、llm.oneshot；未实现的 op **显式失败**
  install.cjs          profile 装配（标记块 + 一次备份 + 链接插件包）—— `awf plugin install` 走这条
```

| 面 | DSH 侧口径 |
|---|---|
| 送达结论 | `not-delivered`（未交给平台）/ `unconfirmed`（发了但无回执，**不等于失败**）/ `accepted`（已交给平台）；上层的 `must()` 把前两者与平台报错变成**显式异常** |
| 事实类同步方法 | `hasSession()` / `capture()` / `cwd()` 回**最近一次已知值**（同步 API 无法等网络）；新鲜事实走 `probe.inspect()`（ready/busy/absent/unknown） |
| cc 机制方法 | `spawnClaudeP` / `claudePArgs` / `claudeAvailable` / `build*` **显式 unsupported**（抛错），不静默返回假值 |
| 断开语义 | 通道断开即 `detach`：在途指令判「无法确认」、**不自动重发**（连接恢复 ≠ 任务恢复） |
| 两侧现状 | AWF 侧 + 插件 host 半侧 + CLI 装配路径全在位；`status: 'factory'`，`resolveProjectAdapters()` 对 dsh 项目真实返回 7 端口 |
| 已真机验过 | 指令通道往返；建会话（pre-publication setup：模型选择 + preset + 项目 MCP）/停止（cancel keepInbox，不删会话）；提交→accepted→turn.started/prompt.submitted/session.ready；20 个 `mcp__awf-state__*` 工具可见且模型**真落账**；可读快照；`plan.launch`；`llm.oneshot`；单任务 `run` 端到端；双项目隔离（单后台）；子 Agent 派出 + 停 run 时逐个打断；CLI `awf plugin install` → profile（`dsh --dump-config` 见 `awf-dsh-plugin`）。夹具 `scripts/probe/dsh/roundtrip.cjs`（隔离 `DSH_HOME`，`guard.sh check` 恒 IDENTICAL） |
| 未落地面 | 子 Agent 的批准策略继承、决策/NEEDS_INPUT/门禁在 DSH 侧的真实闭环、`run -r` 续跑、三个业务页面与项目/无会话入口（P3/P4） |

`REQUIRED_PORT_METHODS`（T-P1-05 的必填面）在 P2-4 **收窄**为平台无关方法：cc 机制方法不再当必填，
否则等于用 cc 的实现形状要求别的平台。conformance 套件的判据也相应改为「**有工厂**（`create` 是函数）」，
并在 `status !== 'factory'` 时断言「解析必须显式拒绝」。

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

## DSH 交付状态：已完成 vs 占位（P4 收口）

> **一句话**：DSH 的接入链路（七个命令 + 编排闭环）已在隔离真机上验证可用；**完整业务 UI、恢复类与原生观测仍未做**，
> 逐条见下表与 `docs/discuss/dsh-adapter-execution.md` §2.18 的 V01～V12（标 ⬜ = 没做）。**不要读成「全部做完」**。

避免「一体宣称已接入」：下表逐项说明**已交付并验证**与**占位/未做**。证据与逐条验收对照见
`docs/discuss/dsh-adapter-execution.md` §2.18；真机夹具 `scripts/probe/dsh/`（隔离 `DSH_HOME`，
真实 `~/.dsh` 每轮 `guard.sh check` 恒 `IDENTICAL`）。

| 面 | 状态 | 说明 |
|---|---|---|
| 平台解析 / 7 端口 / 指令通道 | 完成 | `resolveProjectAdapters` 对 dsh 项目返回 7 端口；三种送达结论 + 断线不重放 |
| 会话创建 / 提交 / 回合结束 / 快照 / 停止 | 完成 | 真机会话 + 发布前 setup（模型选择 + preset + 项目 MCP）+ cancel keepInbox；停止逐个打断子 Agent |
| 任务落账（单 agent 与子 Agent） | 完成 | 模型经 `mcp__awf-state__*` 落账；子 Agent 的 `RESULT` 由末条文本落账 |
| 多 agent batch | 完成 | 宿主 batch 调度 → 平台化派发提示词 → DSH 原生子 Agent → RESULT 落账 → run 收尾 |
| 回合末门阀（决策） | 完成 | 回合末文本 → 门阀 → 指令**再发一条 prompt** 回会话 → 结论落盘 |
| 双项目隔离 / 单后台 | 完成 | 单 DSH 后台、两个项目各自会话与项目 MCP，互不串 |
| CLI `init` / `plugin` / `attach` | 完成 | 干净项目 `awf init` 幂等 + 平台记入 `.awf/config.json`；`plugin install/uninstall` 装 profile；`attach` 打印/打开会话页 |
| CLI `plan` | 完成（入口） | `awf plan` 在独立 CLI 进程里经 server 的 `POST /interactive/plan` 触发规划会话并回网页地址（F41：CLI 进程没有 bridge）；`plan -r` 的**原对话恢复**未做（按 U13 明确说明并新建） |
| CLI `server` | 完成 | `awf server start` → `status`（`state: ready`）→ `stop` 在 DSH 项目上真跑通；单后台复用见双项目验收 |
| CLI `open` | 完成 | `dashboard`/`tree`/`ui` 三个入口打印带 `?p=` 的地址，落到三个占位页（U4） |
| 三个业务页面（`dashboard` / `tree` / `ui`） | **占位** | 入口已接通、页面如实声明「内容待逐页指导」；**不是**完整业务 UI（U4） |
| 项目 / 无会话入口 | 完成 | 左侧栏「添加项目」+ 未选项目时的明确文案（不空白、不编造数据） |
| 观测：DSH 原生 token / 速度 / 对话记录 | 未做 | 覆盖不全按「未知」展示，不填 0（C28） |
| 恢复类：`run -r` 不重复提交、重启组合（CLI 退出 / 桥断 / 各自重启） | 部分 | `-r` 最小挂接与断线不重放已有护栏；重启组合验收未做（V09） |
| 发布包干净环境安装 / 卸载 | 完成 | 真 `npm pack` → 解包到新目录 → 用**包里的** CLI 装配隔离 profile → 卸载复原；包内容与开发机绝对路径都有断言 |

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
