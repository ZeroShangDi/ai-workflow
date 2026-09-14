# dsh 适配器设计（D 方案：编排在 awf，会话驱动在 dsh 插件）

> 状态：设计已定，待评审
> 日期：2026-09-14
> 前置：本文件后续的「Spike 实测结论」全部来自真机实测，非推断

---

## 1. 背景

awf 目前只兼容 Claude Code（cc）。`server/adapters/ports.cjs` 已按六边形架构预留了多 CLI 适配层
（注释里的 `dash/` 占位即为此），但 `cc/` 是唯一真实实现。

目标：**增加 dsh（DeepSeek Harness）适配**，让 awf 的编排能力能驱动 dsh；
同时**在 dsh 的 web 页面里提供 awf 的 UI**（替代 cc-control 自带的 `web/` dashboard）。

### 1.1 为什么不是「下载 dsh 源码改 web」

dsh 的 web 是插件架构 —— `apps/web/src/` 只有 3 个入口文件，所有 UI 在 `packages/client/ui-*` 里
通过 `ctx.slots` 组合，官方立场是 **"Everything is a Plugin"**、功能插件「绝不导入其他功能插件的组件」。
所以正确姿势是写 client 插件，而非改源码。**结论：不需要 fork，但需要一份只读 clone 作权威参考。**

---

## 2. Spike 实测结论

环境：dsh launcher `0.1.5-rc.1`（全局），包 `0.1.5-rc.2`（与 upstream master 对齐）。
隔离 `DSH_HOME=/tmp/dsh-spike`，真实 `~/.dsh` 与项目零改动。

> ⚠️ **npm dist-tag 陷阱**：`latest = 0.0.1-rc.1`（过期）。装包必须用 `next`（`0.1.5-rc.2`）。

### 2.1 MCP 挂载 —— ✅ 通过

**证据**：headless 会话让模型调用 `mcp__awf-state__awf_read_state`，答出 `version=0.2.0 tasks=156`
（cc-control 的真实 state.json）；stderr 有 `[awf-state] started` / `client initialized`。

挂载方式（profile 的 `cordis.patch.yml`）：

```yaml
- insert:
    - id: mcp-awf-state
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: awf-state
        transport: stdio
        command: node
        args: ['<abs>/plugin/core/mcp/awf-state/server.cjs']
        env: { AWF_PROJECT_ROOT: <abs> }
```

**⚠️ 附带发现**：cc-control 的 state.json 有 619KB，触发 dsh 的 spill 机制
（`maxInlineBytes: 50000`），模型看到的是落盘文件路径而非内容。
→ **`awf_read_state` 的返回体必须收敛**，否则 dsh 下不可用。这是独立于本设计的待办。

### 2.2 hooks —— ⚠️ 部分可用，两处硬伤

`@deepseek-ai/dsh-hooks-claude-code` 能直接跑 awf 现有的 `plugin/core/hooks/hooks.json`。
实测触发 `SessionStart` / `UserPromptSubmit` / `PostToolUse` / `Stop`。

| 兼容项 | 状态 |
|---|---|
| `hook_event_name` / `session_id` / `stop_hook_active`（字段在）/ `tool_name` / `tool_input` | ✅ |

| 硬伤 | 实测 | 影响 |
|---|---|---|
| **`stop_hook_active` 恒为 `false`** | 333 次 Stop 调用全 `active=false`，模型空转 332 轮 | 决策门阀防重入**完全失效** → 无条件 block = 死循环 |
| **`last_assistant_message` 缺失** | Stop hook payload 里没有（SubagentStop 亦缺 `agent_transcript_path`） | `extract.cjs` 的 RESULT / NEEDS_INPUT 提取**无输入源** |

第一条是**官方已知限制**（`dsh-hooks-claude-code/README.zh.md:180`「未实现连续阻塞上限…除非它自我限制」）。

其他差异：回写阻塞走 **exit 2 + stderr**（非 cc 的 stdout JSON）；matcher **大小写敏感**
（`"Bash"` 不匹配 dsh 的 `bash`）；env 只保证 `CLAUDE_PROJECT_DIR`，awf 的 `CC_*` 需另设。

> **D 方案下这两条硬伤都不构成阻塞** —— 见 §4.3。

### 2.3 SDK 路线 —— ✅ 通过

`dsh --profile sdk` 提供 JSON-RPC over stdio（newline-delimited）。

| awf 需要 | SDK 提供 | 评价 |
|---|---|---|
| 投递 prompt | `session/prompt` → `{messageId}` | **有回执** —— cc 的 tmux 是盲发 |
| 会话状态 | `session.status` `running`/`idle` | **精确**，不必靠 hooks 推 |
| 助手产出 | `session.event: assistant/message` | 结构化，不必抓 pane |
| 回合边界 | `turn/start` / `turn/end` | 明确完成信号 |
| 子 agent 生命周期 | `subagent.started` / `subagent.finished` | |
| 子 agent 末条消息 | `subagent.finished.lastAssistantMessage` | **补上 hook 缺的 `last_assistant_message`** |
| **打断** | ❌ 无 | 见 §2.4 |

**`initialize` 实测 0.01 秒**（早期测得的 58 秒是测试脚本里一个不完成握手的假 MCP 探针所致，已作废）。

### 2.4 打断 —— ✅ 能力存在

| 接入面 | 接口 |
|---|---|
| session-controller RPC（web 用的） | `remote.session.cancel({ sessionId })` → `{ ok, error? }` |
| 子 agent | `remote.subagents.interruptByParent(childSessionId, parentSessionId, 'continuable')` |
| **ACP** | **`session/cancel`**（标准方法） |
| SDK JSON-RPC | ❌ 未暴露 |

另有第三种：`prompt(content, mode, …)` 的 `mode: 'steer'` 会打断当前轮次。

打断信号：`turn/end` 带 `reason: { kind: 'interrupted' }`，ACP 映射为标准 `"cancelled"`。

### 2.5 Web 实时性 —— ❌ A 方案（外部进程）不成立

用 browser-bridge 直接观测运行中的 `dsh web` 页面（tab 停留 35 秒 + 逐项对照）：

| 测试 | 结果 |
|---|---|
| 新会话自动出现在列表 | ❌ 不会 |
| 列表时间戳自动走 | ❌ 不会（"刚刚"始终是"刚刚"） |
| 主区内容自动更新 | ❌ 不会 |
| 整页刷新后 | ✅ 出现，**含正在运行的会话** |
| 落盘 | ✅ 增量写（每 10 秒稳定增长） |
| 视图正确性 | ⚠️ 实测一个**已正常完成**的会话被渲染为「失败」+ 崩溃修复消息（"tool call was interrupted…"），**整页重载后恢复完整**（10 次工具调用 / 用时 1分12秒 / 正常结束）。即：页面读到的是未闭合的中间态，且该错误视图会被前端缓存住 |

**根因**：页面的事件流（`session.event`）只覆盖**它自己运行时**的会话。`dsh --profile sdk` 是
**另一个运行时**，它的会话对页面只是**持久化副本** —— 只能靠重新查询（刷新）拿到，而前端把
查询结果缓存住了。会话存储在 `$DSH_HOME/sessions/<cwd-slug>/<session-id>/` 是共享的，
但**共享存储 ≠ 实时可见**。

> **这是本设计的决定性约束**：既然目标是「用 dsh 页面当 UI」，**编排必须活在 web 运行时内**。

### 2.6 web 鉴权（顺带）

`dsh web` 默认监听 `127.0.0.1:3080`，`GET /` 返回 401。鉴权是**按激活签名、绑定 authority 的
浏览器 cookie**，签名密钥持久化在 `$DSH_HOME/.credentials.yaml` 的 `client-connection/browser-session`
grant 记录里；启动时打印 `http://127.0.0.1:<port>/?token=…` 换取 cookie。

`dsh-client-connection` 明言「**不存在按方法区分的 loopback 层**」—— 这是**刻意做的边界**。
绕它需要复刻 cookie 生成 + Typert RPC（HTTP 一元 + `/api/remote.mux` WebSocket）+ 生成的
`InvocationDescriptor` 校验，等于把 awf 绑死在 dsh 内部实现上。**本设计不采用此路。**

---

## 3. 目标与非目标

### 3.0 核心目的（本设计的判据）

> **怎么做不是目的，为了什么才是核心。**

awf 在会话观测上只有两个目的：

1. **能复盘** —— 事后能看清这一轮到底发生了什么
2. **能实时看到** —— 跑的过程中能看到它在做什么

cc 下这两件事靠 awf 自己实现（`capture-pane` 抓屏 → 落盘日志 → dashboard 轮询展示）。
dsh 下这两件事由平台天然满足（会话就在 dsh 页面里、dsh 自带存储）。

**判据分两层，别混**：

| 层 | 问什么 | 混层的后果 |
|---|---|---|
| **契约层** | 「**上层需不需要这个能力**」—— 需要就进契约，**不问某个 CLI 下由谁实现** | 因为「平台顺带满足了」就把能力移出契约 → 上层得知道「现在是哪个 CLI」才能去拿（§4.2 `snapshot()` 的教训） |
| **实现层** | 「**不提供它，哪个目的达不成**」 | adapter 内部的取舍，**不上升为契约的有无** |

**一句话**：契约的存废只看**上层需不需要**；「目的已由平台满足」是实现层的判断，不是契约层的。

### 目标

1. awf 能驱动 dsh 会话（投递 / 观测 / 打断），复用现有编排（executor 等待语义、channel 收尾
   协商、门禁闭环、scheduler），**不改这些逻辑**。
2. awf 驱动的会话在 dsh web 页面里**实时可见**。
3. 在 dsh 页面里提供 awf 的 UI（设置页 / header 按钮 / 中心页面 / 切换条）。

### 非目标

- 不改 dsh 上游源码（零 fork 改动）
- 不在 dsh 模式下使用 cc-control 自带的 `web/` dashboard
- 不把 dsh 的 hooks 硬伤本身修好（绕开，不修）

### 硬约束：本轮改动不得打断现有 cc

cc 是当前唯一在用的真实实现。契约变更（§4.2 的方法改名）直接打在 cc 路径上，任何漏改都会让
`awf run` 当场宕机。

**改造面（已实测统计）**

生产侧（必须同批改）：

| 文件 | 内容 |
|---|---|
| `server/adapters/ports.cjs` | 契约声明 + 解析点（§4.6） |
| `server/adapters/cc/host.cjs` | cc 实现本体 |
| `server/runtime/executor.cjs` | 4 处 `ctx.tmux.*` |
| `server/web/api/session.cjs` | 7 处 |
| `server/web/api/util.cjs` | 1 处（错误文案） |
| `server/runtime/project.cjs` · `index.cjs` | `ctx.tmux` 注入面命名 |
| `server/config.cjs` | `ENTER_DELAY_MS`（迁入 cc 实现内） |

测试侧：

| 文件 | 内容 |
|---|---|
| `server/adapters/mock.cjs` · `server/mock/index.cjs` · `tests/helpers/mock-tmux.js` | 3 个测试替身 |
| **18 个测试文件** | 调用点（`hasSession`×9 / `sendText`×7 / `sendEnter`×4 / `capture`×3 / `sessionName`×3 / `sendCtrlC`×2） |

**纪律**

1. **同批落地**，`npm test` 全绿是硬门槛。
2. **不引入双名过渡**。契约里同时留新旧名会让 `methods` 名册失真 —— 而 `ports.cjs` 的既有纪律是
   「口径一旦失真，「哪些能力面还没收口」就再也数不清了」。
3. **既有债务同批收口**：`cli/lib/session.cjs` 的 5 处 tmux 直连 + `cli/commands/attach.cjs` 的
   `tmux attach`（§4.6）。
4. **加运行时契约自检**：现在 `methods` 是**文字形式**（`'sendText(text)'`），不可执行 —— 漏改只能
   靠人看。改为**可执行的必填方法名数组**，加载时逐项断言实现上真实存在，否则**加载即抛错**。
   这把「漏改」从运行期惊喜变成加载期失败，是本条硬约束最有力的保障。
5. 回归门槛：cc 路径 e2e（`npm run test:eval`）必须通过。

---

## 4. 架构

### 4.1 总体

```
┌─────────────────────────────────────────────────────────┐
│  dsh web 页面  127.0.0.1:3080                            │
│    ↑ awf 的 UI 插件（client 半侧）                        │
│    ↑ awf 的会话（与页面同运行时 → 实时可见）              │
├─────────────────────────────────────────────────────────┤
│  dsh web 运行时                                          │
│    └─ awf adapter 插件（host 半侧）                       │
│         ① 在运行时内创建/驱动会话（原生，无鉴权）         │
│         ② 与 awf server 通信（SSE 收指令、POST 回吐结果）  │
├─────────────────────────────────────────────────────────┤
│  awf 进程（编排：state / scheduler / 门禁 / 无变化窗口）  │
│    └─ server/adapters/dsh/  ← host 端口的 awf 侧实现      │
│         └─ awf 自己的 HTTP server :8787（MCP tools / hooks）│
└─────────────────────────────────────────────────────────┘
```

**核心分工**：
- **awf 侧**持有全部编排决策，通过 `host` 端口抽象发指令
- **插件侧**只做「把指令投进运行时内的会话」+「把结果回吐」，不做任何调度决策

### 4.2 `host` 端口新契约（按能力设计，不按 tmux/SDK）

现契约是 **tmux 形状**，不是会话形状：

| 现方法 | 为什么是泄漏 |
|---|---|
| `sendText` + `sendEnter` **两段式** | tmux 的物理约束（打字、回车是两次 `send-keys`），非会话语义 |
| `capture()` | 返回**渲染后文本快照**，SDK/运行时内无此概念 |
| `sessionName` / `hasSession()` | tmux 专有 |
| `ENTER_DELAY_MS`（`server/config.cjs`） | 「tmux 分两次发」的节奏参数 |

新契约（按 §3.0 的判据，每个方法都要回答「为什么存在」）：

| 新方法 | 为什么（目的） | 不提供会怎样 | cc 实现 | dsh 实现 |
|---|---|---|---|---|
| `label` | 报错时能指明是哪个会话 | 错误信息失去定位能力 | tmux session name | dsh sessionId |
| `alive()` | 派发前判断通道可用，避免空投 | 任务静默丢失 | `tmux has-session` | 插件心跳 / 运行时可达 |
| `submit(text)` | 把一条指令交给会话执行，**并知道是否被受理** | 编排放不下去 | sendText + delay + sendEnter | 运行时内提交（**进程内 Cordis service**，非 SDK JSON-RPC —— 那个只是 wire 面） |
| `interrupt()` | 中止当前响应（w-monitor 干预 / 用户点停止） | 干预手段只剩杀进程 | `send-keys C-c` | `session/cancel`（或 `mode:'steer'`） |

**`snapshot()` 保留在契约里**（原方案曾拟移除，经评审纠正）：

理由 —— **上层不该为了拿这个能力而知道「现在是哪个 CLI」**。`server/web/api/session.cjs` 是领域层，
它消费 `/status?snapshot=1`。若该方法只存在于 `cc/`，领域层就得直连 cc 实现，从而破坏 `ports.cjs`
立的那道门（「外部源码只许经 `ports.cjs` 取句柄，不许直连 `cc/xxx.cjs`」）。

**按目的重新表述**（换名字/换方式可以，**不进契约不行**）：

| 项 | 内容 |
|---|---|
| 目的 | 会话当前的**实时视图文本** —— 服务 §3.0 的「复盘 + 实时看到」 |
| 调用方 | `server/web/api/session.cjs` 的 `/status?snapshot=1`（全仓唯一生产消费点） |
| cc 实现 | `capture-pane -p -S -` 全文抓取（机制留在 `cc/` 内） |
| **dsh 实现** | **返回内容**（不是 `null`）—— 插件从运行时会话的事件 / 投影渲染文本 |
| 与平台的关系 | dsh 页面本身就是实时视图，但**端口方法照样提供**，供上层统一取用 |

**判据的边界**：契约的存废看「上层需不需要这个能力」，不看「平台是否已顺带满足」。
后者是**实现内部的取舍**，不上升为契约的有无。

`session` 端口（当前 `not-landed`，live 走 `scripts/bootstrap.sh`）随本设计**转正**：
`start({ projectRoot, sid })` / `stop()`。

**改造面（已实测统计）**：生产代码中 `ctx.tmux.*` 的消费点只有 3 个文件 ——
`server/runtime/executor.cjs`（4 处）、`server/web/api/session.cjs`（7 处）、
`server/web/api/util.cjs`（1 处）。**驱动模型本身不泄漏**：`executor.cjs` 的等待语义只依赖
`session.state`（hooks 驱动）、`stores.state`（MCP 驱动）、无变化窗口（纯 `Date.now()`）。

**另需补既有债务**：`cli/lib/session.cjs` 有 5 处直接 `execSync('tmux …')` 绕过端口
（`kill-session` / `send-keys` / `display-message`），`cli/commands/attach.cjs` 有 `tmux attach`。
这正是 `session` 端口 `not-landed` 的原因，**必须先补，否则 cli 层硬绑 tmux，dsh 起不来**。

### 4.3 硬伤绕开策略

D 方案下，2.2 的两处 hook 硬伤**不构成阻塞**：

| 硬伤 | 绕开方式 |
|---|---|
| `stop_hook_active` 恒 false → 决策门阀死循环 | **不用 hooks 做状态/门禁**。会话状态从插件侧直接拿（运行时内 `session.status`），门禁由 awf 通过 `submit`/`interrupt` 驱动 |
| `last_assistant_message` 缺失 → RESULT 提取无源 | 子 agent 末条消息从 `subagent.finished.lastAssistantMessage` 拿（插件在运行时内可见） |

**awf 在 dsh 模式下不依赖 `dsh-hooks-claude-code` 桥接。** 该桥接保留为可选兼容层，不进入主链路。

### 4.4 awf ↔ 插件 的通信：SSE

awf（外部进程）与插件（运行时内）需要双向通道。**载体定为 SSE**（用户已定）。

- **awf → 插件（下发指令）**：awf server 暴露一条 SSE 流，插件订阅。server 侧有指令时推
  `submit` / `interrupt` 事件；插件收到即在运行时内执行。`host.submit(text)` / `host.interrupt()`
  在 awf 侧的语义即「向流里投一个事件」。
- **插件 → awf（回吐结果 / 状态）**：插件向 awf server 发普通 POST（awf 自有协议，
  hooks gateway 已在用同一形态）。无需第二条流。

**为什么 SSE 合适**：单向推送（server → 插件）正好匹配「下发指令」的方向；反向走普通 POST 即可。
且 awf server 是 awf 自有的 HTTP 服务，插件订阅**不需要跨过 dsh 的鉴权边界**。

**`alive()` 的实现随之明确**：即「SSE 连接是否在线」。断流 ⇒ `alive()` 为 false ⇒ 走 executor
现有错误路径。

**契约不受载体影响**：端口方法仍是 `submit` / `interrupt` / `alive` / `label`；换载体只动 adapter
内部，上层零感知。

### 4.5 多 agent（batch）走 dsh 原生子 Agent

**决策**：batch 模式下由 dsh 原生 subagent 承担（`dsh-tool-subagent`，背景模式 `continuable`），
awf 不自派发。

**依据**：
- 原生子 Agent 天然属于同一个运行时 ⇒ **实时可见**（与 §2.5 的约束一致，自派发的子会话会重蹈
  「另一运行时」的覆辙）
- 其生命周期与末条消息由 `subagent.started` / `subagent.finished` 提供，后者带
  `lastAssistantMessage` —— 正好补上 §2.2 hook 侧缺失的 `last_assistant_message`

**对 awf 的影响**：
- 子 Agent 的 `RESULT` / `NEEDS_INPUT` 提取源从「SubagentStop hook payload」改为
  「`subagent.finished.lastAssistantMessage`」，由插件在运行时内捕获后回吐给 awf
- 落账路径不变：仍走 `awf_task_complete`（原子提交，避免中间态）
- `awf-worker` 的输出协议（RESULT / NEEDS_INPUT 最后一行）**保持不变**

**实现期需验证**：`lastAssistantMessage` 的类型是 `ContentBlock[]`（非纯字符串），
`server/adapters/cc/extract.cjs` 的解析逻辑需适配这一形态。

### 4.6 适配器选择与解析（「现在用的是哪个适配器」）

**现状（实测）：没有这个「地方」。** `createCcAdapters()` 在 `ports.cjs` 里定义好了但
**无任何生产调用点**；生产侧是 **12 个文件在 `require` 那一刻静态解构 cc 的句柄**：

`cli/lib/session.cjs` · `cli/commands/{init,plan,plugin}.cjs` · `server/web/api/run.cjs` ·
`server/features/monitor/index.cjs` · `server/features/decision/{gate,handler}.cjs` ·
`server/runtime/{index,project}.cjs` · `server/observability/run-logger.cjs` · `server/run/subagent.cjs`

**关键**：这 12 处的调用名**已经是能力名，不是 cc 名** —— `tooling` / `interactive` / `profile` /
`host` / `oneshot` / `probe` / `settings` / `extract`（9 个里 8 个不带 CLI）。
所以「换 adapter 要动上层」的根源**不在调用点，在 `ports.cjs` 只导出了 cc 的实现**。

**三层落地**

| 层 | 内容 | 落点 |
|---|---|---|
| **① 选择** | `runtime.adapter`：`'cc'`（缺省）\| `'dsh'`。缺字段按 `cc` 处理 ⇒ **老项目零影响** | `.awf/config.json` |
| **② 解析** | **唯一的解析点**：消费点不再解构具体实现，改为经它取当前 adapter 的句柄 | `server/adapters/ports.cjs` 内 |
| **③ 命名** | 名字不能带 CLI，否则上层写 `ccShapes` 却在用 dsh | `ccShapes` → `shapes`（消费者仅 `gate.cjs` / `handler.cjs`） |

**解析必须按项目，不能全局单例**

`server.cjs` 是**单实例多项目**（`createProjectRegistry`，`?p` 路由，每项目一个 runtime），所以
「当前 adapter」是**每项目**属性；CLI 侧（`init` / `plan` / `plugin`）是单次调用、天然有目标目录。

| 解析点形态 | 调用点 | 代价 |
|---|---|---|
| 全局单例（装配期绑定） | 零改动 | ❌ 多项目下不够用 |
| **按项目解析（带项目键）** | CLI 侧几处顶层解构要改成**延迟取** | 一次性动 `cli/`，之后**不再动第二次** |

**采用按项目解析** —— 这是「改动能限制在 adapters 内」的真实边界。

**三处必须动上层的既有泄漏（与 dsh 无关，是既有债务）**

| 泄漏 | 位置 | 说明 |
|---|---|---|
| `ctx.tmux` 注入面命名 | `server/runtime/project.cjs` · `index.cjs` | 运行时上下文里带着 CLI 机制名 |
| `ENTER_DELAY_MS` | `server/config.cjs` | 「tmux 分两次发」的节奏参数，是机制不是能力 |
| 5 处 tmux 直连 + `tmux attach` | `cli/lib/session.cjs` · `cli/commands/attach.cjs` | **现在就违反**「外部源码不碰 CLI 机制」，单 CLI 下没暴露 |

**这三处不管加不加 dsh 都该修，修完才是「改动限制在 adapters 内」的前提。**

**一个既有裁决需重审**：`ports.cjs` 的 `NON_PORT_TOOLS` 把 `cc-shapes` 裁为「不是端口」，
理由之一是「无可替换性诉求」。**多 CLI 下该理由站不住** —— 回写形状恰恰由 CLI 决定：

| | cc | dsh |
|---|---|---|
| 阻塞 | stdout JSON `{decision:'block', reason}` | **exit 2 + stderr** |
| 权限拒绝 | `hookSpecificOutput.permissionDecision: 'deny'` | 待定 |

而它现在**直接泄漏进领域层**（`gate.cjs` / `handler.cjs`）。应提升为端口，或至少由 adapter 提供。

---

## 5. 组件分解

### 5.1 目录布局（两半同在 `server/adapters/dsh/`）

```
server/adapters/dsh/
  index.cjs          # awf 侧：端口句柄（经 ports.cjs 出，外部不直连）
  host.cjs           # awf 侧：host 端口实现 —— SSE 指令下发 / 状态 / 打断
  session.cjs        # awf 侧：session 端口（start/stop）
  plugin/            # dsh 侧：插件包，被 dsh link 加载
    package.json     #   dsh.bundle 声明
    cordis.patch.yml #   自带条目（dsh 自动插入）
    lib/index.js     #   host half：运行时内创建/驱动会话
    lib/client.js    #   client half：UI 插件（见 §5.3）
```

`ports.cjs` 增加接线：新端口 `host`(改) / `session`(转正) 的 dsh 实现，与 `cc/` 并列。
上层（cli / server / 领域逻辑）通过 `createDshAdapters()` 取用，**与 `createCcAdapters()` 同形**。

### 5.2 插件包与引入流程（已实测验证）

```jsonc
// server/adapters/dsh/plugin/package.json
{
  "name": "@awf/dsh-adapter-plugin",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": { "default": "./lib/index.js" },
    "./client": { "default": "./lib/client.js" },   // client half（见 §5.3）
    "./cordis.patch.yml": "./cordis.patch.yml"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.2" }
}
```

引入（用户侧一条命令，零手工 patch）：

```bash
dsh plugin --profile web add link:<cc-control>/server/adapters/dsh/plugin
```

dsh 随后自动：① 装进 profile `node_modules`；② 追加进 `dsh.profile.bundles`；
③ 把插件自带 `cordis.patch.yml` 作为 patch 层插入；④ 启动时激活。

> ⚠️ **必须用 `link:` 不能用 `file:`**（实测踩坑）：`file:` 会**拷贝**且源目录变更**不刷新**
> （加了 `cordis.patch.yml` 后重装报 "Already up to date"，文件未进去 → 启动 `ENOENT` 崩）；
> `link:` 是**符号链接**，改代码立即生效。

### 5.3 client half（UI）—— ✅ 已实测，不是硬骨头

**结论：手写 lazy-CJS factory 即可，不需要复刻 tsdown 构建预设。**

官方 cookbook 说「本仓库之外的包得自行复刻同样的输出格式」—— 实测发现那个「格式」就是一段
几十行的薄壳，手写完全可行：

```js
// lib/client.js —— 无需任何构建工具
window.__ModuleLoader__.load({
  id: "@awf/dsh-adapter-plugin",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");                    // 外部依赖经 require 解析
    let jsx = require("react/jsx-runtime");
    // ... 组件与 apply
    exports.apply = apply;                           // cordis 插件三件套
    exports.inject = inject;
    return module.exports;
  }
});
```

`package.json` 侧（与 host half 同包）：

```jsonc
{
  "exports": {
    ".": { "default": "./lib/index.js" },
    "./client": { "default": "./lib/client.js" },
    "./cordis.patch.yml": "./cordis.patch.yml"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },     // host half 自动挂载
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-ui-renderer", "@deepseek-ai/dsh-client-ui-sidebar"]
    }
  }
}
```

**实测证据**：插件装上后 `div` + 按钮成功渲染在页面上；注册的 `conversation.view` entry
自动变成 tab（见 §6）。

**两条边界**：

- `dsh.client.inject` 声明的是**依赖的 client 包**（决定模块加载顺序），需与被注入的 slot owner 对应。
- 实测 `require("@deepseek-ai/dsh-client-ui-conversation")` 在**运行时可达**（能拿到该包的 client
  导出面）；但**构建期的 bundle 纯净度门禁拒绝跨插件值导入** —— 生产实现不应依赖它。

---

## 6. UI 挂载点（实测过的 slot 表）

**本节全部结论来自真机实测** —— 手写 client 插件 + browser-bridge 观测运行中的 `dsh web`。

### 6.1 候选 slot（实测）

| slot | kind | scope | 实测结果 |
|---|---|---|---|
| **`conversation.view`** | **list** | session | ✅ **注册 entry 即变成 tab** —— 实测「对话 / 轨迹」之后出现「AWF页面」 |
| **`conversation.input.right`** | **list** | session | ✅ **输入框右侧**，实测渲染 |
| `conversation.input.left` · `.overlay` · `.dock` | list | session | 未实测，同族同 kind |
| **`shell.overlay`** | **list** | **root** | ✅ Frame-wide floating layer，**无需会话**，实测贴右渲染 |
| `conversation.session.header.actions` | list | session | ⚠️ 实测渲染在**页面顶部、模式选择器旁**（不是对话框右上）；且 blank session 下整个 header 隐藏 |
| `conversation.session.header.corner` | **single** | session | ❌ 替换点 |
| `conversation.composer.bar` | **single** | session-maybe | ❌ 已被 attachments / plan / model 占 |
| `sidebar.right.pane.tab` | **keyed** | session | 官方右栏 tab 路径，用新 key 是增量 |
| **`rightbar`** | **single** | root | ❌ **已被 `rightbar.session` 占用** —— 抢它就是替换现有右栏 |

**⚠️ blank session 会隐藏 header**（`ConversationSessionHeader` 源码）：

```js
const hideChrome = session.blank && conversationPhase(session, conversation) === "blank";
```

→ `conversation.session.header.*` 这几个 slot **只在有内容的会话里可见**，不能当常驻入口。
这解释了实测中「空白会话下 header 动作不渲染」。

### 6.2 5 项功能的落点

| # | 功能 | 落点 | 状态 |
|---|---|---|---|
| 1 | 新「模式」（标准/PTC/极简/创造） | `conversation.composer.bar` 是 **single**（已被占）；候选改为 `conversation.input.left` / `.right` | **用户已表示暂缓** |
| 2 | 插件设置页 | Host `ctx.settings.installSection()` + Browser `settings.plugin.item` | 官方 cookbook 明言零改仓库 |
| 3 | 按钮 / 切换 | 实测 `conversation.session.header.actions` 落在**页面顶部模式旁**，位置尴尬；**候选改为侧边**（`shell.overlay`，root 级常驻、不依赖会话） | 位置待定 |
| 4 | ~~最右侧页面切换条~~ | **不做**（理由见 6.3） | **已决** |
| 5 | 新增 2-3 个中心页面 | **`conversation.view`** —— 注册 entry 即变 tab，`order` 决定顺序、`label` 决定文字 | ✅ 实测通过 |

### 6.3 #4 撤销的理由

原计划「最右侧加切换条」基于「需要自己造切页入口」的假设。实测推翻了它：

1. **dsh 本来就有 tab 行** —— 「对话 / 轨迹 /（我们注册的页面）」就在对话页顶部，点击即切
2. **程序化切换没有公开路径**（实测）：
   - `selectView(viewId)` 是注入给 **header owner 组件**的 prop，其子 slot 都拿不到
   - 存 View 选择的 per-session store（`createConversationStore`）**未从 client 运行时导出**
   - `UiConversation` / `ConversationController` 的**全量方法**已逐个探过，**无 view 切换**

→ **不做右侧切换条**。tab 行已满足需求，强做还得绕过 store（脆弱）。
若将来确需程序化切换，只能走「让上游暴露接口」。

---

## 7. 错误处理

| 场景 | 处理 |
|---|---|
| 插件未加载 / 运行时不可达 | `host.alive()` 返回 false，`submit` 失败 → 走 executor 现有错误路径 |
| **SSE 断流** | 即 `alive()` 为 false。插件按重连退避恢复；`awf run` 期间持续断流则按会话丢失处理 |
| 用户关闭 dsh web | 运行时随之消失 → 编排无法进行。**dsh 模式下 web 是必需前置**（见 §8） |
| 会话中断（用户点停止） | 插件观测到 `turn/end { reason: interrupted }` → 回吐给 awf，按 blocked 处理 |
| 进程终止 | **优先优雅退出**（`shutdown` 而非 SIGKILL）。实测 SIGKILL 后页面渲染出「失败 + 崩溃修复」假象（整页重载后恢复完整）—— 教训是**停止方式会影响页面观感**，实现期需验证优雅退出能否消除该现象 |
| 决策门阀 | 不走 hooks；由 awf 通过 `interrupt` + `submit` 驱动 |

---

## 8. 前置与约束

1. **dsh 模式必须开着 web 页面** —— 这是用户已确认的使用方式，也是 D 方案成立的隐含前提。
2. **server 单实例** —— awf server 仍是单实例（`?p` 路由多项目），插件按 `AWF_PROJECT_ROOT` 寻址。
3. **`awf_read_state` 返回体收敛**（§2.1）是独立待办，不阻塞本设计但需同期处理。
4. `pnpm-workspace.yaml` 用 glob，新建包不改上游清单 —— 但**本设计的插件住在 cc-control 仓库内**，
   不经 dsh 的 workspace。
5. **观测落盘方式的方向性变化**（用户已述）：cc 下 awf 靠 `capture-pane` 抓屏 + 落盘文件供复盘，
   后续方向是**改为存储**并推送到 web 页面。dsh 下这两件事由平台自带（会话就在页面里、dsh 自带
   存储），因此**本设计不为「观测」单独造通路** —— 与 §3.0 的判据一致。

---

## 9. 测试策略

### 9.1 三层结构

| 层 | 测什么 | 按 adapter 分跑？ |
|---|---|---|
| **① 编排测试** | executor 等待语义 / scheduler / 决策门阀 / channel 收尾 —— **CLI 无关的逻辑** | ❌ **不分**。跑一次，注入契约替身 |
| **② 一致性测试（conformance）** | **每个 adapter 都必须满足的同一条契约** | ✅ **同一套测试，每个 adapter 各跑一遍** |
| **③ adapter 专属测试** | cc 的 tmux 参数拼装 / dsh 的 SSE 协议与 service 调用 | ✅ 各跑各的 |

**关键区分**：现有 18 个测试文件里，`server.test.js`(22 处) / `decision.test.js`(14 处) 这类
**属第①层** —— 它们断言的是「派发时投了这段文本」「暂停时没投」，是**编排行为**。
把它们按 adapter 分跑会跑重复且失去意义。

### 9.2 脚本

```bash
pnpm test               # 全量
pnpm test:orchestration # ① 编排（CLI 无关，走契约替身）
pnpm test:ada:cc        # ②③ cc：conformance + cc 专属
pnpm test:ada:dsh       # ②③ dsh：conformance + dsh 专属
```

### 9.3 一致性套件

```js
// tests/conformance/adapter-contract.test.js —— 一份测试，对每个 adapter 各跑一遍
describe.each(ADAPTERS)('adapter contract: %s', (name) => {
  const subject = makeConformingSubject(name);   // cc: 注入 execFileSync；dsh: 假 awf server + 假插件
  it('label 是非空字符串', …)
  it('alive() 返回 boolean', …)
  it('submit(text) 返回是否受理', …)
  it('interrupt() 不抛', …)
  it('snapshot() 返回 string 或 null', …)
})
```

| 能测 | 例 |
|---|---|
| **形状** | 方法存在、返回类型、参数个数 |
| **可观察语义** | `alive()` 在不可达时返回 false；`interrupt()` 幂等不抛 |
| **契约自检** | 契约声明的必填方法在实现上真实存在（**加载期断言**，见 §3 硬约束第 4 条） |

| 测不了（也不该测） | 例 |
|---|---|
| **内容细节** | `snapshot()`：cc 返回 pane 文本、dsh 返回渲染文本 —— 只能断言「返回 string」 |
| **实现方式** | cc 发几条 tmux 命令、dsh 走不走 SSE |

### 9.4 这决定了第①层的改造方向

第①层要从「tmux 词汇」迁到「契约词汇」：

```js
expect(m.tmux.sendText).toHaveBeenCalledWith(…)   // 旧
expect(adapter.submit).toHaveBeenCalledWith(…)    // 新
```

改完之后：编排测试**与 CLI 无关**；将来加 dsh（或 codex / pi）**这些测试一行不用动**。

**所以测试侧是「改」而非「加」** —— 不是被动跟着契约改名，而是主动把测试提到契约层。
「加」的正确落点是**新增一致性套件**与**契约自检**，不是给测试加别名（加了会「绿而不验」，
且留下「测试说旧词、代码用新词」的长期不一致）。

### 9.5 已知成本

dsh 的一致性测试需要**跑得起来的环境**（awf server + 插件 + 运行时，或一套假件）；cc 只要注入
`execFileSync`。**一致性套件因此需要一层 per-adapter 测试夹具** —— 这是新增工作量，
不做的话 `test:ada:dsh` 落不了地。

### 9.6 回归门槛

`npm test` 全绿 + cc 路径 e2e（`npm run test:eval`）通过。
`tests/unit/ports-contract.test.js` 与 `tests/unit/host.test.js` 作为契约形状的第一道闸。

---

## 10. 已定决策

| 项 | 决策 | 落点 |
|---|---|---|
| 多 agent（batch）形态 | **走 dsh 原生子 Agent**（`dsh-tool-subagent`，背景模式 `continuable`） | §4.5 |
| awf ↔ 插件 通道 | **SSE**（server → 插件推指令；反向走普通 POST） | §4.4 |
| `snapshot()` | **保留在端口契约里**（按目的表述；dsh 实现返回内容，非 `null`） | §4.2 |
| 适配器选择 | **`.awf/config.json` 的 `runtime.adapter`**（缺省 `cc`，老项目零影响）；解析在 `ports.cjs` 内、**按项目** | §4.6 |
| 命名去 CLI 化 | `ccShapes` → `shapes`（消费者仅 2 处） | §4.6 |
| 测试分层 | 编排测试 CLI 无关；`test:ada:cc` / `test:ada:dsh` 只跑一致性 + 专属 | §9.1 |
| 契约自检 | 加**可执行的必填方法名断言**（加载期失败，替代现在的文字名册） | §3 · §9.3 |
| 测试侧走「改」 | 机械迁移到契约词汇，不给测试加别名 | §9.4 |
| **client half 构建** | **手写 lazy-CJS factory**，不需要复刻 tsdown 构建预设 | §5.3 |
| **UI 页面入口** | **`conversation.view`** —— 注册 entry 即变成 tab（实测「对话/轨迹」后加页成功） | §6.2 |
| **UI 按钮位置** | 候选改为**侧边** `shell.overlay`（root 级、常驻、不依赖会话）；原 `header.actions` 落在页面顶部模式旁，位置尴尬 | §6.2 |
| **UI 右侧切换条** | **不做** —— 对话框顶部本就有 tab 行可手动切；程序化切换无公开路径 | §6.3 |

## 11. 仍未验证

1. **per-adapter 一致性夹具**（§9.5）—— dsh 侧怎么在测试里起一个可用环境（或假件）尚未设计。
2. **设置页（§6.2 #2）** —— 官方 cookbook 描述的路径本身未实测（`settings.plugin.item` +
   Host 半侧 `settings.installSection()`）。

> 原第 1 项「client half 构建」**已实测通过**（§5.3）—— 手写 lazy-CJS factory 即可。

---

## 12. 落地顺序（建议）

1. **契约与债务收口**（一次到位，见 §3 硬约束 —— **这是风险最高的一步**）：
   `host` 新契约 + cc 实现改造 + 12 处消费点 + 3 个替身 + 18 个测试文件；
   同批补 `cli/lib/session.cjs` 的 5 处 tmux 直连、`session` 端口转正、
   `ctx.tmux` → `ctx.host`、`ENTER_DELAY_MS` 下沉进 cc 实现、`ccShapes` → `shapes`；
   **加契约自检**（可执行的必填方法名断言）。`npm test` 全绿是门槛。
2. **适配器解析点**（§4.6）：`.awf/config.json` 的 `runtime.adapter` + `ports.cjs` 内按项目解析。
3. **测试分层**（§9）：抽出编排层（CLI 无关）+ conformance 套件 + `test:ada:*` 脚本 + dsh 夹具。
4. **dsh 落地**：`server/adapters/dsh/` awf 侧（SSE 指令通道 / 状态 / 打断）+ `plugin/` host half。
5. **UI**（§5.3 / §6）：client half（手写 factory）→ 页面入口（`conversation.view`）→
   设置页（#2）→ 按钮（#3，位置待定）。
