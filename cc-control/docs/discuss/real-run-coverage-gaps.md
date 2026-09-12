# 真机回归的两种粒度 + 覆盖缺口清单

> ⚠️ **本文的缺口清单口径已被 `real-run-suite-merge.md` 修正**（2026-09-10）：
> 起草时只读了 `tests/regression/`，**没读 `tests/eval/`** —— 而 eval 另有 9 个声明式 case，
> 门禁失败闭环（`review-gate-closure`）、多 agent 并发调度（`multi-agent-parallel`）、决策上抛
> （`needs-input-*`）等都在里面。两套体系的来历、差异与合并方案见 `real-run-suite-merge.md`（仍是讨论稿，未落地）；
> 本文的「两种粒度」设计仍成立，且**本文只描述 `tests/regression/` 这一套**的矩阵。

> 2026-09-11 · 状态：**15 个 case 在册**（T3-011 全量门禁同步 + 动态规划两个 case）
> 载体：`tests/regression/fullflow-regression.mjs`（`npm run test:real`）

## 目标形态（用户裁定）

| 粒度 | 入口 | 用途 |
|---|---|---|
| **全量** | `npm run test:real -- --case all` | 跑全部注册 case —— **最终验收**，作为收尾门禁 |
| **定向** | `npm run test:real -- --case <name>` | 单场景/单功能 —— 开发期快速验证某块能力 |

两者共用同一 case 注册表（`const CASES`）：加一个功能就加一个 case，全量自动带上。
产物统一落 `sandbox/regression/`（gitignore 产物区），证据 `evidence-<case>.json`（全量另出 `evidence-all.json`）。

## 现状：15 个 case（截至 2026-09-11）

| # | case | 断言数 | 验到的 |
|---|---|---|---|
| 1 | `single` | 6 | 单 agent：派发 → DEV 自落账 → run 收敛 → mode 复位 → per-run 日志 → 会话 env 归属 |
| 2 | `gate` | 6 | 门禁任务（kind=review）落账 + `exec.verdict.level` 存在；无残留 pending；门禁**不误派生**修复 |
| 3 | `multi` | 4 | `--multi-agent` 入口跑通：收敛 / 任务 done / 真实产出 / env 归属 |
| 4 | `decision` | 9 | 决策闸门：标记触发 → DC 自决 → DecisionStore 落盘（非兜底）→ per-run runStamp → 续跑注入 → 收敛 |
| 5 | `dual` | 15 | 同机双项目并发：两 tmux 会话并存且名互异、state 不串写、per-run 日志目录互异、env 不串 |
| 6 | `resume` | 14 | 重连：宿主空闲时 `--attach` 报错且**不清场**；CLI 被 SIGKILL 后挂接在飞 run 续观至完成 |
| 7 | `pause` | 19 | 暂停闩锁：未暂停时 `/intervene` 409；暂停期间只挡派发不打断在飞任务；**宿主侧**超阈值告警落盘（自起 server 注入 `CC_PAUSE_ALERT_MS`）；介入 / interrupt；恢复后释放 |
| 8 | `recover` | 15 | 中断现场：tmux/server/state 三者保留、mode 不复位、编排不依赖 CLI 存活、`--resume` 接手收尾 |
| 9 | `pause-release` | 18 | 暂停期间目标结算即放行（不等 mode 恢复），且不放松派发闩锁；放行原因与阶段落进运行日志 + **本项目自有** `server.log`（自起 server） |
| 10 | `init` | 14 | `awf init` 产出：三插件注册/enabled、项目级 `.mcp.json`（绝对路径 + AWF_PROJECT_ROOT）、骨架目录、幂等 |
| 11 | `mcp` | 10 | MCP 工具面：三 server 各做 initialize + tools/list，工具数与必含工具齐全 |
| 12 | `lifecycle` | 6 | 常驻 server 空闲回收：探活期间不回收 → 静置后进程退出 + 端口关闭 + 日志留痕 |
| 13 | `web` | 15 | 前端：页面由构建产物承载（或未构建 503+告警）、`/assets` 托管、旧资产 404、`?p` 取数不串、决策 override 落盘 |
| 14 | `dynamic-planning` | 31 | 动态规划的**跨进程边界**（真 server + 真 awf-state MCP，不起 tmux/claude）：经 MCP JSON-RPC 提案 → proposal 落盘 + `events.jsonl` 追加 + hold 装进 state → 调度器就绪池（`state.js` 判据）排除被 hold 任务 → 第二个开放 proposal 被拒 → 人工 HTTP 批准应用（新任务先于目标、依赖重连、hold 释放、MCP 读回新图）→ **无关变化放行 / 相关变化判 `conflicted`** → 人工拒绝释放 hold → 非 server 模式拒绝本工具 |
| 15 | `dynamic-planning-run` | 22 | 动态规划的**运行链路（全真）**（真 tmux + 真 Claude，**一次 run 走到底**）：T1 的 prompt 只给策略不给缺口位置，AI 自己从 state 找出「T3 要 `src/adder.js` 而无人产出它」→ 经 MCP 发起提案 → hold 只挡目标、不牵连在跑的任务 → 人工在 **run 进行中**批准（批准时 `/run/status` 仍有活跃 run、目标从未 active）→ **同一个 run** 继续跑完，新任务 `startedAt` 早于目标，四个任务全部 done、产物齐全 |

合计 **204 断言**（13 case 的 151 + `dynamic-planning` 的 31 + `dynamic-planning-run` 的 22；T3-011-F1 修复后 151/151 全绿，exit 0，2026-09-11；
修复前同一命令为 145–146/150，5 项失败全部归因 case 侧 —— 见 `.awf/reports/test/t3-011-full-real-gate.md`）。
两个动态规划 case 定向实测 **31/31 与 22/22**（各自复跑同结论，`--port` 隔离模式亦同），2026-09-11。
**2026-09-12 全量连跑**（`npm run test:real -- --case all --port 8799`）：**204/204 全绿、exit 0**，
15 个 case 一轮 10 分钟，两个新 case 在连跑里同结论 —— 连跑与单跑一致（本文档纪律要求的正是这一条）。

## 覆盖缺口（T3-011 复核后的真实状态）

| # | 场景 | 现状 | 归属 |
|---|---|---|---|
| 1 | **`awf plan` 全链路** | ❌ 零覆盖（harness 直接喂同构 state.json 进 run 半段） | **暂不做**（用户 2026-09-10 裁定；交互式入口，自动化需 tmux 应答器） |
| 2 | **门禁闭环失败分支**（fail → 派生修复 → 复审 → pass/上限） | ⚠️ regression 只验「不误派生」；真闭环在 `tests/eval/` 的 `review-gate-closure` | 合并方案落地时去重归并 |
| 3 | **多 agent 真并发调度**（配额/plannedFiles 冲突/独占/补位） | ⚠️ regression 只验入口跑通；调度面在 `tests/eval/multi-agent-parallel` | 同上 |
| 4 | **收尾协商**（wrapup → 3 轮追问 → blocked） | ❌ 仅 mock（`task-channel-settle` 单测） | 后续 case |
| 5 | **上下文压缩**（context-check → 快照 → `/clear` 注入） | ❌ | 后续 case |
| 6 | `--resume` / `--attach` 重连 | ✅ `resume`（T1-108） | — |
| 7 | pause / w-monitor 介入 | ✅ `pause` + `pause-release`（T1-108 / T1-111） | — |
| 8 | 中断恢复 | ✅ `recover`（T1-108） | — |
| 9 | 前端四视图 + 项目切换 + 决策 override | ✅ `web`（T1-109；`.jsx` 组件本身仍不在 vitest 范围） | — |
| 10 | 常驻 server 空闲回收 / 生命周期 | ✅ `lifecycle`（T1-109） | — |
| 11 | `awf init` 产出正确性 | ✅ `init`（T1-109）；幂等断言口径已修（**T3-011-F1**：改为「连续两次 init 输出不变」，不再与 `--port` 的 marketplace 重指结果比字节） | — |
| 12 | MCP 工具面 | ✅ `mcp`（T1-109） | — |
| 13 | **写类端点缺 `?p` 拒绝**（T1-110） | ❌ 真机无 case（仅 `tests/integration/write-requires-project.test.js`） | 后续 case |
| 14 | **server 日志可观测**（T1-112） | ⚠️ 测试侧已收口（**T3-011-F1**：需要 `server.log` 的 case 自起 server）；**产品侧缺口仍在** —— 复用场景下后挂项目拿不到自己的 `server.log` | `.awf/issues/005`（建议并入 T1-113 的 A 组） |
| 15 | commit 流程 / `w-doc` 文档生成 | ❌ | 后续 |
| 16 | 异常路径（server 挂 / tmux 丢 / hook 失败） | ❌ | 后续 |
| 17 | **case 间独立性**（全量连跑 vs 单跑结论一致） | ✅ **T3-011-F1 已收口**：case 需要什么就自起什么（`ownServer(projectRoot, extraEnv)` —— 自起 server 并把**宿主侧** env 一并注入），不再依赖「server 由首个 case 唤起后复用」的隐含前提；本轮全量连跑 151/151 为证 | — |
| 18 | **per-run 日志目录偶发缺失** | ⚠️ `decision` 曾在连跑中间歇失败（`DecisionStore` 的 runStamp 派生回退）。**机制未定位**；测试侧已加现场取证（缺目录时 dump `state.json` 可读性 / `logs` 清单 / 决策 stamps 进证据 + 打 `[诊断]` 行） | 根因在 `RunLogger._init` 静默早退 → `.awf/issues/005` |
| 19 | **运行中动态任务规划**（AI 提案 → 人工批准前 hold → 批准 → 新任务先于目标执行） | ✅ **两半都覆盖**：边界半段见 `dynamic-planning`（真 MCP → 真 server → proposal/事件/hold 落盘 → 批准才应用）；运行半段见 `dynamic-planning-run`（AI 自发现缺口、人在飞批准、同一 run 前置先于目标执行）。另有同源 eval 用例 `tests/eval/cases/dynamic-planning/` | 能力文档 §9 两个 case 均已落地 |

## 纪律

- **全量门禁只声明它验到的范围**：`--case all` 全绿 = 「已注册 case 覆盖的链路在真机通过」，
  **不等于**「功能全绿」。缺口清单（本文档）是它的边界声明。
- 加功能 → 加 case → 本文档矩阵同步更新（并入全量门禁任务的验收）。
- 小 case 要独立可跑、可重复、自带沙箱隔离（不依赖其他 case 的残留）。
  **这条纪律如今有了机器化写法**（T3-011-F1）：case 需要什么就自起什么 —— 需要 `server.log` 或需要
  宿主侧阈值生效，就 `ownServer(projectRoot, extraEnv)` 起自己的 server，而不是依赖「首个 case 唤起后被复用」。
  连跑与单跑结论一致由全量门禁兜住（`--case all` 与 `--case <name>` 必须同结论）。
