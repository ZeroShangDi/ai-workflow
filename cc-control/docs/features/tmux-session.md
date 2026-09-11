# tmux 会话 & awf-session 观测 — 功能文档

> 对应 WBS：W3-004（adapters/cc 工具适配收口）/ W3-006（多 run sid 贯穿）
> 源码：`src/server/tmux.cjs` + `src/server/host.cjs` + `scripts/bootstrap.sh` + `plugin/core/mcp/awf-session/server.cjs`
> 装配：`src/lib/run-context.cjs`（会话名/路径单源）

## 功能描述

awf 的自治执行跑在一个 **tmux 会话**里：会话内是 Claude Code（`claude`），CLI/server 通过 tmux
原语向它派发文本、抓取 pane。两个方向：

```
CLI/server ──tmux 原语(send-keys/capture-pane)──→ tmux 会话(内跑 claude)
   tmux 会话内 claude ──awf-session MCP(HTTP)──→ Session Server ──→ tmux 原语
```

### 会话命名：`cc-<projectSid>`

会话名由 `run-context.cjs` 单源装配（`src/lib/run-context.cjs`）：

| 字段 | 值 | 位置 |
|------|-----|------|
| 基础名 `session` | config `runtime.session` / `CC_SESSION`（缺省 `cc`） | `run-context.cjs:45,66`（`getSessionName`） |
| `runSessionName` | 有 sid → `${session}-${sid}`；无 sid → 基础名 | `run-context.cjs:46,68` |
| `projectSid(projectRoot)` | `'p'` + `sha1(resolve(root)).slice(0,12)`（确定性、跨重启稳定） | `run-context.cjs:131-135` |
| `projectSessionName(projectRoot)` | `${session}-${projectSid(root)}` | `run-context.cjs:143-145` |

即实跑会话名形如 **`cc-p<12位hex>`**。`awf run` 用 `projectSid(projectRoot)` 作 sid 传入
（`src/cli/run.js:51`），保证同一项目跨 CLI/server/重启产生同一会话名，`--resume`/`--attach` 可重发现。

### 会话启动：live 走 `scripts/bootstrap.sh`（未收口）

会话的**创建**当前仍在 shell 里完成，**适配器版从未接线**（`ports.cjs` 的 `session` 端口登记为
`not-landed`，责任任务 T1-113）：

```
src/cli/run.js ensureSession()               （src/cli/run.js:233-268）
  → 可选复用：tmux display-message -p -t <session> "#{pane_current_path}" 比对 workDir（:236-248）
  → 否则 kill 旧会话 → execSync(`bash "${bootstrapScript}"`, { cwd: workDir, env: {...} })（:250-265）
       env 注入：CC_WORKDIR / CC_SESSION / CC_PROJECT / CC_AWF_STATE_SERVER=1 / CC_PORT
  → 新建后 waitSessionStarted() 等真实就绪（SessionStart 到达，sessionSeq 增长；超时不硬失败）
scripts/bootstrap.sh
  → 前置检查 tmux / claude / node 在 PATH
  → 已存在同名会话则退出（不重建）
  → tmux new-session -d -s "$SESSION" -x 200 -y 50 -c "$WORKDIR" \
        "env -u CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC … $ENV_ASSIGNS \
             claude --permission-mode bypassPermissions --settings \"$WORKDIR/.awf/run-settings.json\""
  → tmux set-option -t "$SESSION" history-limit 100000
  → sleep 3 && tmux send-keys -t "$SESSION" Enter      # 消除文件夹信任弹窗
```

`bootstrap.sh` 只负责启动 tmux + claude，**不做任何插件/hooks/MCP 渲染** —— 那由项目
`.claude/settings.json`（`awf init` 本地注入 / 全局 `claude plugin install`）注册加载。

### 环境注入（`bootstrap.sh`）

tmux 新建会话里进程拿到的环境 = tmux **全局** env（当初启动 tmux server 的 run 的环境），不是调用
bootstrap 的本进程 env。并发多 run / 机器上残留别项目会话时，claude 会继承别项目的 `CC_PROJECT`/
`CC_WORKDIR`，导致 hook 路由与 awf-state MCP 读写落到别人项目。**故 run 会话来的一切 env 均显式赋值**
（`bootstrap.sh` `ENV_ASSIGNS`）：

| 变量 | 是否必给 | 来源/说明 |
|------|----------|-----------|
| `CC_SESSION` | 必给 | 会话名（`$SESSION`） |
| `CC_WORKDIR` | 必给 | `$WORKDIR`（run 项目根） |
| `CC_PROJECT` | 条件（run 时给） | 项目根（hook 网关 `&p=` 路由 / awf-state `PROJ_ROOT`） |
| `CC_PORT` | 条件 | Session Server 端口 |
| `CC_AWF_STATE_SERVER` | 条件（run 时 `1`） | 令 awf-state MCP 经 server run api 读写（单写者） |
| `CC_SID` | 条件 | 仅用于 tmux 会话名唯一化，不作主 run 寻址 |

同时 `env -u` 去掉 telemetry/feature-flag 类变量（`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`、
`DISABLE_TELEMETRY`、`DO_NOT_TRACK`、`DISABLE_GROWTHBOOK`）。新增 run 级变量须同步加到这里。

### 两层 tmux 原语

| 层 | 文件 | 方式 | 用途 |
|-----|------|------|------|
| Server 侧（单会话） | `src/server/tmux.cjs` | `execFileSync('tmux', …)` | server/project-context 向 tmux 发指令（`createTmux(sessionName)`，默认实例名来自 `buildRunContext().runSessionName`，`tmux.cjs:54`） |
| host 端口（参数化） | `src/server/host.cjs` | `execFileSync('tmux', …)` | `createHost({ sessionName, execFileSync })`，同名原语、会话名参数化；经 `ports.cjs` 作 `host` 端口暴露 |
| MCP 侧 | `plugin/core/mcp/awf-session/server.cjs` | HTTP 到 server + 降级本地 `execSync('tmux', …)` | 会话内 claude 观测自身会话 |

> **未收口**：`tmux.cjs` / `host.cjs` 里的 `execFileSync('tmux', …)` 字面仍在 `src/server/`
> （审计 F3/F5），尚未迁入 adapters；`host` 端口虽在名册，其实现仍在 server。

### 发送与抓取

`tmux.cjs` / `host.cjs` 提供同一组原语：

| 原语 | tmux 命令 | 说明 |
|------|-----------|------|
| `hasSession()` | `has-session -t <session>` | try/catch；异常 → false |
| `sendText(text)` | `send-keys -t <session> -l <text>` | `-l` literal（不解释 tmux 快捷键） |
| `sendEnter()` | `send-keys -t <session> Enter` | 提交当前输入 |
| `sendCtrlC()` | `send-keys -t <session> C-c` | 中断当前 Claude 响应 |
| `capture()` | `capture-pane -t <session> -p -S -` | `-S -` 从回滚起点抓全文（否则旧消息丢） |

## 执行流程（awf-session MCP）

```
awf-session MCP（stdio JSON-RPC）
  initialize → protocolVersion '2024-11-05'，serverInfo.name 'awf-session-mcp'
  tools/list → 7 个 tool
  tools/call → switch(name)：
    awf_session_status    → GET /status?<sid&p> + capture preview（前 500 字符）
    awf_capture_pane      → capturePane()：优先 GET /status?snapshot=1（server 经 host 抓），失败降级本地 execSync tmux
    awf_session_intervene → POST /intervene?<sid&p>   {text, reason}
    awf_session_interrupt → POST /intervene/interrupt?<sid&p>  {reason}
    awf_await_choice      → POST /choice?<sid&p>      （入口已停用，见下）
    awf_await_input       → POST /ask?<sid&p>         （入口已停用，见下）
    awf_context_ready     → POST /context-ready?<sid&p>
```

- **读写都带 query**（`sessionQuery()`，`server.cjs:23-28`）：`sid` 命中本 run 槽，`p` 多项目路由到本项目。
  写端点此前漏带 → 多项目下静默写错项目（T1-110 收口）。
- **`AWF_BASE` 缺失即抛**（`:31-35`）：配置错误显式暴露，不回落硬编码地址；工具分发层 catch 后以错误文本返回。
- 会话名来源 `CC_SESSION`（`server.cjs:13`，**不内嵌 `'cc'` 默认**）。

### 决策入口已停用（T1-106）

`awf_await_choice` / `awf_await_input` 两个 MCP tool **仍存在于工具面**，但其作为**决策入口已停用**
（2026-09-10）。awf run 阶段需要决策时改用**决策门阀**：把问题作为本回合最后一段以
`<AWF_DECISION_REQUIRED>…</AWF_DECISION_REQUIRED>` 包裹输出，由决策技能（decision-core）自决产出
Decision Result。禁止抛回用户、禁止列选项干等。参见 `plugin/core/skills/awf-run-decision/SKILL.md`
头部停用说明与 `CLAUDE.md` 的 awf-run 模式规则；`plugin/core/agents/awf-worker.md` 也禁止子 Agent
调用这两个工具。

### w-monitor 受控介入

w-monitor 的修复单元通过 `awf_session_intervene` / `awf_session_interrupt` 操作会话（`awf-monitor-repair.md`），
Server 端强制校验 **mode=pause**（`server.cjs` `/intervene` 走 `requirePaused`）：

| 端点 | 前置校验 | 行为 |
|------|----------|------|
| `POST /intervene` | body `{text}` 非空 + mode=pause + `hasSession()` | 记日志 → setBusy → `submit(text)`；返回 `{ok, sent, intervention:true}` |
| `POST /intervene/interrupt` | mode=pause + `hasSession()` | `sendCtrlC()` + clearDecision + 兜底定时器；返回 `{ok, interrupted, reason}` |

不得用 Bash 直接 `tmux send-keys`（绕过 pause 闩锁复核）。

## 核心常量 / 配置

| 常量 | 值 | 说明 |
|------|-----|------|
| 会话名 | `cc-<projectSid>` | `run-context.cjs`（基础名 `cc` + `p<12hex>`） |
| `AWF_BASE` | `http://127.0.0.1:8787`（`plugin/core/.mcp.json` 注入） | MCP→server 地址 |
| `CC_HTTP_TIMEOUT_MS` | `3000`（可 env 覆盖） | httpGet/httpPost 超时 |
| `history-limit` | `100000` | bootstrap.sh 设，避免长会话旧消息被截断 |
| pane 尺寸 | `-x 200 -y 50` | `tmux new-session` 显式尺寸 |
| capture preview | 前 500 字符 | `awf_session_status` 附加 pane 预览 |

## 函数清单

| 函数 | 说明 | 位置 |
|------|------|------|
| `createTmux(sessionName)` | 构建 tmux 原语集合（`SESSION`/hasSession/sendText/sendEnter/sendCtrlC/capture） | `src/server/tmux.cjs:14` |
| `createHost({ sessionName, execFileSync })` | 参数化 tmux 原语（host 端口工厂） | `src/server/host.cjs:18` |
| `buildRunContext({ sid, projectRoot, env })` | 装配会话名/路径/端口 | `src/lib/run-context.cjs:42` |
| `projectSid(projectRoot)` | 确定性项目 sid | `src/lib/run-context.cjs:131` |
| `ensureSession(bootstrapScript, workDir, sessionName, reuseExisting)` | 起/复用 tmux 会话（调 bootstrap.sh） | `src/cli/run.js:233` |
| `waitSessionStarted(ctx, workDir, seqBefore, deps)` | 等 SessionStart 就绪（补 Enter 兜信任弹窗） | `src/cli/run.js:171` |
| `capturePane()` | 经 server snapshot，失败降级本地 tmux | `plugin/core/mcp/awf-session/server.cjs:78` |
| `sessionQuery()` | 拼 `?sid=&p=` | `plugin/core/mcp/awf-session/server.cjs:23` |

## 接口 / 依赖

| 模块 | 用途 |
|------|------|
| `src/lib/run-context.cjs` | 会话名/端口/路径单源 |
| `src/lib/runtime-config.cjs` | `getSessionName` / `getServerPort`（config + CC_* env） |
| `src/server/tmux.cjs` | 单会话 tmux 原语（server/project-context 消费） |
| `src/server/host.cjs` | 参数化 tmux 原语（host 端口实现，仍在 server） |
| `scripts/bootstrap.sh` | 会话 live 启动（shell，未适配器化） |
| `plugin/core/.mcp.json` | 注册 awf-session MCP（env `AWF_BASE`） |
| `node:http` | MCP→server |
| `child_process.execSync` | bootstrap 启动 / capturePane 降级 |

## 验收标准

- [ ] 实跑会话名为 `cc-<projectSid>`，同一 projectRoot 跨重启稳定
- [ ] `bootstrap.sh` 前置检查 tmux/claude/node，存在同名会话时不重建
- [ ] run 会话 env 经 `ENV_ASSIGNS` 显式赋值（不依赖 tmux 全局 env）
- [ ] sendText 用 `-l` literal；capture 用 `-S -` 抓全文
- [ ] `awf-session` `tools/list` 返回 7 个 tool（含 intervene/interrupt/context_ready）
- [ ] `awf_session_status` pane 预览截取前 500 字符
- [ ] `awf_capture_pane` 优先 server snapshot，失败降级本地 tmux 不抛
- [ ] `awf_session_intervene`/`interrupt` 走 `/intervene`(`/interrupt`)，server 强制 mode=pause
- [ ] `awf_await_choice`/`awf_await_input` 仍可调用但作为决策入口已停用（改用决策门阀）
