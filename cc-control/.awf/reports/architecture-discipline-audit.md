# 架构纪律对照审计（v0.2.0 重构模块）

> 任务：T1-099（W3-009 质量与验证）— 架构纪律（依赖单向 / 隔离 / 事件 schema 版本）写入 review checklist，并按 code-architecture 对照应用到各模块。
> 口径：**以实际导入关系与代码位置为证据**，不以模块名、注释或文档自述代替。
> 范围：W3-001…W3-008 八个重构模块的当前产物。纪律正文（约束为什么这么定）归 T1-101 架构终稿；本报告只做对照取证。
> 复现：`node scripts/check-architecture.mjs`（层间导入取证，输出越界边与逐条导入位置）+ 文内列出的 grep。

## 一、三条纪律在本项目的判据

| 纪律 | 判据（违反长什么样） | 取证方式 |
|---|---|---|
| **依赖单向** | 存在与既定分层相反方向的导入；同一模块同时依赖上下游两侧 | 层间导入图（按目录分层归档每一条跨层 `require`/`import`，**含 `path.join(__dirname,…)` 形式的计算路径 require**——字面扫描看不见它） |
| **隔离** | 实例级数据（state/日志/决策/目录/会话名）落在与实例无关的固定位置；实例级数据放在模块级可变状态 | 顶层 `let`/模块级容器扫描 + 固定路径/固定名扫描 |
| **事件 schema 版本** | 事件形状有变更却无版本字段或兼容读路径，消费方无法判定 | 读事件信封定义 + 核对消费方 |

既定分层（依据 `docs/discuss/architecture-notes.md`、`.awf/context/handoff.md` 的「已定勿翻」与 W3-001…008 模块描述）：

```
awf.js → cli ─┬─→ lib（共享地基）
              ├─→ adapters（cc 端口）
              └─→ lib/session/client ──HTTP──→ server
server → lib, adapters
adapters → （端口实现；不应反向依赖 server）
lib → （不应依赖 server / adapters 的具体实现）
plugin MCP → HTTP → server（薄代理，不直连 src）
web → HTTP/WS → server（不直连 src）
```

## 二、模块 × 纪律对照矩阵

| 模块 | 依赖单向 | 隔离 | 事件 schema 版本 |
|---|---|---|---|
| W3-001 地基（config/装配/run-id/schema 核心） | ✅ 本模块产物无跨层越界 | ✅ | — |
| W3-002 store 单写者数据层 | ✅ | ✅ 全部落 `.awf/runs/<sid>/`，按 sid 寻址 | — |
| W3-003 server 控制平面 + run 域 | ⚠ 见 F2b/F5（其实现被上层依赖） | ✅ | ❌ 见 F8 |
| W3-004 adapters/cc 工具适配收口 | ❌ 见 F3/F5/F7 | ✅ | — |
| W3-005 cli 薄化 + client | ⚠ 见 F4 | ✅ | — |
| W3-006 多 run sid 贯穿 | ⚠ 见 F1/F2a（`run-registry` 反向依赖上层） | ✅ 槽按 sid 建、会话名 `cc-<sid>`、hook 按 sid 路由 | — |
| W3-007 插件层收口 | ⚠ 见 F6（计算路径 require 回取 `src/`） | ✅ 运行面经 HTTP 到 server | — |
| W3-008 前端 web/ | ✅ 无 `web → src` 导入边 | ✅ | — |

> 「越界」依「导入方」归属模块；被依赖方若非该模块职责，另注。单模块内自洽不等于跨模块方向正确——本表按**导入方**列为责任方。

已核验**成立**的边界（不是「没查」，是查了干净）：

- `web/` 对 `src/` 零导入 —— 前端只经 api/WS。
- `lib` 不依赖 `server`（除 F1 一处）、不依赖 `cli` —— 地基无循环。
- 模块级可变状态全仓仅 `src/server/server.cjs:52 lastActivityAt`（空闲回收计时），属**进程级**而非实例级，不构成串号。
- 插件 MCP 的**运行面**（工具调用）经 HTTP 到 server，薄代理形态成立；但其**加载面**另有一条回取 `src/` 的静态依赖，见 F6。

## 三、违规清单

### F1 · lib 反向依赖 server（`run-registry.cjs` → `statemachine.cjs`）

- 证据：`src/lib/run-registry.cjs:25 const { createStateMachine } = require('../server/statemachine.cjs')`，并在 `smFactory = (sid) => createStateMachine({ sid })` 中作为**默认值**。
- 违反：`lib → server` 是反向依赖。地基模块把控制平面的具体实现钉进自己的默认参数。
- 严重度：**中**。可小步收敛——`run-registry` 已支持 `smFactory` 注入，只需把默认工厂从「自己 require」改为「由装配根传入」，行为不变。

### F2 · lib 反向依赖 adapters 具体实现（`run-registry.cjs` → `ports.cjs`；`run-diagnosis.cjs` → `oneshot.cjs`）

- 证据：`src/lib/run-registry.cjs:23 require('../adapters/ports.cjs')`（默认 `adaptersFactory = createCcAdapters`）；`src/lib/run-diagnosis.cjs:6 require('../adapters/oneshot.cjs')`（无注入点）。
- 违反：地基依赖具体适配器实现；`run-diagnosis` 连注入口都没有，替换 adapter 必须改地基源码。
- 严重度：**中**。`run-registry` 同 F1 收敛；`run-diagnosis` 需补注入点。

### F3 · adapters 依赖 server（端口契约层依赖控制平面）

- 证据：`src/adapters/ports.cjs:21-22 require('../server/host.cjs')` / `require('../server/hook-adapter.cjs')`。
- 违反：`ports.cjs` 模块头自称「cc 的一切接入经 adapter 端口收敛」，但 7 端口中 host/hook 的**实现**住在 `src/server/`，契约层反向引用控制平面。
- 严重度：**高**（相对模块目标）。W3-004 的交付描述是「把 claude 的一切从 cli/server/plugin MCP/scripts 各处迁入 adapters/cc 的 7 端口实现」，实际只完成了契约声明与部分端口，tmux/会话原语仍在 server。

### F4 · cli 绕过边界直取 server 实现（`run.js` → `run-settings.cjs`）

- 证据：`src/cli/run.js:8 import { generateRunSettings } from '../server/run-settings.cjs'`（`:267` 调用）。
- 违反：cli 对 server 的既定形态是「经 client HTTP 提交」，对 cc 的既定形态是「经 adapters 端口」。`run-settings.cjs` 是 cc 格式产物（statusLine settings），却被 cli 直接 import —— 同时绕过 client 边界与端口边界。
- 严重度：**中**。与 T1-044「run 专用 settings 生成归 cc」的意图相左。

### F5 · claude / tmux 命令字面仍在 adapters 之外

- 证据（`grep -rn "'claude'|'tmux'" src scripts plugin`，排除 `src/adapters/`）：
  - `src/server/tmux.cjs:18` — `execFileSync('tmux', ...)`
  - `src/server/host.cjs:20` — `execFileSync('tmux', ...)`
  - `src/server/session-launch.cjs:32,51` — 直接 spawn/拼装 `claude` 命令
- 违反：纪律 R-cc「外部源码零 claude 命令字面」。
- 严重度：**高**（与 F3 同源，是其直接后果）。

### F6 · 插件 MCP 以计算路径回取 `src/`（「零导入」自述不成立）

- 证据：
  - `plugin/core/mcp/awf-state/server.cjs:21` — `require(path.join(__dirname, '..','..','..','..','src','lib','store-core.cjs'))`
  - `plugin/core/mcp/awf-oneshot/server.cjs:13` — 同形，指向 `src/adapters/oneshot.cjs`
- 两处都是 `try/catch` + 回退本地的**有意设计**（纯插件副本无 `src/` 时降级），注释也说明了用途（store-core 让 MCP 与 CLI/server 共用同一单写者实现）。
- 违反的不是「不该依赖」，而是**自述与事实不符**：`awf-oneshot/server.cjs:10` 写「claude 字面不在本 MCP」，而本地回退 `legacySpawnClaude` 正是 `_spawn('claude', ['-p', prompt])`（`:71`）；同文件 `:19` 的注释又承认「缺省（离线/单测）沿用本地 spawn」。两条注释互相打架，前者是规范表述、后者是实际行为。
- 取证提示：这类**计算路径 require 不会被字面导入扫描发现**——本轮首版扫描即漏掉它（首版结论「plugin MCP 对 src 零导入」是错的，已纠正）。凡声称「零导入」的边界，取证必须补扫 `path.join(__dirname, …)` 形式；`scripts/check-architecture.mjs` 已含此扫。
- 严重度：**低**（行为正确，是契约自述失真）。

### F7 · 端口契约的状态标记失真

- 证据：`src/adapters/ports.cjs:30-31` 把 `oneshot` / `tooling` 标为 `impl: false`；实际 `src/adapters/oneshot.cjs`、`src/adapters/tooling.cjs` 均已实现且在**生产路径**被调用（`src/server/server.cjs:27`、`src/cli/plugin.js:8`、`src/cli/init.js:7`、`src/lib/run-diagnosis.cjs:6`）。
- 违反：契约文件是后续任务的输入；失真会诱导重复实现。
- 严重度：**低**。

### F8 · 事件信封无版本字段

- 证据：`src/lib/events.cjs:54` 事件归一化形态 `{ type, at, runId, payload }` —— `EVENT_DEFS` 定义了类型、必需载荷键与 persist 锚点，但**没有版本**；`createEvent` 也不校验/携带版本。
- 消费方：persist-pipeline 落盘、api/WS 推送、web 前端（`web/` 是独立构建产物，经静态托管，存在与服务端版本错配的真实场景）。
- 违反：形状变更不可判定 → 前端只能靠「同时升级」的约定，无兼容读路径。
- 严重度：**中**（当前未爆，属设计缺口而非既有缺陷）。

## 四、处置

| 项 | 建议 |
|---|---|
| F1 / F2 | 收敛装配根：把 `run-registry` / `run-diagnosis` 的默认实现依赖改为调用方注入，lib 不再 require 上层。小步、行为不变，可独立审查。 |
| F3 / F5 | 把 host/hook 的实现从 `src/server/` 移入 `src/adapters/`（W3-004 未尽事项），server 只经端口消费。结构性改动，建议独立任务。 |
| F4 | `run-settings` 生成归 cc 端口，cli 经端口或经 client 取。 |
| F6 | 契约自述纠偏：`awf-oneshot/server.cjs:10` 的「claude 字面不在本 MCP」改为如实描述回退（低风险，可随下一次触及该文件的改动一并做）。「零导入」类自述今后须经补扫（含计算路径）后再写。 |
| F7 | `PORT_CONTRACT` 的 `impl` 标记纠偏（低风险，同上）。 |
| F8 | 事件信封加版本字段 + 消费方按版本判形状；是否引入兼容读由 T1-101 架构终稿定。 |

**本轮不修**：以上均为结构性变动，超出 T1-099（纪律文字化 + 对照取证）的范围；且 F3/F5 会改动 server/adapters 边界，宜作为独立任务连同测试一起做。本报告即为其输入。

> **附注（T3-009 门禁回写，2026-09-10）**：W3-009 模块门禁核验生产引用时发现，F1/F2 的 `run-registry.cjs` 与 F5 中的 `session-launch.cjs` **均无生产调用方**——它们是未接线的模块，反向依赖属**潜在**而非活违规。F5 的活违规收窄为 `src/server/tmux.cjs`、`src/server/host.cjs`、`scripts/bootstrap.sh`；`session-launch.cjs` 只是同一条纪律上的死代码。另 F1/F2 若随该模块删除而消失，则不必再做注入收敛。详见 `.awf/reports/test/w3-009-module-gate.md` §五 N-2。

> **结局（T3-009-F1 修复，2026-09-10）**：W3-009 门禁判 changes_requested，派生修复任务后已按「删除未采纳抽象」处置：
> `run-registry` / `session-launch` / `app` / `api` / `layout-migrate` / `persist-pipeline` 六个未接线模块连同各自测试删除
> （级联的 `migrate.cjs` 因仅被 `layout-migrate` 引用一并删除；`sid-naming.test.js` 三例全部依赖 `run-registry`，整体删除——
> live 的 cc-<sid> 命名由 `project-registry.test.js` / `run-context-project-sid.test.js` 覆盖）。
> 因此 **F1、F2 随 `run-registry` 删除而消失**；**F5 收窄为活违规 `src/server/tmux.cjs`、`src/server/host.cjs`、`scripts/bootstrap.sh`**
> （`session-launch` 那条已不存在）；**F7 已修**，并在 T1-116 进一步定型：`impl` 布尔标记换成 `status: 'factory' | 'not-landed'`，`not-landed` 强制带 `note` + `responsible`（加载即自检，缺了直接抛错）—— 未收口从「沉默的 false」变成「有原因、有责任人的登记」。
> 后续进展（T1-116 / T1-117）：**F2b 已清**（`run-diagnosis` 改为「oneshot 端口由装配根注入」，lib 不再依赖 adapters）；**F7 定型**（`impl` → `status: 'factory' | 'not-landed'` + 加载自检）；**ports 契约可信化**（声明方法必须真实存在、oneshot/tooling 入工厂、生产侧不再直连具体 adapter 文件，`ports.cjs` 的零引用豁免随之移除）。
> 仍开放：**F3**（host/hook 实现仍在 server/，待挪进 adapters）、**F4**（cli 直取 run-settings）、**F5 活违规**（session 收口）、**F6**（插件 MCP 回取 src 的降级路径要不要留）、**F8**（事件信封无版本）。四项结构债的豁免责任统一指向 **T1-113**（A/D 批次立项）。

## 五、对后续门禁的使用方式

**与既有模块门禁的关系**：`.awf/reports/test/w3-00X-module-gate.md` 是「模块 acceptance → 结构证据」表（其自述为「非真结构核查」），**不含架构纪律这一维**。本报告即补上该维度：§二 的模块 × 纪律矩阵可直接并入各模块门禁报告，作为架构结论列。

- 审查任务（`kind=review`）按 `code-review-architecture` 三条纪律逐条取证，结论进 `exec.verdict` 与 `exec.architecture`；未取证的纪律不得计入 pass。
- 开发任务在 `code-architecture` 完成检查处自查同一批三条，避免在门禁才暴露。
- 依赖方向证据用 `npm run check:arch` 出（输出越界边 + 逐条导入位置）；隔离与事件版本两条暂无脚本，按 §一 的判据手工取证。
- 本报告 F1–F8 在下一次触及相应文件的任务门禁中逐条复核是否已收敛。

## 附：本报告的一处自我纠正

首版扫描只匹配字面相对导入，据此得出「插件 MCP 对 `src/` 零导入」——**该结论是错的**。补扫计算路径 require 后发现两条回取边（F6）。已把该扫法并入 `scripts/check-architecture.mjs`，并把「计算路径引用是字面扫描死角」写入 `code-review-architecture` 的依赖单向检查项。留此记录是因为：**纪律取证本身也会出错，结论必须带可复现的取证方式**。
