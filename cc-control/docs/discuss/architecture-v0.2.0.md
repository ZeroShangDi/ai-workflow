# AWF 架构终稿 v4 — 对应 v0.2.0

> **状态**：accepted（2026-09-11）
> **范围**：`ai-workflow`（本仓 `cc-control/`）v0.2.0 全量重构后的**架构事实**
> **读者**：接手开发的人与 AI；门禁审查的纪律依据（`code-review-architecture` 的三条纪律正文即本文件 §1）
> **定位**：本文件是**正式架构文档**。讨论过程与早期设想见 `architecture-notes.md`（笔记，append-only）；
> 本轮补做的分期与护栏见 `planned-architecture-landing.md`；纪律对照取证见 `.awf/reports/architecture-discipline-audit.md`。
> **可复现**：`node scripts/check-architecture.mjs`（依赖方向与零引用的机器证据）

---

## 0. 一句话

**ai-workflow 不是让 Claude Code 变聪明，是让它变持久。** 架构上落成三件事：

1. **常驻单写者控制平面** —— 一个常驻 HTTP Session Server 管住所有会变的状态，CLI / 插件 MCP / 前端都只是它的终端面；
2. **编排权在宿主** —— 单/多 agent 的任务调度、门禁闭环、收尾协商全在 server 侧的 run 域，AI 会话本身不持有调度权；
3. **边界可验证** —— 依赖方向、零引用、结构断言由 `scripts/check-architecture.mjs` 机器兜住，不靠人记得。

---

## 1. 纪律（文字化）

三条纪律是**门禁审查（`code-review-architecture`）的核验项**，也是本文件的正文。每条给出：约束 → 判据（违反长什么样） → 取证方式 → 当前状态。
**只写「符合 / 不符合」不算结论 —— 必须给命令输出或代码位置。**

### R1 · 依赖单向

**约束**：分层单向，不允许反向或跨层绕行依赖。

```
entry(awf.js) → cli ─┬─→ lib          地基（纯共享原语）
                     └─→ adapters     cc 端口契约
server        → lib, adapters
scripts       → lib, server
plugin MCP    ──HTTP──→ server         薄代理：不直连 src
web/          ──HTTP/WS──→ server      不直连 src
lib           ↛ server / adapters 的具体实现
adapters      ↛ server
```

**判据（违反长什么样）**：出现上表之外方向的 `require` / `import`，**含 `require(path.join(__dirname, …))` 形式的计算路径依赖**（字面扫描看不见它 —— 插件 MCP 正是用它回取 `src/`）。
**取证方式**：`node scripts/check-architecture.mjs`，输出越界边与逐条导入位置；声明方向白名单为脚本内的 `ALLOWED`（7 条边），**不得为过门禁放宽**。
**当前状态**：EXIT 0；4 条越界边**如实登记在 `EXEMPTIONS`**（`adapters → server`、`cli → server`、`plugin-mcp → adapters`、`plugin-mcp → lib`），全部责任 `T1-113`，理由与清法逐条写在表里。`--strict`（要求豁免表为空）当前 EXIT 1，属预期。

### R2 · 实例隔离

**约束**：实例级数据（state / 日志 / 决策 / 目录 / 会话名）按实例寻址，不落在与实例无关的固定位置；实例级数据不得放进模块级可变状态。

**判据**：固定路径或固定名承载本该按 `sid` 分片的数据；模块级 `let` / 模块级容器持有实例状态。
**取证方式**：会话名与日志目录断言 `cc-<projectSid>` / `.awf/logs/<runStamp>/`（真机 case `dual`、`web` 直接验两项目互不串）；顶层可变状态扫查（目前**无脚本，手工取证**）。
**当前状态**：成立。单 server 多项目经 `?p` 路由到各自的 `ProjectCtx`（`src/server/project-context.cjs`）；会话名 `cc-<projectSid>`（`src/lib/run-context.cjs` 派生 `p` + sha1 前 12 hex）；per-run 槽 `src/server/run-slot.cjs` 按 `sid` 隔离 ready/busy/decision。
**已知缺口**：`run-slot` 的 `contextReady` 是**永假死值**（定义了但无人置位）—— 见 `.awf/issues/004`，已立项 `T1-120`。

### R3 · 事件 schema 版本

**约束**：事件形状变更必须可判定 —— 信封带版本字段或消费方有兼容读路径。

**判据**：有形状变更却没有版本字段 / 兼容读，消费方无法判断自己读到的是哪一版。
**取证方式**：读事件信封定义 + 核对消费方。
**当前状态**：**未达成，已登记**。`src/lib/events.cjs` 的信封为 `{ type, at, runId, payload }`，**无版本字段**（审计 F8）。消费方含 WS 推送与前端（`web/` 是独立构建产物，经静态托管，存在与服务端版本错配的真实场景）。当前未爆，属设计缺口而非既有缺陷；是否引入兼容读的策略由本文件归档为「未决」（见 §4.3）。

> **这三条的边界**：R1 已被机器兜住；R2 部分被真机 case 兜住；R3 目前**只有文字，无机器守卫**。凡「零导入」「已收口」类自述，必须先跑补扫（含计算路径）再写。

---

## 2. 组织图

### 2.1 分层与允许方向

```
┌──────────────────────── 进程边界 ────────────────────────┐
│                                                          │
│  awf.js（CLI 入口）                                       │
│    └── src/cli/        薄终端面：init / plan / run /      │
│                        server / plugin / open / attach   │
│          ├── src/lib/          共享地基（无副作用原语）    │
│          └── src/adapters/     cc 端口契约（唯一门）       │
│                                                          │
│  常驻 Session Server（src/server/，默认 :8787）            │
│    ├── 控制平面：server.cjs / project-context / static /  │
│    │             ws / interact / run-slot                 │
│    ├── run 域：run-host / run-driver / run-scheduler /    │
│    │           batch-transport / task-channel / gate-fix  │
│    ├── 决策面：decision-gate / decision / decision-store  │
│    └── cc 接入：host / tmux / hook-adapter（**待收口**）   │
│                                                          │
│  plugin/（三插件，经 .claude-plugin/marketplace.json 注册）│
│    core（引擎：MCP + hooks + 运行态命令/技能）             │
│    decision（决策技能 + 协议资产，无 mcp/hooks/命令）       │
│    plugin-code（编程命令 + 技能）                          │
│    ├── 3 个 MCP server                              │
│    │     awf-session / awf-oneshot：全经 HTTP 到 server   │
│    │     awf-state：`CC_AWF_STATE_SERVER=1` 时经 HTTP      │
│    │     （单写者模式），否则直连文件 + 缺 src/ 时降级回取  │
│    │     —— 降级回取登记为 R1 债（F6，责任 T1-113）        │
│                                                          │
│  web/（React + Vite）──HTTP/WS──→ server；产物入            │
│       src/server/public（构建物，不入库）                   │
└──────────────────────────────────────────────────────────┘
```

**允许方向（机器白名单 `ALLOWED`，7 条）**
`entry → cli`｜`cli → lib`｜`cli → adapters`｜`server → lib`｜`server → adapters`｜`scripts → lib`｜`scripts → server`

### 2.2 运行时形态（一次 `awf run` 的装配）

```
awf run（薄入口：起环境 + 提交 run + 订阅展示 + 决策中继）
  ├─ 确保常驻 server（单实例多项目：存在即复用，请求带 ?p 路由）
  ├─ 创建 tmux session  cc-<projectSid>
  │    └─ scripts/bootstrap.sh → claude（插件/hooks/MCP 走 settings.json 注册链路，不渲染）
  ├─ POST /run/submit 提交 run，此后只订阅 /run/events 与中继决策
  └─ 宿主（src/server/run-host.cjs）持有编排权
       max=1  → driveSingle：逐任务标注阶段链并派发
                simple DEV→COMMIT / medium DEV→TEST→COMMIT
                complex DEV→DOCS→REVIEW→TEST→COMMIT（+ 按需 DEBUG）
       max>1  → driveBatch：就绪池 + 四级配额 + plannedFiles 冲突 + 独占 → batch-transport 派发
       门禁闭环：verdict 非 pass → 派生修复任务 + 门禁回退 pending（MAX_RECHECK=3）
       收尾：backupState → 复位 mode（若 mode 是本宿主改的）→ CLI 侧 mode=idle
```

**关键不变量**
- **宿主拥有调度权**；子 Agent 无调度权：禁写 state、只回吐 `RESULT` / `NEEDS_INPUT`（`plugin/core/agents/awf-worker.md`）。
- **单写者**：state 的写路径收敛到 server；CLI 写类请求经 HTTP 打标到 `?p` 指向的项目。
- **阶段间上下文天然断裂**：每阶段 prompt 重新构造，不依赖上一阶段对话历史。
- **写类端点缺 `?p` → 400**，唯一豁免 `/shutdown`（读类保留 boot 兜底 —— `GET /status` 是 CLI 的 server 发现入口）。

### 2.3 模块职责（逐层）

| 层 | 模块 | 负责 | 明确不负责 |
|---|---|---|---|
| entry | `src/awf.js` | 7 命令路由与选项声明 | 任何业务逻辑 |
| cli | `run.js` + `run-client.js` | 起环境、提交 run、订阅事件、决策中继、收尾复位 | **不持有编排** |
| cli | `init.js` / `plugin.js` | 本地注册（写项目 `.claude/settings.json` 与 `.mcp.json`）/ 全局安装 | 不渲染配置（渲染由 `render-config.mjs`） |
| cli | `plan.js` | 归档判定 → 取插件模板提示词 → 起交互式会话 | 不写 state |
| cli | `server.js` / `attach.js` / `open.js` | 常驻 server 生命周期 / 挂接会话 / 打开可视化页 | — |
| lib | `store-core.cjs` + `store.cjs` | 持久化核心（`state.lock` 单写序列化 + 原子写）与按数据族分型的 store | 不定义业务 schema |
| lib | `state.js` | state.json 读写 + 就绪池 / 作用域索引 / 文件冲突判定 | 不做调度决策 |
| lib | `run-context.cjs` / `run-id.cjs` / `runtime-config.cjs` | 装配器（sid→路径/会话名/workdir/settings）、run 标识、运行期常量单源 | 零副作用 |
| lib | `events.cjs` | 进程内事件总线 + 事件类型定义 | 尚未进生产热路径（见 R3） |
| lib | `pause.js` | pause 闩锁（三条等待路径共用） | 不改编排语义 |
| lib | `plugin-bridge.js` | **claude 与插件边界的唯一模块**：读插件 `prompts.json` 填模板 | 不写死插件命令字符串 |
| adapters | `ports.cjs` | 端口契约与**进入 adapters 的唯一门**；名册 + `status: 'factory' \| 'not-landed'` + 加载自检 | 不实现端口 |
| adapters | `oneshot` / `tooling` / `interactive` / `probe` / `cc-shapes` / `mock` | 各 cc 能力面实现（`claude` 字面只在本层） | session 端口尚未落地 |
| server | `server.cjs` | HTTP 路由分发、hook 处理、决策闸门接线、静态托管 | 单体内仍含多个子能力（**待拆**，见 §4.3） |
| server | `project-context.cjs` + `run-slot.cjs` | 每项目上下文容器与注册表；per-run 内存状态机 | — |
| server | `run-host.cjs` + `run-driver` + `run-scheduler` + `batch-transport` + `task-channel` + `gate-fix` | run 域：调度、阶段链、门禁闭环、收尾协商 | 不直接操作 tmux（经 host/tmux 原语） |
| server | `decision*.cjs` | 决策闸门规则、结果解析、追加式落盘、模式指令 | 不产出决策内容（那是 DC 的活） |
| server | `host.cjs` / `tmux.cjs` / `hook-adapter.cjs` | tmux 原语与会话启动；hook→领域事件翻译接缝 | **应迁入 adapters（R1 债 F3/F5）** |
| plugin | `core` / `decision` / `plugin-code` | 见各插件 README；MCP 工具面 20 + 7 + 1 | MCP 不做状态决策：`awf-session` / `awf-oneshot` 全经 HTTP；`awf-state` 在 `CC_AWF_STATE_SERVER=1` 下经 HTTP 单写者模式，否则直连文件（其「纯插件副本无 `src/`」的降级回取是 R1 债 F6） |

---

## 3. 功能映射

### 3.1 功能 → 文档 → 源码 → 测试

每份功能文档的实际落点（`docs/features/` 共 36 份，此处给主表）：

| 功能 | 功能文档 | 主要源码 | 真机 case |
|---|---|---|---|
| Session Server（控制平面） | `server.md` / `api.md` | `src/server/server.cjs`、`static.cjs`、`ws.cjs`、`project-context.cjs` | `web` `lifecycle` |
| run 域（编排宿主） | `run-domain.md` | `run-host/run-driver/run-scheduler/batch-transport/task-channel/gate-fix` | `single` `gate` `multi` `pause-release` |
| `awf run`（CLI 薄入口） | `run.md` | `src/cli/run.js`、`run-client.js`、`src/lib/session/client.js` | `single` `resume` `recover` |
| store 持久化 | `store.md` | `src/lib/store.cjs`、`store-core.cjs` | （单测 + 真机间接） |
| state.json | `state.md` | `src/lib/state.js`、`plugin/core/mcp/awf-state/` | 全部 case 间接 |
| adapters 端口 | `adapters.md` | `src/adapters/*` | `mcp` |
| 事件总线 | `events.md` | `src/lib/events.cjs` | —（尚未进热路径） |
| 运行指标 | `metrics.md` | `src/lib/run-metrics.cjs` | `web` |
| 运行日志 | `run-logger.md` | `src/server/run-logger.cjs`、`src/lib/server-log.js` | `single` `pause-release` |
| hooks | `hooks.md` | `plugin/core/hooks/*`、`src/server/hook-adapter.cjs` | 全部 case 依赖 |
| 决策门阀 | `decision-system.md` | `src/server/decision*.cjs`、`plugin/decision/**` | `decision` |
| 旧上抛/自动选择 | `auto-decision.md` | `src/lib/session/client.js`、`src/server/interact.cjs` | — |
| tmux 会话 | `tmux-session.md` | `src/server/tmux.cjs`、`host.cjs`、`scripts/bootstrap.sh` | 全部 case |
| 插件 MCP | `oneshot.md` 等 | `plugin/core/mcp/awf-{state,session,oneshot}/` | `mcp` |
| CLI 辅助 | `init.md` `plan.md` `cli-aux.md` `bootstrap.md` | `src/cli/*`、`src/lib/profile.js`、`plugin-bridge.js` | `init` |

### 3.2 对外面（命令与工具）

| 面 | 数量 | 落点 |
|---|------|------|
| CLI 命令 | 7：`init` / `plan` / `run` / `plugin` / `server` / `open` / `attach` | `src/awf.js` |
| slash 命令 | core（`w-start` `w-pause` `w-monitor` `w-state`）+ plugin-code（`w-plan*` `w-dev` `w-debug` `w-review` `w-test` `w-doc` `w-commit` `w-ui-*`） | `plugin/*/commands/` |
| MCP 工具 | `awf-state` 20 · `awf-session` 7 · `awf-oneshot` 1 | `plugin/core/mcp/` |
| HTTP API | 36 条路由 | 见 `api.md` |
| 真机回归 case | 14（`npm run test:real -- --case all`） | `tests/regression/fullflow-regression.mjs` |

---

## 4. 决策归档

### 4.1 已定勿翻（长期约束，改动前须先推翻本节）

| 决策 | 理由 |
|---|---|
| **常驻 server 单写者控制平面** | 单写者才谈得上原子与可观测；多写者是本仓历史事故的主因 |
| **CLI 薄化，经 `run-client` 提交** | 编排权必须在宿主，否则 CLI 一死 run 就死 |
| **`sid` 贯穿多 run** | 单机并发多项目的前提；会话名/日志/state/决策全按实例分片 |
| **插件 MCP 收 server 薄代理** | 工具面不重复实现状态逻辑，避免第二份真相。当前达成度：`awf-session` / `awf-oneshot` 全经 HTTP；`awf-state` 另有直连文件模式与降级回取（R1 债 F6，责任 `T1-113`） |
| **注册/渲染单源**（`plugin/config.json` → `render-config.mjs`） | 三插件 × 多注册文件手抄必然漂移 |
| **前端经 HTTP/WS 取数**，不直连 src | 构建产物独立演进，不随服务端源码耦合 |
| **插件改动 CLI 零感知** | 提示词由插件 `prompts.json` 声明，耦合只在 `plugin-bridge.js` |

### 4.2 v0.2.0 关键决策（含日期与落点）

| 日期 | 决策 | 原因 | 落点 |
|---|---|---|---|
| 2026-09-07 | 决策系统收敛为**第三插件** + 单 agent 决策闸门 | 决策内核与协议资产需要独立演进；hooks 仍单源在 core | `plugin/decision/`、`architecture-notes.md` |
| 2026-09-10 | 决策入口**换代**：`<AWF_DECISION_REQUIRED>` 门阀取代 AskUserQuestion 上抛 | 上抛链路依赖人在环，run 内不可自洽 | `decision-system.md`、`.awf/bugs/decision-entry-two-generations.md` |
| 2026-09-10 | 写类端点缺 `?p` **一律 400**（不兜底到 boot） | 不带 `?p` 的手工 curl 曾静默改写 boot 项目并暂停在跑的 run 4 小时 | `.awf/bugs/write-endpoint-missing-p-fell-back-to-boot.md`、`api.md` §约定 |
| 2026-09-11 | 结构门禁从「取证工具」升级为**可失败门禁**（`check:arch` 进 `npm run build`） | 「抽象建了没人用」靠提醒拦不住 | `scripts/check-architecture.mjs`、`.awf/issues/002` |
| 2026-09-11 | 未接线抽象**删除优于标注**（删 6 模块 + `coverage/` 出库） | 判据：生产侧零引用 **且** 能力已在 live 路径别处实现 | `.awf/reports/test/w3-009-module-gate.md` |
| 2026-09-11 | 豁免表格式化为**责任任务可达性**（新增 `unreachableResponsibles`） | 「有责任人」不等于「责任人走得到」 | `scripts/check-architecture.mjs`、`w3-009-module-gate.md` §十 N-6 |
| 2026-09-11 | `web/package-lock.json` **入库** | 根锁文件本就入库且同为 npmmirror；据镜像 URL 拒绝入库收益为零 | 见 `w3-009-module-gate.md` §十 N-5 |
| 2026-09-11 | 真机回归**两种粒度**（全量 `--case all` / 定向 `--case <name>`） | 最终验收需一次全量；开发期需要快反馈 | `fullflow-regression.mjs`、`real-run-coverage-gaps.md` |

**已归档**（`docs/discuss/_archived/`）：`architecture-v0.1.3.md` 及早期 CLI/WBS/任务稿 —— 属 v0.1.x 形态，**不再代表现状**，仅作历史。

### 4.3 未决与登记债（本文件的「不许沉默」清单）

| 项 | 内容 | 归属 |
|---|---|---|
| **R1 的 4 条越界边** | `adapters→server`（host/hook 实现仍在 server）、`cli→server`（run-settings 归属）、`plugin-mcp→{adapters,lib}`（纯插件副本降级路径去留） | `T1-113`（豁免表已登记，责任可达性已有机器断言） |
| **R3 未达成** | 事件信封无版本字段；兼容读策略未定 | 本文件归档为未决，需一次显式决策 |
| **`server.cjs` 仍是单体**（1491 行 / 上限 1600） | 结构断言只拦住「拆分前继续膨胀」 | `T1-113`（A：server 分层） |
| **门禁扫描假阴性** | 注释里的 import 被当引用 → 零引用不变量漏检 | `.awf/issues/003` → `T1-120` |
| **声明与实现不符 7 条** | 参数被丢弃 / 死值 / 空声明 / 陈旧注释 | `.awf/issues/004` → `T1-120` |
| **旧决策入口的代码面仍在** | `/choice` `/ask` `/respond` 与两个 MCP 工具仍注册在册，而资产层已标停用 | `T1-106`（用户 2026-09-10 裁定暂缓） |
| **真机 case 的隔离性** | 全量连跑与单跑结论不一致 | `T3-011-F1` |

---

## 5. 变化轴与扩展方式（新东西该往哪加）

| 要加的东西 | 加在哪 | 不要做什么 |
|---|---|---|
| 一个新 CLI 命令 | `src/cli/` + `src/awf.js` 注册 | 不在 CLI 里写编排或插件命令字符串 |
| 一个新阶段的编排规则 | `src/server/run-driver.cjs` 的链定义 | 不在 CLI 加分支 |
| 一个新的 cc 能力面 | `src/adapters/` 新端口 + 名册登记（`status` 必填）+ 生产消费者经 `ports.cjs` | 不直接 require 具体 adapter 文件 |
| 一个新事件类型 | `src/lib/events.cjs` 的 `EVENT_DEFS` | 不绕过定义直接发裸对象 |
| 一个新的 MCP 工具 | `plugin/core/mcp/*/server.cjs` 薄代理 | 不在 MCP 内实现状态逻辑 |
| 一个新真机回归场景 | `tests/regression/fullflow-regression.mjs` 的 `CASES` + 同步 `real-run-coverage-gaps.md` 矩阵 | 不加依赖其他 case 残留的 case |
| 一个新的结构约束 | `scripts/check-architecture.mjs` 的 `STRUCTURE_RULES` | 不放宽 `ALLOWED` 或加 glob 白名单 |

---

## 6. 已知边界（本文件**不**承诺的事）

- R2（隔离）与 R3（事件版本）**无机器守卫**，只有文字判据与部分真机断言；写结论前必须取证。
- 真机回归只证明「13 个已注册 case 覆盖的链路在真机通过」，**不等于功能全绿**（缺口矩阵见 `real-run-coverage-gaps.md`）。
- `src/lib/version.js` 的版本确认功能**未接线**（`src/cli/init.js` / `plan.js` 两处 import 与调用均被注释，注明「版本处理暂时禁用」），本文件不假设它在生效。
- 本文件描述的是**当前工作树**（v0.2.0 收尾阶段）；`main` 分支上的形态以各自版本为准。
