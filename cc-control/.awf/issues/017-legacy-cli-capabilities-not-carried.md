---
id: "017"
title: "旧 CLI 未搬能力清单：TTY 表现层 / auto 路由多选 / 版本选择器"
status: open
labels: [cli, ui, tech-debt]
assignee: null
milestone: null
priority: medium
created: 2026-09-14
updated: 2026-09-14
deps: []
related: ["014", "015"]
---

# 旧 CLI 未搬能力清单

**一句话**：旧树 `src/` 退役时有三处能力**没有**随迁（两处是有意不搬、一处是漏搬），
对应的测试文件随之删除。留此清单，免得「当时为什么没搬」以后没人知道。

## 一、终端表现层 `src/lib/ui/*`（**有意不搬**，用户裁定）

colors / log（step/成功/失败格式化）/ spinner / task-list / run-follow（run 实时跟随原地重绘）。
新 CLI 走朴素 `console.log`（`cli/commands/run.cjs` 内有 `renderEvent` / `taskLine` 雏形）。

**边界（用户裁定）**：**内容由 server 提供，CLI 侧只负责输出与 UI。**
即这一层要做也是「server 给出结构化内容 → CLI 渲染」，不是让 CLI 自己算。

对应删除的测试：`run-follow.test.js`、`task-list.test.js`。

## 二、`auto` 路由的多选应答（**漏搬**，待定）

`cli/lib/decision.cjs` 的 `auto` 分支把应答值**硬编码为 `'1'`**（注释：「与旧 CLI 一致：auto 路由
发序号」）。但旧 CLI 的 `autoSelect` 对**多选**问题会返回 `{ multiSelect: true, selected: [...] }`
—— 即多选场景下的 auto 应答语义在新树**没有实现**（发 `'1'` 是否被前端/服务端正确处理，未验证）。

对应删除的测试：`auto-selector.test.js`（其中 auto 单选 + 5s 倒计时已由
`tests/unit/decision-routing.test.js` 覆盖；多选与「无 options」两条随本项一起挂起）。

**待定**：确认多选 AskUserQuestion 在 auto 路由下应该发什么（序号？索引数组？），再决定补齐还是正式不支。

## 三、交互式版本选择器 `src/lib/version.js`（**能力已停用**）

`setupVersion` / `promptVersion`（`@inquirer/prompts`）。两处调用点
（旧 `src/cli/init.js:5`、`src/cli/plan.js:2`）早已注释为「版本处理暂时禁用」，根因是交互式 prompt
会把以 `stdio: pipe` 跑的自动化入口挂住。新 CLI 不写版本，版本号由 package.json / state.json 承载。

对应删除的测试：`version-prompt.test.js`。撤销时机：产品决定给出非交互入口（如 `--version`）
或正式废弃该功能。

## 四、决策续跑注入：`decisionResume` **无消费者**（存疑，待查）

旧 CLI 的续跑是「轮询 `decisionResume` → 探测到就注入续跑消息 → 再等待」（`drainDecisionResume`，
4 条用例：单轮 / 多轮 / gate off 零注入 / 注入失败停止）。

新树里 `handler.cjs:45` 的注释声称「续跑位（decisionResume）只是待消费的答复……真正注入由 **run 域**
在就绪时读取」，但 `grep -rn consumeDecisionResume server/ cli/` **除 `runtime/session.cjs` 自身外零命中**
—— 没有 run 域读取点。

人答那条路径不受影响：`/respond` 走 `submitRaw(value)` **直接注入**会话（不是经 decisionResume）。
存疑的是 **DC 自决**那条（`persist` 置 `decisionResume` + 推 `decision.record`）：谁把它变成会话里的
一句话？未验证。

对应删除的测试：`run-resume.test.js`（被测函数 `drainDecisionResume` 已不存在）。

**待查**：DC 自决之后 run 靠什么继续 —— 若确实无人消费 `decisionResume`，则要么补消费者，
要么把该字段与注释一并删掉（只写能取证的）。

---

## 附：这两处「不是删而是被别处覆盖」的测试

| 删除的文件 | 覆盖它的新树测试 |
|---|---|
| `run-slot.test.js` | `tests/unit/server-layering.test.js`（每 sid 一个独立会话槽 / reset 收干净） |
| `tmux.test.js` | `tests/unit/host.test.js`（hasSession / sendText / sendEnter / sendCtrlC / capture 的 args）+ `run-context` 各测（会话名派生） |
| `run.e2e.test.js` | 它驱动的是**旧 CLI 主循环**（`src/cli/run.js` 的 runCommand），该编排已整体归宿主：单/多 agent 循环 → `tests/integration/run-host.test.js` + `batch-host`；收尾协商（wrapup → 追问 → blocked）→ `tests/unit/task-channel-settle.test.js`；新 CLI 薄入口 → `tests/unit/run.test.js` |
| `run-resume.test.js` | 见 §四 —— 它测的 `drainDecisionResume` 已不存在；`consumeDecisionResume` 的一次性消费由 server-layering 覆盖，但**注入**那半待查 |
