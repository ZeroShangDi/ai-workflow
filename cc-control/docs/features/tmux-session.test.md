# tmux 会话 & awf-session 观测 — 测试用例

> 对应功能文档：`docs/features/tmux-session.md`
> 源码：`src/server/tmux.cjs` + `src/server/host.cjs` + `src/lib/run-context.cjs` + `src/cli/run.js` + `scripts/bootstrap.sh` + `plugin/core/mcp/awf-session/server.cjs`
> 测试文件：`tests/unit/tmux.test.js`、`tests/unit/host.test.js`、`tests/unit/run-context-project-sid.test.js`、`tests/unit/session-ready-wait.test.js`、`tests/integration/bootstrap.test.js`、`tests/integration/awf-session.test.js`

## 测试场景总览

### tmux.cjs（`tmux.test.js`）— 9 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 1 | hasSession 存在 → true | 正常 |
| 2 | hasSession 不存在 → false（catch 不抛） | 异常 |
| 3 | sendText 拼 args（`-l` literal） | 参数验证 |
| 4 | sendEnter 拼 args | 参数验证 |
| 5 | capture 拼 args（`-p -S -`）并返回 stdout | 参数验证 |
| 6 | sendText 异常向上传播（不 catch） | 异常 |
| 7 | SESSION 默认值 `cc` | 边界 |
| 8 | CC_SESSION 覆盖 SESSION | 边界 |
| 9 | sendCtrlC 拼 args（`C-c`） | 参数验证 |

### host.cjs（`host.test.js`）— 3 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 10 | 原语按传入 sessionName 命中 tmux 命令（`cc-r1`） | 参数验证 |
| 11 | hasSession 无会话抛错→false；capture 返回 pane 文本 | 正常/异常 |
| 12 | 缺省 sessionName = `cc` | 边界 |

### 会话命名（`run-context-project-sid.test.js`）— 7 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 13 | projectSid 同 root 结果确定一致 | 确定性 |
| 14 | 不同 root 结果相异 | 确定性 |
| 15 | projectSid 合法：`p` + 12 hex（匹配 SID_PATTERN，≤64） | 边界 |
| 16 | projectSessionName = `${session}-${projectSid}` | 命名 |
| 17 | 两项目会话名唯一（互不 kill） | 命名 |
| 18 | 纯标签：不派生 `.awf/runs/<sid>` | 隔离 |
| 19 | CLI/server 会话名一致（buildRunContext === projectSessionName） | 一致性 |

### 会话就绪等待（`session-ready-wait.test.js`）— 4 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 20 | sessionSeq 增长 → 放行，且不补 Enter | 正常 |
| 21 | 始终未收到 SessionStart → 超时返回 false（告警放行） | 超时 |
| 22 | 等待期间周期性补 Enter（兜信任弹窗） | 容错 |
| 23 | 拿不到 status（服务不可达）不抛，按未就绪处理 | 异常 |

### bootstrap.sh（`bootstrap.test.js`）— 11 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 24 | tmux 未安装 → exit 1 | 前置 |
| 25 | claude 未安装 → exit 1 | 前置 |
| 26 | node 未安装 → exit 1 | 前置 |
| 27 | 不渲染 settings.json/.mcp.json（不覆盖项目注册） | 加载链路 |
| 28 | session 不存在 → 创建（claude 无 `--plugin-dir`） | 会话 |
| 29 | session 已存在 → exit 0 不创建 | 会话 |
| 30 | CC_SESSION 环境变量 → 自定义名称 | 会话 |
| 31 | tmux new-session 参数验证（`-d -s cc -x 200 -y 50 -c <workdir>`） | 参数验证 |
| 32 | run 会话 env 显式注入 claude（不依赖 tmux 全局 env） | 环境 |
| 33 | 未提供的 run 变量不写出空赋值 | 环境 |
| 34 | trust prompt 消除（`sleep 3` + `send-keys Enter`） | 会话 |

### awf-session MCP（`awf-session.test.js`）— 18 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 35 | awf_session_status 正常（pane 500 字符截取） | 正常 |
| 36 | awf_capture_pane 经 `GET /status?snapshot=1`（降级本地 exec） | 正常 |
| 37 | awf_session_intervene → `POST /intervene` | 正常 |
| 38 | awf_session_interrupt → `POST /intervene/interrupt` | 正常 |
| 39 | awf_await_choice 正常 → `POST /choice` | 正常 |
| 40 | awf_await_input 正常 → `POST /ask` | 正常 |
| 41 | awf_await_choice args 解构（bug 已修） | 回归 |
| 42 | awf_await_input args 解构（bug 已修） | 回归 |
| 43 | awf_context_ready → `POST /context-ready` | 正常 |
| 44 | 未知 tool name → error | 异常 |
| 45 | httpGet Server 可达 → 解析 JSON | HTTP |
| 46 | httpGet 连接拒绝 → `{ok:false,error}` | HTTP |
| 47 | httpGet 超时 → `{ok:false,error:'timeout'}` | HTTP |
| 48 | httpPost 正常（content-type/content-length） | HTTP |
| 49 | capturePane execSync 异常 → 不抛，`(capture failed:)` | 异常 |
| 50 | JSON-RPC initialize | 协议 |
| 51 | JSON-RPC tools/list 返回 7 个 tools | 协议 |
| 52 | JSON-RPC 未知 method → -32601 | 协议 |

---

## 详细测试用例

### TC1-TC9: tmux.cjs 原语

**前置条件**：`global.__CC_EXEC_FILE_SYNC__` 注入 mock `execFileSync`；`vi.resetModules()` 后重新 import（SESSION 在模块顶层读取）
**执行 / 断言**：

| TC | 执行 | 断言（mock 收到） |
|----|------|-------------------|
| 1 | `hasSession()` | `('tmux', ['has-session','-t','cc'], {encoding:'utf8'})`，返回 true |
| 2 | exec 抛错后 `hasSession()` | 返回 false，不抛 |
| 3 | `sendText('hello world')` | `['send-keys','-t','cc','-l','hello world']` |
| 4 | `sendEnter()` | `['send-keys','-t','cc','Enter']` |
| 5 | `capture()` | `['capture-pane','-t','cc','-p','-S','-']`，返回 mock stdout |
| 6 | exec 抛错后 `sendText('x')` | 抛 `'tmux broken'`（不 catch） |
| 7 | 无 CC_SESSION 时 `SESSION` | `'cc'`，命令用 `-t cc` |
| 8 | `CC_SESSION='my-session'` 时 | `SESSION==='my-session'`，命令用 `-t my-session` |
| 9 | `sendCtrlC()` | `['send-keys','-t','cc','C-c']` |

### TC10-TC12: host 端口（会话名参数化）

**前置条件**：`createHost({ sessionName, execFileSync: stub })`
**执行 / 断言**：
- TC10：`host.hasSession()`/`sendText`/`sendEnter`/`sendCtrlC` 收到 `sessionName='cc-r1'` 的命令序列（含 `-l 'hi'`、`C-c`）
- TC11：`hasSession` 抛错 → false；`capture()` 返回 pane 文本
- TC12：缺省 `sessionName==='cc'`

### TC13-TC19: 会话命名（run-context）

**执行 / 断言**：
- `projectSid(root)` 两次调用相等；不同 root 相异；形如 `^p[0-9a-f]{12}$` 且匹配 SID_PATTERN
- `projectSessionName(root)` === `${基础名}-${projectSid(root)}`；两项目会话名不等
- `projectSessionName` 纯标签：不产生 `.awf/runs/<sid>` 派生
- `buildRunContext({ sid: projectSid(root) }).runSessionName === projectSessionName(root)`（CLI 与 server 命名一致）

### TC20-TC23: 会话就绪等待（waitSessionStarted）

**前置条件**：注入 `status`/`nudge`/`sleepFn` 依赖
**断言**：
- TC20：`sessionSeq` 增长 → 返回 true 且未调 `nudge`
- TC21：始终不增长 → 超时返回 false（告警放行，不硬失败）
- TC22：等待期间按 `nudgeMs` 周期补 Enter
- TC23：`status` 不可达 → 不抛，按未就绪处理

### TC24-TC34: bootstrap.sh

**前置条件**：脚本级测试（PATH/命令打桩为 `STUB_LOG`，或真实 bash 执行）
**断言**：缺 tmux/claude/node → exit 1（TC24-26）；不覆盖项目 settings.json/.mcp.json（TC27）；会话不存在则创建、启动命令 `claude --permission-mode bypassPermissions` 且**无 `--plugin-dir`**（TC28）；会话已存在 → `already exists` exit 0 不 `new-session`（TC29）；`CC_SESSION` 覆盖会话名（TC30）；new-session 行含 `-d -s cc -x 200 -y 50 -c <WORKDIR>`（TC31）；给 `CC_PROJECT`/`CC_PORT`/`CC_AWF_STATE_SERVER` 时 new-session 行显式含 `CC_SESSION="cc-env"`/`CC_WORKDIR="…"`/`CC_PROJECT="…"`/`CC_PORT="8899"`/`CC_AWF_STATE_SERVER="1"` 且保留 `-u DISABLE_GROWTHBOOK`（TC32）；未提供的变量不写出空赋值（TC33）；含 `sleep 3` + `send-keys … Enter` 消除信任弹窗（TC34）

### TC35-TC52: awf-session MCP

**前置条件**：`global.__CC_EXEC_SYNC__` 注入 mock execSync；启动真实 mock HTTP server（记录 `requests`，`/status` 返 `{ok,state:'ready',session:true}`）；`process.env.AWF_BASE=baseUrl`、`CC_SESSION='cc'`
**执行 / 断言**：

| TC | 执行 | 断言 |
|----|------|------|
| 35 | `awf_session_status` | text 含 `"state": "ready"`；`pane` 长度 500；首个请求 url `/status` |
| 36 | `awf_capture_pane` | 含完整 pane 文本；末请求 url `/status?snapshot=1`（server 无 snapshot → 降级本地 exec） |
| 37 | `awf_session_intervene {text,reason}` | 请求 url `/intervene`，body `{text,reason}` |
| 38 | `awf_session_interrupt {reason}` | 请求 url `/intervene/interrupt`，body `{reason}` |
| 39 | `awf_await_choice {question,options}` | POST `/choice`，body `{question,options}` |
| 40 | `awf_await_input {question}` | POST `/ask`，body `{question}` |
| 41 | `awf_await_choice {question,options,context}` | body 完整透传（args 解构 bug 已修） |
| 42 | `awf_await_input {question,context}` | body 完整透传 |
| 43 | `awf_context_ready` | POST `/context-ready` |
| 44 | `unknown_tool` | text 含 `"ok": false` 与 `unknown tool: unknown_tool` |
| 45 | `httpGet('/status')` | 返回解析对象 `{ok,state,session}` |
| 46 | 指向 dead port `httpGet` | `ok:false`，error 含 `ECONNREFUSED` |
| 47 | 指向慢 server `httpGet`（timeout 80ms） | `{ok:false, error:'timeout'}` |
| 48 | `httpPost('/choice', …)` | `{ok:true}`；header `content-type: application/json`、`content-length` 正确 |
| 49 | execSync 抛错后 `capturePane()` | `'(capture failed: no session)'`（不抛） |
| 50 | `initialize` | `protocolVersion '2024-11-05'`、`capabilities {tools:{}}`、`serverInfo.name 'awf-session-mcp'` |
| 51 | `tools/list` | names === `['awf_session_status','awf_capture_pane','awf_session_intervene','awf_session_interrupt','awf_await_choice','awf_await_input','awf_context_ready']`，各含 name/description/inputSchema |
| 52 | 未知 method | `error.code === -32601`，message `method not found: unknown/method` |

---

## Mock 策略

| 依赖 | Mock 方式 | 说明 |
|------|-----------|------|
| `tmux.cjs` 的 `execFileSync` | 注入 `global.__CC_EXEC_FILE_SYNC__` + `vi.resetModules()` | 原生 CJS，`vi.mock` 拦不到；resetModules 才能重读 CC_SESSION |
| `host.cjs` 的 `execFileSync` | `createHost({ execFileSync: stub })` 参数注入 | 记录 calls 断言命令序列 |
| awf-session 的 `execSync`（capturePane 降级） | 注入 `global.__CC_EXEC_SYNC__` | 控制返回值/异常 |
| awf-session 的 HTTP | 启动真实 mock `http` server | 记录 url/body/headers，返回 canned JSON |
| `AWF_BASE` | `process.env` 设置/切端口 | 可达 / 拒绝 / 超时三态 |
| awf-session 的 stdio | 直接调 `handlers` 对象 + `handleMessage`（`process.stdout.write` 打桩） | 绕过 JSON-RPC 传输层 |
| bootstrap.sh | 真实 bash 执行 + PATH/CC_* 打桩 | 验证前置检查与创建/复用分支 |
| `waitSessionStarted` | 注入 `status`/`nudge`/`sleepFn`/超时 | 不依赖真实 tmux/时间 |
