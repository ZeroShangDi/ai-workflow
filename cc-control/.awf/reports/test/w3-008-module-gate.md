# W3-008 模块测试门禁（前端工程 web/ React+Vite）— 非真结构核查报告

> 门禁任务 T3-008 · 2026-09-09 · 非真模块核查（对照模块 acceptance + 改动 diff 做结构/验收自检，
> 不跑整套真实测试、不强求新增真实用例；真实运行验证由最终自托管真 run T1-098 承担）。
> 模块改动基线：`61fe96d(T1-084)..99fc77a(T1-094)`，31 文件 / +1271 / -214。
> 佐证：本模块各 dev 任务逐次全量绿；最新全量 **91 文件 / 778 例绿**（e2e 两既有基线失败除外，
> 见 docs/bugs/recovery-baseline-e2e-failures.md）。

## 一、模块范围（W3-008 WBS desc 对照）

repo 顶层 `web/` React+Vite 工程：四视图（Dashboard/WBS-Tree/Decisions/Diagnostics）迁移；
轮询→WS 事件驱动；`?sid` 路由 + 多 run 列表壳；共享主题/组件；build 产物入 server/public 托管；
ui.html 废弃。门禁内 dev 任务 T1-085…T1-094 全部 done。

## 二、验收点逐条对表

| # | 验收点（WBS） | 落地结构（文件:行为） | 判定 |
|---|--------------|----------------------|------|
| 1 | 四视图迁移 Dashboard | `web/src/views/Dashboard.jsx` + `dashboard-model.js`（T1-087）：GET /run/status+/status+/awf/metrics，send/respond/stop/启停，WS+心跳 | ✅ |
| 1b | 四视图迁移 Decisions | `Decisions.jsx` + `decisions-model.js`（T1-088）：GET /awf/decisions、POST /awf/decisions/:id/override、decision.* WS 刷新 | ✅ |
| 1c | 四视图迁移 Diagnostics | `Diagnostics.jsx` + `diagnostics-model.js`（T1-089）：metrics+diagnosis 展示、POST /awf/diagnostics 触发、running 期 2s 轮询 | ✅ |
| 1d | 四视图迁移 WBS-Tree | `WbsTree.jsx` + `wbs-tree-model.js`（T1-090）：GET /awf/state → wbs+tasks 树（显式 children 成边/扁平平铺），状态标注 | ✅ |
| 1e | 视图路由 | `web/src/App.jsx`：`?view=dashboard\|decisions\|diagnostics\|wbs-tree` + `?sid`；模型层均有单测（web-*-model.test.js 5 组） | ✅ |
| 2 | 轮询→WS 事件驱动 | `src/server/ws.cjs`（RFC6455 极简）+ server.cjs `/run/events` `upgrade` → `runHost.subscribe` 逐事件文本帧推送；run-host 增 subscribe/publish；决策 setDecision/persistDecision 推 `decision.required/record`；四视图 ws 即时刷新 + 10s 心跳兜底（原 /run/events afterSeq 轮询保留兼容） | ✅ |
| 3 | ?sid 路由 + 多 run 列表壳 | `run-shell-model.js` + App 壳：GET /run/status 渲染多 run chip（running>queued>首条 active），切换 ?sid；URL replaceState 同步；子视图 key={view:sid} 重挂载 | ✅ |
| 4 | 共享主题/组件库 | `src/server/theme.css`+`common.js`（T1-086，window.AWF_COMMON esc/fmtDuration/taskRow/renderTaskList）已注入 3 托管页 head（dashboard/decisions/diagnostics），server /theme.css,/common.js 承载；**注意：ui.html 已随 T1-094 删除，实际共享消费方为 3 页** | ✅ |
| 5 | build→server/public + dev 代理 /api+WS | `web/vite.config.js` build.outDir=`../src/server/public`、dev 代理覆盖 /run /awf /api(ws) /status /send /respond /choice /ask /stop /intervene /context-ready…；server.cjs web 静态托管（CC_WEB_PUBLIC 覆盖、缺省 <src>/server/public；root→React SPA、尾兜底 assets/SPA 回退）；static.cjs createStaticHost 增 spa index 回退（资源 404 不被吞）；产物目录 gitignore | ✅（fixture 集成覆盖二态；真实 build 见遗留 L1） |
| 6 | ui.html 废弃 | 删 src/server/ui.html；server.cjs 去 GET /ui 路由、root 不再回退 ui；static/api 目录去 ui；open.js/awf.js 下线 `open ui`（可用 tree\|dashboard） | ✅ |

## 三、结构自检（diff 维度）

- **api client（ws,sid）**：`web/src/api/client.js` createApiClient({base,sid,httpFetch,wsFactory})，get/post/stream，URL 带 sid；ws 单测覆盖换算（ws://…?sid=）。
- **server 承载层收敛**：新增 `ws.cjs`（握手+文本帧+close/ping 识别、半关回 FIN）；run-host 事件实时扇出；server 决策闸门接入宿主事件环（host 未装配静默跳过，主流程零影响）。
- **命令面**：open tree → `{url}/?view=wbs-tree`；open ui 移除（cli-aux 用例同步）。
- **托管二态**：产物目录 index.html 存在即 React SPA，缺失回落 legacy dashboard（旧 dashboard/decisions/diagnostics 仍承载，作为未构建观测页；未在 v0.2.0 计划内退役）。
- 模型层纯函数、组件薄展示；React 组件不入仓 vitest（遵循既有约定），web 构建/真实 dev 验证见遗留。

## 四、佐证（既有绿测，不重复整套真跑）

web-* 模型 5 组单测 + ws/run-host subscribe/publish 单测 + 集成（ws 推送 run/task 事件、
decision.required 推送、握手拒绝、web-public 产物托管二态、静态 SPA 回退、cli-aux open 目标）均绿；
最新全量 91 文件 / 778 例绿。e2e 两既有失败为已知基线（run.e2e 端口占用、e2e-smoke 日志路径）。

## 五、遗留（标注不阻塞；与 exec 同步）

- **L1（真实环境验证）**：沙箱无网装不了 web 依赖 → 真实 `cd web && npm install && npm run build`
  （产物落 src/server/public）与 `vite dev` 5173 视觉/交互验证留真实 dev；server 静态托管「有/无产物」
  二态已由 CC_WEB_PUBLIC fixture 集成覆盖。前端 UI 真机 open dashboard 亦随此验证。
- **L2（dev 同源/代理软边界）**：web client 缺省 base=http://127.0.0.1:8787（绝对）；经 server 同源承载
  可用；走 vite dev 5173 跨源时需同源 base 或 CORS——proxy 已配但 client 缺省未用相对路径，待真实 dev 收敛。
- **L3（WS/决策推送边界）**：/run/events WS 仅 host 装配后可用（前端 10s 心跳兜底）；decision.required/record
  推送亦 host 装配后（真 claude 决策闸门 per-run 分支 + 双 run 由 T1-098 真 run 回归）。
- **L4（数据/展示边界）**：WBS 层级 edges 不落盘（awf_wbs_create 无 children）→ web 树对扁平 state 平铺为根
  （与旧 renderTree 一致）；深树需计划提供 children，属既有数据模型边界非本模块缺陷。
- **L5（小清理，不阻塞）**：dashboard-model.applyRunEvent 现仅单测引用（组件改事件→全量 refresh 后未用），
  保留导出；共享资产注释「4 托管页」为历史措辞（ui 已删，实际 3 页）未逐一清理。

## 六、结论

无阻断问题，未派生修复任务。W3-008 六项验收点（四视图迁移 + WS 事件驱动 + ?sid/多 run 壳 +
主题组件 + build→public 托管/dev 代理 + ui.html 废弃）结构与代码落点全部成立；遗留 L1–L5 均为
真实环境/软边界/小清理类，不阻塞门禁，随 T1-098 真 run 与后续收尾承接。→ **verdict: pass**
