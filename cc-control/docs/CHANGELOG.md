# Changelog

格式参考 Keep a Changelog + 语义化版本。重点概括项目级版本变迁，细节见各功能文档 / 开发日志。

## [Unreleased]

## [0.2.0] - 2026-09-11

> **全量一次性架构重构 + 决策闸门里程碑**（2026-09-07 决策闸门收敛 → 2026-09-11 重构收尾）。
> 细节见 `docs/features/`（36 份功能文档）、正式架构文档 `docs/discuss/architecture-v0.2.0.md`、
> 纪律对照取证 `.awf/reports/architecture-discipline-audit.md`。
> 一句话：**不是让 Claude Code 变聪明，是让它变持久** —— 常驻单写者控制平面 + 编排权归宿主 + 边界可机器验证。

### Added

- **常驻 Session Server 控制平面** —— server 从「run 期间的临时服务」变成常驻单写者控制平面：单实例多项目（`?p` 路由到各自 `ProjectCtx`）、空闲回收（`server-idle.cjs`）、`/shutdown` 优雅关闭、server 输出落 `.awf/logs/server.log`、36 条 HTTP 路由（参考 `docs/features/api.md`）
- **run 域（server 侧编排宿主）** —— 编排从 CLI 进程搬进 server：`run-host`（driveSingle / driveBatch / 事件环 / 收尾归档）+ `run-driver`（阶段链：simple DEV→COMMIT / medium DEV→TEST→COMMIT / complex DEV→DOCS→REVIEW→TEST→COMMIT）+ `run-scheduler`（滑动窗口：就绪池 + 四级配额 + plannedFiles 冲突 + 独占 + 补位）+ `batch-transport`（多 agent 派发与完成感知）+ `task-channel`（任务前上下文压缩检查 + 收尾协商）+ `gate-fix`（门禁闭环 verdict → 派生修复 → 复审，`MAX_RECHECK=3`）
- **宿主拥有调度权** —— 子 Agent 无调度权：禁写 state、只回吐 `RESULT` / `NEEDS_INPUT`（`plugin/core/agents/awf-worker.md`）；落账原子化走 `awf_task_complete`
- **`src/adapters/` 端口契约** —— `ports.cjs` 成为「进入 adapters 的唯一门」：7 端口名册 + `status: 'factory' | 'not-landed'` + 加载时自检（缺 `note`/`responsible` 直接抛错），避免「沉默的未收口」
- **store 持久化层** —— `store-core.cjs`（`state.lock` 单写序列化 + 原子写）+ `store.cjs`（按数据族分型：JsonFileStore / AppendFileStore / SnapshotStore / WriteQueue）；run state / 运行日志 / usage / decision / run-meta / metrics 全部收口
- **`web/` 前端工程（React + Vite）** —— 四视图（Dashboard / WBS-Tree / Decisions / Diagnostics）迁移；轮询 → WS 事件驱动；`?p` 项目作用域取数与项目切换条；构建产物入 `src/server/public` 并由 server 托管，构建接进 `npm run build` / `prepack`
- **决策闸门 + `ai-workflow-decision` 第三插件** —— 决策内核（decision-core）与协议资产（PROTOCOL / decision-result.schema / mode-instruction）独立成插件；`<AWF_DECISION_REQUIRED>` 标记 → Stop 闸门 → DC 自决 → `<AWF_DECISION_RESULT>` → DecisionStore 落盘（`.awf/decisions/runs/<runStamp>.jsonl`）+ CLI 中继续跑；`run.decision.enabled` 单源开关（缺省 false）
- **质量与验证体系** —— `scripts/check-architecture.mjs` 从取证工具升级为**可失败门禁**（三条不变量：零生产引用 / 依赖方向 / 可配置结构断言；进 `npm run build`）；真机回归 harness `npm run test:real`（13 个 case × 150 断言，全量 `--case all` / 定向 `--case <name>` 两入口，证据落 `sandbox/regression/`）
- **架构纪律文字化** —— 依赖单向 / 实例隔离 / 事件 schema 版本三条写入审查 checklist（`code-review-architecture`），并按纪律逐模块对照取证
- **正式架构文档** —— `docs/discuss/architecture-v0.2.0.md`（纪律 / 组织图 / 功能映射 / 决策归档）

### Changed

- **cli 薄化** —— `awf run` 由「司机」变为薄终端面（起环境 + 提交 run + 订阅事件 + 决策中继 + 收尾复位），新增 `run-client` 与 `src/lib/session/client.js`；调度写路径改经 server → 单写者成立
- **单 server 多项目 + sid 贯穿** —— 请求带 `?p=<projectRoot>` 路由到各自上下文；tmux 会话名 `cc-<projectSid>`；state / 日志 / 决策 / 槽位按实例分片
- **插件 MCP 收 server 薄代理** —— `awf-session` / `awf-oneshot` 全经 HTTP；`awf-state` 支持 `CC_AWF_STATE_SERVER=1` 单写者模式（非该模式仍有直连文件与降级回取，见未收口登记）
- **注册与渲染单源化** —— `plugin/config.json` 为唯一配置源，`scripts/render-config.mjs` 按 `marketplace.plugins` 遍历生成各插件 `plugin.json` + marketplace + 引擎插件 hooks/mcp
- **hooks 收口** —— 7 个 hook（SessionStart / UserPromptSubmit / Stop / SubagentStart / SubagentStop / PreToolUse / PostToolUse）统一经 `gateway.cjs` 网关转发（端口由渲染注入，hooks 单源只渲染进引擎插件）；hook 事件带项目根与 sid
- **超时判据改为「无变化窗口」** —— CC 仍 busy 不计时，仅 idle 且持续无变化才进收尾协商；`awf run` 主 run 不再注入 `CC_SID`（修 sid 分片 404）
- **版本统一 0.2.0** —— package / 三插件 / marketplace / state 对齐（version 单源入 `plugin/config.json` 经渲染下发）
- **前端资产托管** —— 页面路径统一由 `src/server/public` 的构建产物承载；缺产物时 **503 + 明确告警**（不静默回落、不留空白页）

### Fixed

- **写类端点缺 `?p` 静默兜底到 boot 项目** —— 曾导致不带 `?p` 的手工 curl 改写 boot 项目状态、把在跑的 run 暂停 4 小时；现写类端点缺 `?p` 一律 **400**（唯一豁免 `/shutdown`）
- **单 agent 派发路径绕过 pause 闩锁** —— 多 agent 与 channel 走了闩锁而 `max=1` 没走；现三条等待路径（`task-channel` / 单 agent executor / `batch-transport`）统一经 `pause.js`，且挂起超阈值产出告警
- **`tmux display-message` 对不存在的会话返回空串且 exit 0** —— `path.resolve('')` 静默取 cwd，导致 `--attach`/`--resume` 永远「假装复用」不存在的会话
- **前端从未被构建过** —— 根因是 `eslint-plugin-react-hooks` 的 peer 与 `eslint ^9` 冲突使 `web/` 的 `npm install` 直接失败；修复后构建接进 pipeline
- **`coverage/` 34 个陈旧跟踪文件入库** —— 内容是重构前的代码树（引用路径均已不存在）；已出库并加 `.gitignore`
- **嵌套 run 的环境污染** —— 真机 harness 从父 run 会话内执行时需剔除 `CC_*`/`AWF_*`，同一修法反向修到单测层（`tests/setup-env-scrub.js`）

### Removed

- **6 个未接线抽象模块** —— `run-registry` / `session-launch` / `server/app` / `server/api` / `layout-migrate` / `persist-pipeline`（生产侧零引用，能力已在 live 路径别处实现）+ 级联的迁移器骨架 `migrate.cjs`；专属测试同删
- **另两个零引用「单源」模块** —— `state-schema.cjs`（枚举失真、从未被消费）与 `statemachine.cjs`
- **旧前端资产** —— `dashboard.html` / `decisions.html` / `diagnostics.html` / `theme.css` / `common.js` / `ui.html`；`GET /` 等的 html 回退路由与 `defaultAliases()` 一并移除
- **旧决策入口（资产层）** —— `awf_await_choice` / `awf_await_input` 标记停用，决策改走门阀；**代码面仍在**（互斥化待定，见未收口）
- **`coverage/` 目录** —— 34 个陈旧跟踪文件出库

### 未收口（已在册，非本版承诺）

- **`adapters → server` 反向依赖** —— host/hook 的实现仍在 `src/server/`；`session` 端口的 live 实现仍是 `scripts/bootstrap.sh`（`not-landed`）。责任 `T1-113`
- **事件信封无版本字段**（审计 F8）—— 兼容读策略未定
- **`src/server/server.cjs` 仍是单体**（1491 行 / 结构断言上限 1600）
- **旧决策入口的代码面**（`/choice` `/ask` `/respond` 与两个 MCP 工具）与资产层的「已停用」标注并存。责任 `T1-106`（用户裁定暂缓）
- **真机回归的 case 隔离性** —— 全量连跑与单跑结论不一致。责任 `T3-011-F1`

> **版本说明**：本条目对应 awf state/runStamp 版本 0.2.0；npm 包版本见 `package.json`（同 0.2.0）。
> 三插件版本、marketplace 与 `plugin/config.json` 均已对齐 0.2.0（单源渲染，改 config 重跑即一致）。
> 多 agent 决策闸门、第二工具的接缝等后置项见 `docs/discuss/architecture-v0.2.0.md` §4.3。
