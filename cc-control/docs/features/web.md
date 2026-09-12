# 前端工程（web/） — 功能文档

> 对应 WBS：W3-008（前端工程 web/，T1-085…094）；构建接入 T1-118；legacy 观测页退役 T1-119
> 源码：`web/`（Vite + React 18 独立工程，`web/src/` 12 文件 / 887 行）
> 服务端边界：`src/server/server.cjs`（`PAGE_PATHS` 页面路径 + 静态托管）、`src/server/static.cjs`（SPA 回退）
> 构建：`scripts/build-web.mjs`（`npm run build` / `npm run build:web` / `prepack`）→ `src/server/public`
> 交叉引用：对外 HTTP 面逐条形状见 `api.md`（§3.1 页面路径 / §4 静态托管 / §5 WS）；server 侧职责与生命周期见 `server.md` §6。**本文不复述这两处**，只讲前端自己怎么组织、怎么取数、怎么被构建出来。
> 测试：`tests/unit/web-*.test.js`（模型层 6 文件）+ 真机 case `web`（`tests/regression/fullflow-regression.mjs`）

## 功能描述

`web/` 是 ai-workflow 的**观测与控制前端**：一个 Vite + React 的单页应用（SPA），浏览器打开后可以看到并干预正在跑的 run。

它做四件事：

1. **四视图观测** —— 总览（run/任务/阶段/指标 + 发消息 + 停止 + 启停）、决策 Review（列表 + override）、诊断（指标快照 + AI 诊断结论 + 触发）、WBS 树（可交付节点 + 任务状态标注）。
2. **多项目 / 多 run 寻址** —— 项目（`?p`）与 run（`?sid`）两个正交作用域，叠加视图（`?view`），全部编码进 URL，可分享可回退。
3. **事件驱动刷新** —— 主通道是 `/run/events` 的 WebSocket 推送，轮询仅作心跳兜底。
4. **纯前端、零后端逻辑** —— 所有状态都在 server；前端只做「取数 → 归一为展示模型 → 渲染」。

**边界**：`web/` 不 import `src/` 任何模块，只经 HTTP/WS 打到常驻 Session Server（架构纪律 R1，`docs/discuss/architecture-v0.2.0.md` §2.1）。所以它是**独立构建产物**，与服务端存在版本错配的真实可能（R3 事件 schema 版本缺口的消费方之一，见 `events.md`）。

## 工程结构

```
web/
├── index.html            # SPA 入口：<div id="root"> + /src/main.jsx
├── vite.config.js        # 构建 outDir + dev 代理（31 行）
├── package.json          # awf-web（private；version 与主包对齐，发布时一同递增）
├── eslint.config.js      # eslint 9 flat config
└── src/
    ├── main.jsx          # createRoot + StrictMode（9 行）
    ├── App.jsx           # 壳：项目 / 视图 / run 三层寻址 + 头部渲染（138 行）
    ├── api/
    │   └── client.js     # HTTP + WS 封装，带作用域（61 行，零依赖）
    └── views/
        ├── Dashboard.jsx        / dashboard-model.js
        ├── Decisions.jsx        / decisions-model.js
        ├── Diagnostics.jsx      / diagnostics-model.js
        ├── WbsTree.jsx          / wbs-tree-model.js
        └── run-shell-model.js   （壳专用模型，无同名视图）
```

**没有 CSS**。四个视图都在用 `className`（`chip` / `metric` / `card` / `tree` …）但仓库内**没有任何 `.css` 文件**——样式是**未落地的意图**，当前页面为浏览器默认样式。改动前先知道这一点，别以为有一份样式表在别处。

依赖只有 `react` / `react-dom`（18.3.1）；构建期 `vite` 5 + `@vitejs/plugin-react` 4 + `eslint` 9。**无路由库、无状态库、无 UI 库**——导航是 `useState`，路由是 `URLSearchParams`。

## 寻址模型（三层作用域）

`App.jsx` 把三层作用域全部编码进 URL，用 `history.replaceState` 同步（不整页刷新，`App.jsx:51`）：

| 参数 | 作用域 | 缺省 | 变更点 |
|------|--------|------|--------|
| `?p=<projectRoot>` | **项目** | 不带 → server 回落 boot 项目 | 头部项目 chip（`App.jsx:93`，**仅当项目数 > 1 才渲染**） |
| `?view=<key>` | **视图** | `dashboard` | 头部视图导航；非法 key 回落 `dashboard`（`App.jsx:29`） |
| `?sid=<runId>` | **run** | 不带 → 项目根（整项目视角） | run chip（`App.jsx:113`）；再点当前 run → 取消聚焦 |

三条交互规则：

- **切项目即清 run 聚焦**（`selectProject`：`setProject(root); setSid(null)`）——run 归属项目，跨项目保留 sid 没有意义。
- **点当前 run = 取消聚焦**（`selectRun` 对同值取 `null`）。
- **body 按作用域全量重挂载**：`key={`${project||'boot'}:${view}:${sid||'root'}`}`（`App.jsx:130`）——换作用域不靠子视图自己清理状态，直接重建组件树。

### `?p` 取数：作用域怎么落到请求上

作用域封装在 `web/src/api/client.js` 的 `createApiClient({ base, project, sid, httpFetch, wsFactory })`：

```js
const scopeParts = [];
if (project) scopeParts.push(`p=${encodeURIComponent(String(project))}`);
if (sid)     scopeParts.push(`sid=${encodeURIComponent(String(sid))}`);
// withScope(path)：拆出原 query，把作用域追加在后（保留端点自带参数，如 override 的路径参数不受影响）
```

- **`project = null` 是刻意的**：不带 `p` 才能拿到全量项目列表（带 `p` 时 server 只回本项目）。所以 `App.jsx` 用**两个** client——`rootClient`（无项目，只打 `GET /status` 取 `projects`）与 `listClient`（带当前项目，打 `/run/status` 与 `/run/events`）。
- **各视图自建 client**：`createApiClient({ project: project || undefined, sid: sid || undefined })`，作用域由 App 以 props 传入、随作用域变化重建（`useMemo` 依赖 `[sid, project]`）。
- **写类端点自动带上 `p`**：`/send`、`/stop`、`/run/state/mode`、`/awf/decisions/:id/override`、`/awf/diagnostics` 等写请求经同一 `withScope`，因此天然满足「写类端点缺 `?p` → 400」的铁律（`api.md` §1.3）。这是前端**唯一**需要为那条铁律做的事——作用是 client 级别的，不是每个调用点自己记得拼。

> 与 CLI 的差别：CLI 有「不带 `p` 的 `GET /status` 作为 server 发现入口」的特殊语义；前端没有发现职责（页面本来就是 server 发出来的），所以只有「要全量项目列表」这一个不带 `p` 的场景。

## 四视图职责

| 视图 | key | 数据源 | 可写动作 | 模型 |
|------|-----|--------|----------|------|
| **总览** Dashboard | `dashboard` | `GET /run/status` + `GET /status` + `GET /awf/metrics`（`Promise.all`） | `POST /send`、`POST /respond`、`POST /stop`、`POST /run/state/mode` | `dashboard-model.js` |
| **决策** Decisions | `decisions` | `GET /awf/decisions` | `POST /awf/decisions/<id>/override` | `decisions-model.js` |
| **诊断** Diagnostics | `diagnostics` | `GET /awf/metrics` + `GET /awf/diagnostics`（`Promise.all`） | `POST /awf/diagnostics`（触发一次 AI 诊断） | `diagnostics-model.js` |
| **WBS** WbsTree | `wbs-tree` | `GET /awf/state`（全量 state 的 `wbs` + `tasks`） | —（只读） | `wbs-tree-model.js` |

各视图要点：

- **Dashboard**：头部露 projectRoot / runStatus / 阶段 / `Task done/total`；模式按钮按 `running` 切换 `run`↔`idle`；`decisionPending` 存在时把选项渲染成按钮，点击回 `respond(i+1)`（**注意是序号**，见「观察项」）；底部一条输入框打 `/send`。
- **Decisions**：每条决策展示摘要 + runStamp/时间/type；`overridable`（有 id、非 override 记录、`answer !== undefined`）的行才出 override 输入框；成功后清空该行输入并刷新。
- **Diagnostics**：四张摘要卡（总 token / 端到端吞吐 / 总耗时 / 上下文）+ AI 诊断结论（severity / summary / findings / dataGaps）+ 两张明细卡（token 明细 / 统计范围）。诊断 `running` 期间轮询提到 2s 并禁用按钮（**没有对应事件**，是唯一保留快轮询的视图）。
- **WbsTree**：`buildWbsTree({ wbs, tasks })` 重建森林；节点字形 `done ✓ / active ● / blocked ✕`；无数据时提示「请先执行 awf plan」。

## 模型层与视图层分工

这是本工程唯一「有架构」的地方，也是唯一被单测覆盖的地方：

```
server payload ──► views/*-model.js（纯函数） ──► 展示模型 ──► views/*.jsx（渲染）
                        ↑ 可单测：无 React、无 fetch、无副作用
```

- **模型层**（`*-model.js`，5 个 + 壳模型 1 个）全部是**纯函数**：入参是 server 响应对象，出参是展示模型。所有「字段缺省怎么兜底」「形状差异怎么容忍」「数值怎么格式化」都收敛在这一层，视图里不再出现 `?.` 与 `??` 的长链。
- **视图层**（`*.jsx`）只负责：建 client、拉数、调模型、渲染、挂事件。**不做字段归一**——拿到 payload 立即交给模型。
- **为什么这么切**：T1-087…090 把原 server 托管页（dashboard/decisions/diagnostics.html + tree CLI 渲染）的展示逻辑迁到 web 时，**先抽模型再写组件**，让「迁移是否等价」这件事可以用单测判定，而不是靠肉眼看页面。四个视图的模型因此各有独立单测（`tests/unit/web-*.test.js`，详见 `web.test.md`）。

模型层的关键归一：

| 模型 | 函数 | 归一内容 |
|------|------|----------|
| `run-shell-model.js` | `normalizeRun` / `toRunShellModel` / `runSummary` | run 列表 → 壳模型；`progress` 由 `counts` 聚合；`active` 按 `running > queued > 首条` 取 |
| `dashboard-model.js` | `toDashboardModel` / `phaseLabel` / `applyRunEvent` | 三路响应合并；`runStatus`/`status`/`metrics` 缺一路也不崩 |
| `wbs-tree-model.js` | `levelOf` / `buildWbsTree` | 扁平 `wbs` → 森林；**层级重建规则见下** |
| `decisions-model.js` | `normalizeDecision` / `toDecisionsModel` / `decisionSummary` | 容忍 `decision_id`/`decisionId`、`event` 缺省推断；推导 `overridable` |
| `diagnostics-model.js` | `toDiagnosticsModel` / `fmtTokens` / `fmtDuration` / `statusLabel` / `severityLabel` | 指标/诊断记录缺省兜底；findings 与 dataGaps 各截前 6 条；数值/时长/状态文案格式化 |

> **WBS 层级重建的边界**：`state.wbs` 是**扁平表**，父子边不落盘（`awf_wbs_create` 无 `children`）。模型按优先级重建：① 节点声明 `children`（id 数组）→ 显式成边；② 未成边的节点一律作**根**（平铺，保持 state 原序）。不臆造父层——与旧 `renderTree` 对扁平 wbs 的 `data.children || data` 兜底一致。

## 数据获取与事件驱动

**事件推送是主通道，轮询是兜底**——每个视图挂 `client.stream('/run/events')`（→ `ws://`，`api.md` §5），`onmessage` 即 `refresh()`；同时留一个 `setInterval` 心跳，用途只有两个：断线时仍能收敛，以及**没有对应事件的场景**。

| 视图 | 心跳 | 事件过滤 | 备注 |
|------|------|----------|------|
| Dashboard | 10s | 全量（任一带 `type` 的帧都刷） | — |
| WbsTree | 10s | 全量 | 先 `JSON.parse` 成功且 `type` 存在才刷 |
| Decisions | 10s | **仅 `decision.` 前缀**（`decision.required` / `decision.record`） | 其他事件不触发重建列表 |
| Diagnostics | `running` 时 2s，否则 10s | 全量 | 诊断过程**无对应事件**，2s 轮询是主通道 |

- WS 数据源是 **run-host 的事件环 / subscriber 集合**，不是 `src/lib/events.cjs` 的事件总线——两者的形状关系与不等之处见 `events.md`。
- 连接只有「服务端 → 客户端」单向文本帧；前端不做上行（所有写操作走 HTTP POST）。
- 断线**不做显式重连**：`ws.onclose` 没有重建逻辑，靠心跳继续刷新（见「观察项」）。

## 构建链与产物托管

```
web/src/*            web/index.html
    └── vite build（vite.config.js: build.outDir = '../src/server/public'）
            │
            ├── 触发点①：npm run build      → scripts/build.sh 第三步调 scripts/build-web.mjs
            ├── 触发点②：npm run build:web  → 直接调 scripts/build-web.mjs
            └── 触发点③：npm run prepack    → build-web.mjs --required（发布路径，忽略跳过开关）
            ▼
    src/server/public/（构建物，**不入库**，见 .gitignore）
            │
            └── server 静态托管：webPublicRoot() = CC_WEB_PUBLIC || src/server/public
                     ├── PAGE_PATHS 页面路径（/、/dashboard(.html)、/diagnostics(.html)、/decisions(.html)）→ 一律返回同一份 index.html
                     ├── 产物缺失 → 503 + console.warn（提示 npm run build），不空白页、不静默 404
                     └── 其他 GET → static.cjs SPA 回退 index.html（前端路由，如 /wbs-tree）
```

- **`build-web.mjs` 的存在理由**（T1-118 补的课）：T1-093 当时只做了「接线」（`outDir` 指向 + server 托管），**没有任何环节会去构建** —— `build.sh` 不碰 web、没有 prepack、`web/node_modules` 从没装上过。于是「接线在」而「产物不存在」（`.awf/issues/002` 说的那种落差：接线 ≠ 被触发，而「被触发」不是任何人的任务）。**现状已收口**：上面三条触发路径都能构建，`build-web` 是链路里的一等公民。
- **依赖缺失不静默跳过**：缺 `web/node_modules` 时报错退出并给出修复命令（**不猜、不自动装**——装依赖是使用者的决定）；确要跳过必须显式 `AWF_SKIP_WEB=1`（打印醒目警告），`--required` 则忽略该开关。
- **发布形态**：`package.json` 的 `files` 是 `plugin/ src/ scripts/`——**`web/` 源码不入 npm 包**，包内只有构建产物（落在 `src/` 下）。因此构建必须发生在打包机上（`prepack`）。

**dev 模式**（`vite dev`，`AWF_WEB_PORT` 缺省 5173）：`vite.config.js` 配了 `/run`、`/awf`、`/api`、`/status`、`/send`… 的代理到 `AWF_SERVER`（缺省 `http://127.0.0.1:8787`），`/run`、`/awf`、`/api` 额外 `ws: true`。**但见「观察项 1」——这份代理当前不会被走到。**

## 核心常量 / 配置

| 常量 / 变量 | 值 | 位置 | 说明 |
|------|-----|------|------|
| `base`（client 默认） | `http://127.0.0.1:8787` | `src/api/client.js:14` | 所有视图都不传 `base`，即**硬编到默认端口** |
| `AWF_SERVER`（env） | `http://127.0.0.1:8787` | `vite.config.js:6` | dev 代理目标 |
| `AWF_WEB_PORT`（env） | `5173` | `vite.config.js:23` | vite dev 端口 |
| `PROXY_PREFIXES` | 15 个前缀 | `vite.config.js:12` | dev 代理路径（`/run` `/awf` `/api` `/status` `/send` `/cmd` `/respond` `/choice` `/ask` `/stop` `/intervene` `/context-ready` `/diagnostics` `/decisions.html` `/ui`） |
| `WS_PREFIXES` | `/run` `/awf` `/api` | `vite.config.js:14` | 需 WS 升级的代理前缀 |
| `VIEWS` | `dashboard` / `decisions` / `diagnostics` / `wbs-tree` | `App.jsx:13` | 视图目录（key + 中文标签） |
| `build.outDir` | `../src/server/public` | `vite.config.js:19` | 产物落点（相对 `web/`） |
| 项目列表轮询 | 5000 ms | `App.jsx:63` | `GET /status`（无 `p`） |
| 壳 run 列表轮询 | 3000 ms | `App.jsx:75` | `GET /run/status`（带当前项目） |
| 视图心跳 | 10000 ms（Diagnostics 诊断中 2000 ms） | 各视图 | 事件推送的兜底 |
| `CC_WEB_PUBLIC`（env） | `src/server/public` | `server.cjs` | 产物根覆盖（测试用） |

## 函数清单

| 函数 / 组件 | 说明 | 位置 |
|------|------|------|
| `createApiClient({base,project,sid,httpFetch,wsFactory})` | 作用域化 HTTP/WS 客户端；`get`/`post`/`stream`/`url` | `web/src/api/client.js:13` |
| `App()` | 壳组件：三层寻址、头部（项目 chip / 视图导航 / run chip）、body 重挂载 | `web/src/App.jsx:41` |
| `parseQuery()` / `toQuery(view,sid,project)` | URL ↔ 状态（双向，`replaceState`） | `web/src/App.jsx:26,33` |
| `projectName(root)` | 项目根 → 末段目录名（chip 显示名） | `web/src/App.jsx:21` |
| `normalizeRun(r)` / `toRunShellModel(resp)` / `runSummary(r)` | run 列表壳模型（纯） | `web/src/views/run-shell-model.js` |
| `toDashboardModel({runStatus,status,metrics})` / `phaseLabel` / `applyRunEvent` | Dashboard 模型（纯） | `web/src/views/dashboard-model.js` |
| `levelOf(id)` / `buildWbsTree({wbs,tasks})` | WBS 森林重建（纯） | `web/src/views/wbs-tree-model.js` |
| `normalizeDecision(e)` / `toDecisionsModel(resp)` / `decisionSummary(d)` | 决策列表模型（纯） | `web/src/views/decisions-model.js` |
| `toDiagnosticsModel({metrics,diagnosis})` / `fmtTokens` / `fmtDuration` / `statusLabel` / `severityLabel` | 诊断模型 + 格式化（纯） | `web/src/views/diagnostics-model.js` |
| `Dashboard/Decisions/Diagnostics/WbsTree({sid,project})` | 四个视图组件（props 只有 `sid` + `project`） | `web/src/views/*.jsx` |

## 接口 / 依赖

| 依赖 | 用途 |
|------|------|
| `react` / `react-dom` 18.3.1 | 运行时（仅此两个） |
| `vite` 5 + `@vitejs/plugin-react` 4 | 构建与 dev server |
| `eslint` 9 + react/hooks 插件 | `cd web && npm run lint`（**不在根 `npm run lint` 内**，见「观察项」） |
| 浏览器 `fetch` / `WebSocket` | 经 `httpFetch` / `wsFactory` 注入点封装（测试可替换，也是唯一降级入口） |

| 被谁消费 | 方式 |
|------|------|
| `src/server/server.cjs` | `PAGE_PATHS` 返回产物 index.html；静态托管 assets；缺产物 503 |
| `scripts/build-web.mjs` | 构建触发 + 产物存在性断言 |
| `npm run build`（`scripts/build.sh`） | 构建链第三步 |
| `npm run prepack` | 发布路径强制构建 |
| 真机 case `web` | 页面可达 / 资产托管 / 未构建时 503 二态 / 两项目取数互不串 |

## 观察项（当前实现与注释/意图的差距）

按 `api.md` §6.2 的写法登记，**留事实、不判优先级**：

1. **dev 代理实际上不会被走到** —— `createApiClient` 的 `base` 默认是绝对地址 `http://127.0.0.1:8787`，所有请求经 `new URL(path, base)` 得到绝对 URL，**不经 vite dev server**，故 `vite.config.js` 的 `proxy` 配置对视图请求不生效（只有 vite 自己服务 `/src/*.jsx` 那部分走不到代理）。要让代理生效，得让 client 走相对路径（不传 `base` 或传 `''`）。当前后果：`vite dev`（5173）页面请求打到 8787 的 server —— 同机可用，跨机/换端口不可用。这是配置与实现的偏差，不是崩溃。
2. **无样式** —— 四个视图大量使用 `className`，但仓库内无任何 `.css`（见「工程结构」）。样式是未落地的意图。
3. **WS 断线不重连** —— `ws.onclose` 无重建逻辑；断线后靠心跳轮询继续收敛，页面不提示「已断开」。
4. **`applyRunEvent` 无人调用** —— 该纯函数（事件 → 模型字段级更新）是 T1-091 事件驱动的**增量更新**设计，但四个视图实际都走「事件到达即整体 `refresh()`」，只有单测引用它。
5. **`phaseLabel` 的入参对不上** —— `Dashboard.jsx:32` 传 `model.currentState || model.currentStage`，而 `toDashboardModel` **不产出** `currentState`；实际总是走 `currentStage`（值形如 `DEV`/`CODE`），映射表未覆盖时会原样显示（如 `DEV`）。
6. **决策选项按钮回传的是序号** —— `Dashboard.jsx:82` 的 `respond(i + 1)`：用户看到的是选项文案，点下去发的是 `1`/`2`。旧 server 托管页的语义如此，迁移时保持等价；改文案/加选项要留意这个耦合。
7. **`web/` 的 eslint 不在根 lint 内** —— 根 `npm run lint` 走 `scripts/lint.sh`，只做 `node --check`（覆盖 `*.js`/`*.cjs`，含 `web/src/**/*.js`），**不覆盖 `*.jsx`**，也不套用任何 eslint 规则。`web/` 自带一份 eslint 9 flat config 且有自己的 `lint` script，但**只能 `cd web && npm run lint` 手动跑**，根命令不会触发它。

## 验收标准

- [ ] `web/` 不 import `src/` 任何模块；只经 HTTP/WS 与 server 通信（`node scripts/check-architecture.mjs` EXIT 0 覆盖这条边）。
- [ ] 四视图可达且各自功能成立：总览（run/任务/阶段/指标 + send/respond/stop/启停）、决策列表 + override、诊断展示 + 触发、WBS 树 + 任务状态标注。
- [ ] 三层寻址：`?p`（项目）/ `?view`（视图）/ `?sid`（run）编码进 URL；切项目清 sid；点当前 run 取消聚焦；body 按作用域重挂载。
- [ ] 作用域落到请求上：带 `project` 的 client 所有请求附 `p=`；`sid` 附 `sid=`；**取全量项目列表的请求必须不带 `p`**。
- [ ] 事件驱动：四视图均订阅 `/run/events`，推送即刷新；轮询仅作兜底（Diagnostics 诊断中 2s 为无事件场景的主通道）。
- [ ] 模型层纯函数化：五个 `*-model.js` 无 React / 无 fetch / 无副作用，可单测（见 `web.test.md`）。
- [ ] 构建链：`npm run build` / `build:web` / `prepack` 三条触发路径都能产出 `src/server/public/index.html`；缺依赖报错退出（显式 `AWF_SKIP_WEB=1` 才跳过，`--required` 忽略该开关）。
- [ ] 产物缺失时 server 返回 503 + `npm run build` 提示（不回退 legacy 页、不空白页）；产物正常时页面路径与 `/assets/*` 均 200。
