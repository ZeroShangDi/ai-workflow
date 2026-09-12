# 前端工程（web/） — 测试用例

> 对应功能文档：`docs/features/web.md`
> 源码：`web/src/**`（`api/client.js` + 5 个 `*-model.js` + 壳模型 `run-shell-model.js`）
> 测试文件：`tests/unit/web-api-client.test.js`、`web-run-shell-model.test.js`、`web-dashboard-model.test.js`、`web-diagnostics-model.test.js`、`web-decisions-model.test.js`、`web-wbs-tree-model.test.js`
> 真机交叉验证：`tests/regression/fullflow-regression.mjs` 的 `web` case（页面可达 / 资产托管 / 未构建 503 二态 / 两项目取数互不串）

## 覆盖边界（先说清测什么、不测什么）

| 层 | 覆盖 | 说明 |
|---|------|------|
| `api/client.js` | ✅ 单测 | 全量：URL 拼装（`p` / `sid` / 保留原 query / 编码）、HTTP 语义、错误容忍、http→ws 换算 |
| 五个 `*-model.js`（纯函数） | ✅ 单测 | 全量：归一、兜底、格式化 |
| `.jsx` 视图与 `App.jsx` 壳 | ❌ **不测** | 需要 DOM 环境 + React 渲染；仓库无 jsdom / testing-library 依赖。视图的正确性靠「模型单测 + 真机 `web` case（HTTP 面）+ 人工看页面」三段兜 |
| 页面视觉 / 交互 | ❌ 不测 | 无样式文件（见功能文档「观察项 2」），无浏览器驱动 |

> **为什么模型层被单独抽出**：T1-087…090 把原 server 托管页（`dashboard.html` / `decisions.html` / `diagnostics.html` + tree CLI 渲染）的展示逻辑迁到 web 时，**先抽纯函数模型再写组件**，让「迁移是否等价」可以用单测判定。所以本目录的测试是**迁移等价性的凭证**，不只是覆盖率。

## 测试场景总览

| # | 文件 | 场景 | 类别 |
|---|------|------|------|
| 1–3 | `web-api-client` | 基础 URL 拼装（无 sid / 带 sid + 保留 query / stream 换算） | 正常 |
| 4–9 | `web-api-client` | 错误容忍（非 JSON 兜底 / 成功原样返回 / 网络拒绝原样 reject / https→wss / 空 sid 不附 + 特殊字符编码 / `url()`） | 边界·异常 |
| 10–13 | `web-api-client` | 项目作用域 `?p`（附 `p` + 保留 query / `p` 与 `sid` 同时带且顺序固定 / 无 `project` 不附 / stream 也带 `p`） | 正常·边界 |
| 14–15 | `web-run-shell-model` | `normalizeRun`（缺 counts 兜底 / counts → progress + 任务标题派生） | 正常·边界 |
| 16–17 | `web-run-shell-model` | `toRunShellModel`（active 选取优先级 / 空列表 `isEmpty`） | 正常·边界 |
| 18 | `web-run-shell-model` | `runSummary` 文案 + 空兜底 | 格式 |
| 19–20 | `web-dashboard-model` | `toDashboardModel`（三路响应合并 / 无 run 时 idle 兜底） | 正常·边界 |
| 21–22 | `web-dashboard-model` | `phaseLabel` 映射 / `applyRunEvent` 事件更新 | 格式 |
| 23–25 | `web-diagnostics-model` | `toDiagnosticsModel`（complete 归一 / running·failed·无记录状态 / 指标缺失兜底） | 正常·边界 |
| 26–28 | `web-diagnostics-model` | `fmtTokens` / `fmtDuration` / `statusLabel`+`severityLabel` 格式化 | 格式 |
| 29–31 | `web-decisions-model` | `toDecisionsModel` 归一（含 `overridable` 判定）/ `decisionSummary` / 容忍 `decisionId` | 正常·边界 |
| 32–33 | `web-wbs-tree-model` | `levelOf`（W 编号取层级 / 非法 → 0） | 正常·边界 |
| 34–36 | `web-wbs-tree-model` | `buildWbsTree`（children 嵌套成树 + 任务绑定 / 扁平平铺不臆造父层 / 缺省与悬空引用兜底） | 正常·边界·异常 |

**合计 36 例 / 6 文件**（与 `npm test` 实测一致）。不跑真浏览器。

## 详细测试用例

### TC1–TC3: api client 基础拼装

**前置条件**：注入 `httpFetch`（记录调用）与 `wsFactory`（记录 URL，返回哨兵对象）。

**执行 / 断言**：

| 用例 | 执行 | 断言 |
|------|------|------|
| TC1 | `createApiClient({ base, httpFetch }).get('/run/status')` + `.post('/run/state/mode', {mode:'run'})` | URL = `base + path`；POST 时 `opts.method === 'POST'`、`opts.body === '{"mode":"run"}'` |
| TC2 | `createApiClient({ sid: 'r1' }).get('/run/status?detail=1')` | URL 为 `…/run/status?detail=1&sid=r1`——**端点自带 query 被保留**，作用域追加在后 |
| TC3 | `createApiClient({ sid: 'r2', wsFactory }).stream('/run/events')` | `wsFactory` 收到的 URL 为 `ws://…/run/events?sid=r2`；无 `base` 时用默认 `http://127.0.0.1:8787` |

### TC4–TC9: api client 边界与容忍（T1-097）

| 用例 | 执行 | 断言 |
|------|------|------|
| TC4 | `httpFetch` 返回 500 且 body 非 JSON | 返回 `{ ok: false, error: 'http 500' }`（**不抛**） |
| TC5 | `httpFetch` 返回 `{ ok:true, total:5 }` | 原样返回 JSON body |
| TC6 | `httpFetch` 抛 `ECONNREFUSED` | **原样 reject**（client 不吞网络错误；视图层各自 `.catch(() => null)` 兜底） |
| TC7 | `base: 'https://…:9443'` + `stream` | 换算为 `wss://…`（`http→ws` 的前缀替换对 https 同样成立） |
| TC8 | ① 无 `sid` ② `sid: 'a b/c'` | ① URL 无 `?sid`；② `?sid=a%20b%2Fc`（`encodeURIComponent`） |
| TC9 | `api.url('/awf/state')` | 返回绝对地址（含 `sid`），不发起请求 |

### TC10–TC13: 项目作用域 `?p`（单 server 多项目）

**背景**：`p` 是 server 侧的项目路由主键；不带 `p` 会落到 server 的 boot 项目。前端只有「取全量项目列表」这一个场景**故意**不带 `p`。

| 用例 | 执行 | 断言 |
|------|------|------|
| TC10 | `{ project: '/tmp/proj-1' }` 分别打 `/run/status` 与 `/run/status?runId=r1` | ① 无原 query → 接 `?p=%2Ftmp%2Fproj-1`；② 有原 query → `?runId=r1&p=%2Ftmp%2Fproj-1`（path 与 query 分离，各自不被污染） |
| TC11 | `{ project: '/tmp/p', sid: 'default' }` | URL 为 `?p=…&sid=default`——**`p` 在前、`sid` 在后**（顺序固定，便于比对与排查） |
| TC12 | 不传 `project` | URL 无 `?p`——**存量行为不变**（这是 `App.jsx` 取全量项目列表所依赖的语义） |
| TC13 | `{ project: '/tmp/p', sid: 'r1' }` + `stream` | WS URL 带 `?p=…&sid=r1`——项目作用域同样作用于事件流，不会串项目 |

### TC14–TC18: run 壳模型

| 用例 | 执行 | 断言 |
|------|------|------|
| TC14 | `normalizeRun({})` / 无 `counts` | 各字段安全兜底；`progress === '0/0'`（`total` 为 0 时不除） |
| TC15 | `normalizeRun({ counts: {done:2,total:5}, currentTaskId:'T9' })` | `progress === '2/5'`；`currentTaskTitle` 回退到 `currentTaskId` |
| TC16 | `toRunShellModel` 三 run（含 running / queued） | `active` 取 `running`；无 running 取 `queued`；都没有取首条 |
| TC17 | `toRunShellModel({})` / 无 runs | `isEmpty === true`、`active === null`、`total === 0` |
| TC18 | `runSummary(r)` | 文案含 runId / status / progress / task；`null` 或空 runId → 占位串 |

### TC19–TC22: Dashboard 模型

| 用例 | 执行 | 断言 |
|------|------|------|
| TC19 | `toDashboardModel({ runStatus, status, metrics })` | 三路响应合并为统一展示模型（projectRoot / sessionState / run 字段 / counts / progress / metrics） |
| TC20 | 无 run（`runStatus` 为空） | `runStatus === 'idle'`、`mode === 'single'`、`progress === '0/0'`——**不抛** |
| TC21 | `phaseLabel('CODE')` / `phaseLabel('X')` | 已知阶段 → 中文标签；未知 → 原样返回（不吞值） |
| TC22 | `applyRunEvent(base, {type:'run.stopped',…})` / `{type:'task.done',…}` | `run.stopped` 更新 `runStatus`；`task.*` 更新 `currentTaskId` 并记 `lastEvent` |

> 注：`applyRunEvent` 当前**无生产调用方**（视图走整体 `refresh()`），只有本用例引用——见功能文档「观察项 4」。

### TC23–TC28: Diagnostics 模型

| 用例 | 执行 | 断言 |
|------|------|------|
| TC23 | metrics + `status:'complete'` 的诊断记录 | 归一出指标（tokens / 吞吐 / 上下文）、结论（severity / summary）、findings 与 dataGaps（各截前 6 条） |
| TC24 | 分别 `running` / `failed` / 无记录 | `diagnosisStatus` 与 `diagnosisError` 正确归一；`failed` 带出 error |
| TC25 | 指标缺失 | 安全兜底不抛；`throughput` 回退取 `average`；缺省字段为 `null` |
| TC26 | `fmtTokens` | `>=1000` → `k` 紧凑（`1.5k`）、整数修剪 `.0`、非有限数值 → `—` |
| TC27 | `fmtDuration` | `h/m/s` 级联（`9s` / `1m 05s` / `1h 01m 05s`）、非有限数值 → `—` |
| TC28 | `statusLabel` / `severityLabel` | 中文标签映射；未知值原样返回 |

### TC29–TC31: Decisions 模型

| 用例 | 执行 | 断言 |
|------|------|------|
| TC29 | `toDecisionsModel({ total, decisions:[…] })` | 逐条归一；`overridable` 只在「有 id + 非 `decision_overridden` + `answer !== undefined`」时为真 |
| TC30 | `decisionSummary(d)` | 有 answer → `id → answer`（截 80 字）；兜底决策带「（兜底）」；无 id → 占位串 |
| TC31 | 条目用 `decisionId`（驼峰）而非 `decision_id` | 两种字段名都能取到 id——容忍记录形状差异 |

### TC32–TC33: `levelOf`

| 用例 | 断言 |
|------|------|
| TC32 | `W1-xxx` → 1、`W3-xxx` → 3（取语义层级编号） |
| TC33 | 非法 / 空 id → `0`（不抛） |

### TC34–TC36: `buildWbsTree`

| 用例 | 执行 | 断言 |
|------|------|------|
| TC34 | wbs 声明 `children` + tasks 以 `wbsRef` 引用 | 按 `children` 成边建**真树**；节点携带首个绑定任务的 `id/kind/status`；`stats.withTask` 与 `byStatus` 正确 |
| TC35 | 扁平 wbs（无 `children`） | 全部作根平铺、**保持 state 原序**、不臆造父层（与旧 `renderTree` 的 `data.children \|\| data` 兜底一致） |
| TC36 | 缺省入参 / `wbsRef` 指向不存在的节点 | 空入参 → 空森林不抛；悬空引用不建边、不进 `stats` |

## Mock 策略

| 依赖 | Mock 方式 | 说明 |
|------|-----------|------|
| `fetch` | 注入 `httpFetch`（记录 `{url, opts}` 并返回伪 Response） | 不联网、不启 server；断言 URL 即断言作用域 |
| `WebSocket` | 注入 `wsFactory`（记录 URL，返回 `{__ws:true}` 哨兵） | 只验 URL 换算与参数，不建真连接 |
| server 响应体 | 直接构造普通对象字面量传入模型函数 | 模型是纯函数，**无需 mock 框架**（无 `vi.mock`） |
| 计时器 | 不涉及 | 模型层与计时无关；轮询/WS 在 `.jsx` 层，不在单测范围 |

## 未覆盖与补法

| 缺口 | 影响 | 补法 |
|------|------|------|
| `.jsx` 组件渲染与交互 | 视图改动只能靠人工看页面 | 加 jsdom + @testing-library/react 后补组件测试 |
| `App.jsx` 三层寻址（URL ↔ 状态） | `parseQuery`/`toQuery`/`selectProject` 无单测 | 这两个函数不依赖 DOM（只读 `window.location.search`），可用 `vi.stubGlobal('window', …)` 单测，**当前缺口** |
| 页面视觉 | 无样式可测 | 先落样式（功能文档「观察项 2」），再谈视觉回归 |

> **写在测试文件里的验证只能说明「模型归一正确」，说明不了「页面按预期渲染」** —— 后者的凭证是真机 case `web`（产物托管与取数）加人工确认。别把 36 例绿读成「前端全绿」。
