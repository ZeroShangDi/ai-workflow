---
id: "004"
title: "声明与实现不符清单（T1-100 文档核对中查出，待处置）"
status: open
labels: [bug, tooling]
assignee: null
milestone: null
priority: medium
created: 2026-09-11
updated: 2026-09-11
deps: []
related: ["T1-100", "T1-106", "T3-009", "003"]
---

# 声明与实现不符清单（T1-100 文档核对中查出，待处置）

T1-100 逐份核对功能文档与代码时，查出以下「对外声明 / 接口 / 注释」与实际实现不符的项。
**均已逐条复核**（附复现命令与 `文件:行号`），但**本任务只写文档、不改代码**，故在此登记。
其中第 1–3 条是**行为面**（有实际后果），第 4 条是**注释面**（误导读者，无运行时后果）。

---

## 1. `run-client` 的 `limit` 参数被服务端静默丢弃

- **声明**：`src/cli/run-client.js:134,137` —— `pollRunEvents({ runId, afterSeq, limit })` 会把 `limit` 拼进查询串。
- **实际**：`src/server/server.cjs:1290-1294` 构造 `q` 时**只带 `afterSeq` 与 `runId`**，`limit` 从未转发；
  而 `src/server/run-host.cjs:438` 是支持它的（`const limit = q.limit || 200`）。
- **后果**：调用方以为能控制单次拉取条数，实际恒为 200；属"静默忽略参数"（与本项目"把沉默变成会响的东西"的口径相反）。
- **修法**（二选一，都很小）：路由补 `limit: Number(url.searchParams.get('limit'))` 转发；或删掉 `run-client` 侧拼 `limit` 的分支并在注释里写明上限固定。

## 2. `run-slot.setContextReady` 是死函数，`GET /status?sid` 的 `contextReady` 恒为 `false`

- **复现**：`grep -rn "setContextReady" src/` → 仅 `src/server/run-slot.cjs:52`（定义）与 `:82`（导出），**无任何调用点**。
- **后果**：按 `sid` 查询的槽位快照里 `contextReady` 是一个**永假值**；任何据此判断"上下文快照已就绪"的消费方都会得到恒定否。
  项目级标记走的是另一条路（`pcx.contextReady`，经 `/context-ready`），两者同名不同物，容易误判。
- **修法**：要么把上下文压缩的置位同步到槽位，要么从槽位快照里摘掉该字段（宁缺勿假）。

## 3. `awf run` 声明了 `--auto` / `--local`，但实现里完全不消费

- **复现**：`src/awf.js:34,38` 声明 `-a, --auto`（"全自动模式，不暂停等待确认"）与 `-l, --local`（"使用本地提示词模板"）；
  `grep -n "options.auto\|options.local" src/cli/run.js` → **零命中**。
- **后果**：用户传了没反应，且帮助文本承诺了不存在的行为。（`--local` 的语义在 v0.2.0 后已由"插件声明提示词模板"取代。）
- **修法**：要么接线，要么从 `awf.js` 摘掉这两个选项（含帮助文本）。

## 4. 陈旧代码注释（自述与实现不符，无运行时后果）

| 位置 | 注释说的 | 实际 |
|---|---|---|
| `src/server/static.cjs` 文件头 | "承载 legacy html、迁移后退役、`defaultAliases()`" | legacy 页已随 T1-119 删除；别名表只剩 `'/'`，由调用方显式给出 |
| `plugin/core/hooks/gateway.cjs` 文件头 | "普通事件继续用裸 curl" | `plugin/core/hooks/hooks.json` 里 **7 个 hook 全部**是 `node …/gateway.cjs <port>` |
| `plugin/core/mcp/awf-oneshot/server.cjs:10` | "claude 字面不在本 MCP" | 同文件 `:74` 的降级路径就是 `_spawn('claude', ['-p', …])`（审计 F6 已记，此处补全证据） |
| `src/adapters/ports.cjs` 文件头 | "外部源码零 claude 命令字面（纪律 R-cc）" | 这是**目标**而非现状：`server/tmux.cjs:18`、`server/host.cjs:20`、`scripts/bootstrap.sh` 仍有字面（审计 F3/F5，责任 T1-113） |

前两条是**新查出**的；后两条是审计既有条目的证据补全。归口：低风险，"随下次触及该文件一并做"。

---

## 5. 项目指令文件 `CLAUDE.md` 的工具表与实际不符（T1-102 核对时查出）

`CLAUDE.md` 是每个 AI 会话都会读的指令文件，其漂移的影响面比普通文档大。

| 位置 | 写的 | 实际 |
|---|---|---|
| `CLAUDE.md` §MCP Tools | `awf-session（5 tools）` | **7 个**（真机 `mcp` case 断言「工具数 ≥ 5」实测 7） |
| 同表 | 列出 `awf_await_choice` / `awf_await_input` 为可用工具 | 该文件**自身**第 362 行又写「这两个入口已停用，不要再用」——**自相矛盾** |
| 同表 | 未列 `awf_session_intervene` / `awf_session_interrupt` | 这两个是 w-monitor 的介入工具，在册且被使用 |
| `CLAUDE.md` §常用命令 | `npm run eval` 注释为「AI 质量评测（**占位**）」 | `tests/eval/` 有 **9 个可运行 case**（`npm run eval -- --list` 实测列出），已在承担门禁失败闭环 / 多 agent 并发调度等核心回归 |

**修法**：`awf-session` 计数改 7、补两个介入工具、给两个 await 工具加「已停用」标注；`eval` 的「占位」改为如实描述（并指向 `tests/eval/README.md` 与合并方案 `docs/discuss/real-run-suite-merge.md`）。

**注**：`CLAUDE.md` 位于仓库根，不属 T1-100/T1-102 的 `docs/` 范围；此处登记为待办。

---

## 不在本清单（已有归属，避免重复登记）

- **旧决策入口的代码面仍在**：`/choice`、`/ask`、`/respond` 端点与 `awf_await_choice` / `awf_await_input` 两个 MCP 工具仍注册、仍在被调用，
  而技能与提示词已标注"已停用" —— 属 **T1-106**（用户 2026-09-10 裁定暂缓）的已知落差，不在此重复。
- **`src/lib/version.js` 生产侧零引用**（调用点被注释） —— 见 `003-comment-import-counted-as-reference.md`（该 issue 同时登记了门禁漏检的根因）。
