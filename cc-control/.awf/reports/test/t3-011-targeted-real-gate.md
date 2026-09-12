# T3-011 真机回归门禁 — 改动面定向（2026-09-12）

**verdict: pass**（改动面口径）
**入口**：`npm run test:real -- --case single` / `--case dynamic-planning-run`（均**不带** `--port`）
**执行位置**：**在 run 内**（本任务即被 run 派发；常驻 server 复用，未重启）

---

## 一、本轮口径（为什么不是 `--case all`）

| 项 | 内容 |
|---|---|
| 全量在案 | `--case all` **已达成过一次**（2026-09-12，15 case / 204 断言全绿、exit 0，隔离模式 `--port 8799` 下）——本条 acceptance 只要求「有一次在案」 |
| 本轮改动面 | ① hook 网关失败留痕（`09b9e29`）② server 写类端点缺 `?p` 的 400 留痕（T1-110）③ 动态规划批准路径（闭包指纹 + 锁内重放）④ **回归 harness 删除隔离模式**（`4c89c40`） |
| 定向选择 | 改动面④决定了「不许再用 `--port`」→ 改跑不带 `--port` 的定向两条；②③落在 `dynamic-planning-run` 的真批准端点链上；①以及写类端点正向链落在 `single` 的 hook/写链上 |

**为什么不重跑 `--case all`**：`pause-release` 走 `ownServer`，会**按本项目**重启**共享** server
（其 2 条 `server.log` 归属断言依赖这次重启）。在 run 内跑等于杀掉在飞的 run。
`ownServer` 的护栏按 `?p` 过滤 `/run/status`，**看不到别的项目**的在飞 run —— 拦不住这种误用。
全量仍是「run 之外」的活动；本轮只跑不依赖重启 server 的两条定向 case。

## 二、执行结果

| case | 断言 | 结果 | 耗时/收敛 | 证据 |
|---|---|---|---|---|
| `single` | 6 | **6/6 ✔** | `settled.ok=true`，26.0s | `sandbox/regression/evidence-single.json` + `-summary.json` |
| `dynamic-planning-run` | 21 | **21/21 ✔** | `mode=idle`，4 任务全 done | `sandbox/regression/evidence-dynamic-planning-run.json` + `-summary.json` |

两条 **exit 0**。

`single` 逐条：run 收敛 / T1 done / `src/counter.js` 落盘 / mode 复位 idle / per-run 日志目录 / 会话 env 指向本项目。
`dynamic-planning-run` 逐条：AI 自发现缺口并发提案（harness 全程未调 `awf_dynamic_plan`）→ `requestedBy=ai`、
目标 T3 → hold 只覆盖 T3 不牵连 T1/T2、被 hold 任务不入就绪池 → **批准时 run 仍在飞**、批准前 T3 从未 active →
批准端点 `applied` → 同一 run 收敛、四任务全 done、`T3-PRE` 落在 T3 之前且 `startedAt` 更早、四份产物齐全 →
事件审计完整（`proposal.awaiting_approval` + `proposal.approved_and_applied`）。

## 三、改动面的第一手证据（不止「case 绿了」）

| 改动面 | 证据 |
|---|---|
| hook 网关失败留痕 | `sandbox/regression/single/.awf/logs/hook-gateway.log` 实测一行：`SessionStart → 已投递（端口 8787，CC_PROJECT=…/sandbox/regression/single）` —— 新留痕口在真 run 会话里落盘，且**投递本身带 `?p`**；`dynamic-planning-run` 同形 |
| 写类端点缺 `?p` 的 400 留痕 | 常驻 server（当前代码）`.awf/logs/server.log` 实测 `[hook] 拒绝写请求 POST /hook：缺 ?p` —— 新拒绝+留痕分支在跑；正向链（MCP `awf_task_complete` → server 写端点，带 `?p`）由 `single` 的 T1 落账证通 |
| 动态规划批准路径（闭包指纹 + 锁内重放） | `dynamic-planning-run` 的 21 条断言全落在该路径上（提案 → hold → 在飞批准 → 应用 → 同一 run 续跑），全绿 |
| harness 删除隔离模式 | 两条 case 均以 `CC_PORT=8787`（复用常驻 server）执行，证据 `sessionEnv` 可查，全程无 `--port`、无插件副本 |

## 四、前提与边界（必须随 verdict 读）

- **本次被测代码 = 当前工作树**（时点事实，已验证）：常驻 server pid 41842 启动于 **13:31:54**，
  晚于末次提交 `40d67df`（**13:31:49**）；工作树 `git status` 仅 `.awf/state.json`（运行态，非源码）。
  证据时间 13:33 / 13:36，均落在此窗口内。
- 该结论**不一般化**：此后任何源码改动即失效。本门禁**仍不宣称**「被测代码就是工作树最新那份」——
  run 内无法 `awf server stop`（会杀掉在飞 run），所以「跑前 `awf server stop`」这条前提在 run 内**无法执行**，
  只能用上述时点比对替代。
- 本门禁只声明它验到的范围：**两条定向 case**覆盖的链路（单 agent DEV 全链、hook 网关链、写类端点正向链、
  动态规划批准全链）在真机通过；**不等于**功能全绿。未覆盖项见 `docs/discuss/real-run-coverage-gaps.md` 缺口表
  （新增口径见 #20；`--case all` 当前应为 203 断言，**尚未跑过**，勿沿用 204）。

## 五、同步与遗留

- `docs/discuss/real-run-coverage-gaps.md` 已同步：表头状态、case 15 断言数 22→21（`40d67df` 删掉「server 已由本项目重启」）、
  全量口径 204→203（未跑）、#20 分档、纪律新增「case 要不要自起 server 看断言点」、新增改动面定向段。
- **未处置（不属本门禁）**：`ownServer` 护栏按项目过滤 → 拦不住「别的项目有在飞 run 时被误调」。
  当前只靠纪律（不依赖就别调它）。要不要改成全局判据，留给后续裁决。
- 上一轮（全量口径）判负时的 4 项 case 侧失败与 2 处产品侧观察，归属未变，见 `.awf/reports/test/t3-011-full-real-gate.md`。
