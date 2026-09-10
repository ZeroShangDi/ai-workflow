# 真机回归的两种粒度 + 覆盖缺口清单

> 2026-09-10 · 状态：**待补齐**（框架已具雏形，case 远未覆盖功能面）
> 载体：`tests/regression/fullflow-regression.mjs`（`npm run test:real`）

## 目标形态（用户裁定）

| 粒度 | 入口 | 用途 |
|---|---|---|
| **全量** | `npm run test:real -- --case all` | 跑全部注册 case —— **最终验收**，作为收尾门禁 |
| **定向** | `npm run test:real -- --case <name>` | 单场景/单功能 —— 开发期快速验证某块能力 |

两者共用同一 case 注册表（`const CASES = {...}`）：加一个功能就加一个 case，全量自动带上。
产物统一落 `sandbox/regression/`（gitignore 产物区），证据 `evidence-<case>.json`。

## 现状：5 个 case，覆盖主链路

| case | 验到的 | 没验到的 |
|---|---|---|
| `single` | 单 agent 派发→落账→收敛→mode 复位→per-run 日志→会话 env 归属 | — |
| `gate` | 门禁任务落账 + `verdict.level` **存在** | **失败分支**（派生修复→回退复审→重跑）整个闭环 |
| `multi` | 多 agent 入口能跑通 | **调度**：只喂 1 个任务，滑动窗口/配额/plannedFiles 冲突/独占全未触发 |
| `decision` | 门阀：标记触发→DC 自决→落盘→per-run runStamp→续跑注入 | override / review 纠偏；决策与收尾协商的交互 |
| `dual` | 多项目隔离：会话并存互异/state 不串/日志互异/env 不串 | — |

## 覆盖缺口（按风险排序）

| # | 场景 | 现状 | 归属任务 |
|---|---|---|---|
| 1 | **`awf plan` 全链路**（需求归一→WBS→任务生成→门禁插入） | ❌ 零覆盖（harness 直接喂同构 state.json 进 run 半段） | **暂不做**（用户 2026-09-10 裁定：暂时不测 plan）。原因：plan 是交互式入口（`plan.js` 46 行，直接 spawn `claude` + stdio inherit；交互全在会话内，`state.json` 只在最后一次性落盘），自动化需要「tmux + 自动应答器」，成本高且脆 |
| 2 | **门禁闭环失败分支**（fail→派生修复→复审→pass/上限） | ❌ | T1-107 |
| 3 | **多 agent 真并发调度**（配额/冲突/独占/补位） | ❌（仅单测） | T1-107 |
| 4 | **收尾协商**（wrapup→3 轮追问→blocked） | ❌（仅 mock） | T1-107 |
| 5 | **上下文压缩**（context-check→快照→/clear 注入） | ❌ | T1-107 |
| 6 | **`--resume` / `--attach` 重连** | ❌ | T1-108 |
| 7 | **pause / w-monitor 介入**（`/intervene`、编排闩锁） | ❌ | T1-108 |
| 8 | **中断恢复**（run 崩→现场保留→续接） | ❌ | T1-108 |
| 9 | **前端四视图 + 项目切换 + 决策 override 页** | ❌ 真机无（仅模型层单测） | T1-109 |
| 10 | **常驻 server 空闲回收 / 生命周期** | ❌ | T1-109 |
| 11 | **`awf init` 产出正确性**（settings 注入 / .mcp.json / 插件注册） | ⚠️ 只当准备步骤跑了 | T1-109 |
| 12 | **MCP 工具面**（state 18 / session 5 / oneshot 1） | ⚠️ 真链路只间接碰 `awf_task_complete` | T1-109 |
| 13 | **commit 流程 / w-doc 文档生成** | ❌ | 后续 |
| 14 | **异常路径**（server 挂 / tmux 丢 / hook 失败） | ❌ | 后续 |

## 纪律

- **全量门禁只声明它验到的范围**：`--case all` 全绿 = 「已注册 case 覆盖的链路在真机通过」，
  **不等于**「功能全绿」。缺口清单（本文档）是它的边界声明。
- 加功能 → 加 case → 本文档矩阵同步更新（并入全量门禁任务的验收）。
- 小 case 要独立可跑、可重复、自带沙箱隔离（不依赖其他 case 的残留）。
