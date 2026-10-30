# Handoff Snapshot — AWF v0.2.0 重构收尾现场

> 生成 2026-09-11（awf run 主会话压缩点）。项目根：`/Users/shangjunhao/Project/ai-workflow/ai-workflow/cc-control`
> （git root 是**上一级** `/Users/shangjunhao/Project/ai-workflow/ai-workflow`；本项目是子目录）。
> 分支 `feature/cc-control-v0.2.0`。HEAD 仍是 `e6385ec`（本轮所有 dev 任务均**未提交** —— DEV 落账 commits 为空，提交归 COMMIT 阶段）。
> 当前 awf run 占用端口 8787（常驻 server + tmux `cc-pe22fe94169be`），**禁嵌套真 run**；真机回归一律用隔离端口（见下）。

## Goal

按 `.awf/state.json` 任务图推进 v0.2.0 收尾：剩余 10 项 = **T3-009 模块门禁复审**（active）、T1-100…T1-103（doc）、T3-010 / T3-011 / T4-001（门禁）、T1-106（dev）、T1-113（dev，A/D 立项）。
本轮（压缩点之前）额外完成了计划外的「结构性补齐」一批 T1-114…T1-119 —— 起因是发现 v0.2.0 有四条轴**只建了抽象没接 live**（依据 `.awf/issues/002-integration-has-no-task.md` 与 `docs/discuss/planned-architecture-landing.md`）。

## State

**本轮已完成（均 `awf_task_complete` done，commits 为空）**：
T1-098（真机回归框架）、T1-099（架构纪律入 checklist + `scripts/check-architecture.mjs`）、**T3-009 门禁判 `changes_requested`**（→ 派生 T3-009-F1）、T3-009-F1（删 6 个未接线模块 + coverage/ 出库）、T1-108（恢复/介入真机 case）、T1-109（前端/生命周期真机 case）、T1-110（写类端点缺 `?p` 收口）、T1-111（pause 闩锁放行与告警）、T1-112（server 输出落 `.awf/logs/server.log`）、T1-114（`check-architecture` 升级为可失败门禁）、T1-115（删 `state-schema.cjs`/`statemachine.cjs`）、T1-116（ports 契约补全）、T1-117（生产改走端口契约）、T1-118（web 构建进 pipeline）、T1-119（旧前端资产退役）。

**测试基线**：`npm test` = **95 文件 / 844 例全绿**；`npm run lint` / `npm run build` / `node scripts/check-architecture.mjs`（EXIT 0）均通过。
真机回归 `npm run test:real` = **13 个 case**：`single gate multi decision dual resume pause recover pause-release init mcp lifecycle web`；用 `--port 8799` 走隔离 server（会复制 `plugin/` 到沙箱并重渲染 hooks 端口，跑完自动停）。

**关键代码事实（标识符原样）**
- **真机回归框架**：`tests/regression/fullflow-regression.mjs`（+ `tests/helpers/http-api.js` 供单测复用的写请求自动补 `?p`）。
- **结构门禁**：`scripts/check-architecture.mjs` —— 三条不变量（零生产引用 / 依赖方向 / 可配置结构断言）+ `ENTRY_ALLOWLIST`（逐文件、无 glob）+ `EXEMPTIONS`（每条 reason+responsible）+ `--strict` / `--warn-only` / `--json` / `--root`。当前：白名单 3 条、豁免 4 条（全部 `responsible: T1-113`）。
- **端口契约**：`src/adapters/ports.cjs` 是**进入 adapters 的唯一门**（导出 `PORT_CONTRACT`/`PORT_NAMES`/`NON_PORT_TOOLS`/`PORT_IMPLS`/`assertPortContract`/`createCcAdapters` + 单端口句柄 `host hook oneshot tooling interactive probe ccShapes`）。**导出必须顶层 const + 简写**：cjs-module-lexer 不认 `...spread` 与 `name: OBJ.prop`，写错会让 `awf init` 直接挂。
- **server**：`server.cjs` 页面路径收口为 `PAGE_PATHS`（`/ /dashboard /dashboard.html /diagnostics(.html) /decisions(.html)`）→ 一律由 `src/server/public` 构建产物承载；缺产物 → **503 + 提示 `npm run build`** + 日志 `[web] 前端产物缺失`。`htmlDir()`/`CC_HTML_DIR` 已删。`static.cjs` 的 `defaultAliases()` 已删。
- **per-sid 状态机**：`src/server/run-slot.cjs` 的 `createRunSlot(sid)`（ready/busy/decisionPending/contextReady/waiters），由 `src/server/project-context.cjs` 的 `runSlotFor(sid)` 持有、`server.cjs` 的 `handleSidHook` 驱动。
- **写类端点约束（T1-110）**：非 GET/HEAD/OPTIONS 的请求**必须带 `?p=`**，否则 400；唯一豁免 `/shutdown`。读类保留 boot 兜底（`GET /status` 是 CLI 的 server 发现入口）。
- **pause 闩锁（T1-111）**：`src/lib/pause.js` 的 `waitWhilePaused(projectRoot, { pollMs, label, isSettled, log, alertMs, heartbeatMs })` 返回 `{ waited, releasedBy: 'resumed'|'settled'|null, waitedMs, polls }`；超阈值（`CC_PAUSE_ALERT_MS`，缺省 30s）打一次告警、之后 `CC_PAUSE_HEARTBEAT_MS` 心跳。三条等待路径：`task-channel.settleTask`、`defaultSingleExecutor.runTask`、`batch-transport.dispatch`。
- **server 日志（T1-112）**：`src/lib/server-log.js` 的 `openServerLog(logPath,{maxBytes})`；`run.js` 的 `ensureServer` 与 `cli/server.js` 的 `start` 把 server 的 stdout/stderr 接到 `<proj>/.awf/logs/server.log`（追加 + spawn 时单代轮转，`CC_SERVER_LOG_MAX_MB` 缺省 5）。编排层通知 `notice(pcx,kind,level,msg)` **双写**（项目运行日志 + console）。
- **前端**：`web/`（React+Vite）→ `npm run build` / `prepack`（`scripts/build-web.mjs`，`AWF_SKIP_WEB=1` 显式跳过、`--required` 发布路径忽略该开关）构建到 `src/server/public`（不入库，但**进 npm 包**）。`web/package.json` 的 `eslint-plugin-react-hooks` 已升 `^5.2.0`（4.x 的 peer 上限是 eslint 8，曾导致 install 直接失败）。
- **已删除**（本轮）：`src/lib/{run-registry,layout-migrate,persist-pipeline,state-schema,migrate}.cjs`、`src/server/{app,api,session-launch,statemachine}.cjs`、`src/server/{dashboard,decisions,diagnostics}.html`、`src/server/{theme.css,common.js}`、`coverage/`（34 个陈旧跟踪文件）。
- `.awf/state.json` 只能经 awf-state MCP 改；`.awf/context/architecture.md` **不存在**（架构终稿归 T1-101）。

## Tried

- 固定流程：读 `.awf/state.json` 任务定义 → 改代码/测试 → `npm test` + `npm run lint` + `npm run build` + `node scripts/check-architecture.mjs` → `awf_task_complete(result/files/architecture)`。
- 真机验证一律 `npm run test:real -- --case <name> --port 8799`（隔离 server，跑当前工作树；常驻 8787 跑的是它启动时的代码，测服务端改动必须用隔离端口）。
- 走了弯路并已修正：`--port` 一开始只换端口 → 插件 hooks 端口是渲染期烘进 `plugin/core/hooks/hooks.json` 的 argv，导致 hook 事件发往默认端口、状态机永不 ready（两个假失败）；解法是「插件副本」（把 `plugin/` 复制到沙箱、只改副本 hooks 端口、沙箱项目 marketplace 指向副本）。

## Decisions

- **不静默兜底**：写类端点缺 `?p` → 400；前端产物缺失 → 503 + 明确告警；pause 挂起超阈值 → 告警。反复出现的口径是「把沉默变成会响的东西」。
- **未收口必须结构化登记**：`ports.cjs` 的 `status: 'factory' | 'not-landed'` + 强制 `note`/`responsible`，加载即自检（`assertPortContract`）；`EXEMPTIONS` 同理（reason + responsible task id）。
- **不得为过门禁放宽规则**：`ALLOWED` 集合一字未改；结构债一律如实进 `EXEMPTIONS` 并指责任务（现全部指向 **T1-113**）。
- **删除优于标注**（对「建了没人用」的抽象）：判据 = 生产侧零引用 **且** 能力已在 live 路径别处实现。
- **已定勿翻**：server 常驻单写者控制平面、cli 薄化经 run-client、sid 贯穿多 run、MCP 收 server 薄代理、注册/渲染单源、前端经 api+WS。
- **只本地 commit 不 push；commit 不带 Co-Authored-By**；压缩轮只判断 + 写快照。

## Evidence

- `npm test` 95 文件 / 844 例全绿；`npm run build`（含 `render-config` + 语法检查 + 结构门禁 + web 构建 + `npm pack --dry-run`）通过。
- **真机**（隔离端口）最近结果：`single` 6/6、`decision` 9/9、`pause` 19/19、`pause-release` 15/15、`web` 15/15、`init` 14/14、`mcp` 10/10、`lifecycle` 6/6。
- 踩过的坑（都在代码注释与文档里留了痕）：
  - `tmux display-message` 对**不存在**的会话返回空串且 exit 0，而 `path.resolve('')` 静默取 `process.cwd()` → `--attach`/`--resume` 曾永远「假装复用」不存在的会话（T1-108）。
  - 单 agent 派发路径曾**绕过 pause 闩锁**（多 agent 与 channel 走了，唯独 `max=1` 没走）→ 暂停期间照样派发（T1-108）。
  - `resolveCtx` 的 `p || bodyProjectRoot || projectRoot || boot` 让不带 `?p` 的手工 curl 静默写进 boot 项目 → 2026-09-10 把在跑的 run 暂停了 4 小时（复盘：`.awf/bugs/write-endpoint-missing-p-fell-back-to-boot.md`）。
  - `lifecycle` 真机 case 首版把「轮询等它关闭」写成实现，而 server 每次请求都刷新 `lastActivityAt` → 自己把它喂活（观测者效应）。
  - ESM 具名导入从 CJS 取展开/成员表达式导出会运行时报错（`awf init` 曾挂，单测绿也拦不住 —— vitest 的 CJS 互操作 ≠ Node 原生分析）。
- 报告/文档留痕：`.awf/reports/test/w3-009-module-gate.md`、`.awf/reports/architecture-discipline-audit.md`（含多处 addendum）、`.awf/bugs/write-endpoint-missing-p-fell-back-to-boot.md`、`.awf/issues/002-integration-has-no-task.md`、`docs/discuss/planned-architecture-landing.md`。
- `docs/features/server.md` 与 `docs/features/server.test.md` **仍按旧结构**描述 `dashboard.html` 与 `GET /` 回退 —— 属 **T1-100** 的活。

## Feedback

- 直接执行、不解释计划、不复述已知信息、优先结构化输出；只 commit 不 push；commit message 不带 Co-Authored-By。
- 任务图/state 改动直接动手别先问（但备份 + 走锁不能省）。
- 压缩轮是**纯判断轮**：只判断 + 写快照 + `awf_context_ready`，不做任何任务工作。

## Next

1. **下一个任务大概率是 T3-009 复审**（它门禁判 `changes_requested` 后已被回退，当前 `active`）。复审对象是**变化很大**的树：T3-009-F1 删了 6 个模块、T1-115/116/117 动了 adapters 契约与生产消费者、T1-118/119 改了前端与页面路由。复审时注意：
   - 用 `node scripts/check-architecture.mjs`（EXIT 0，豁免 4 条均 `T1-113`）与 `npm test`（95/844）作结构证据；
   - 模块 acceptance 里的 `dashboard/decisions/diagnostics.html`、`theme.css`、`common.js` 相关项**已随 T1-119 退役**，不要按旧口径判失；
   - 需要真机证据时用 `--port 8799`（禁嵌套真 run）。
2. 之后按图推进：T1-100 → T1-101 → T1-102 → T1-103 → T3-010 → T3-011（全量真机门禁 `--case all`）→ T4-001 → T1-106 → T1-113（A/D 立项；它同时是 4 条结构债豁免的责任任务）。
3. 记牢：**T3-011 跑全量真机前，常驻 8787 的 server 是旧代码** —— 用 `--port 8799` 或在 run 收尾后重启，否则会拿到失真结论。
4. 上下文再告警时重复本流程（写 `.awf/context/handoff.md` → `awf_context_ready`）。
