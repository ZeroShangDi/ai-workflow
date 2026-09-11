---
id: "001"
title: "plan/run 内嵌 cc 与普通 cc 无隔离：同一项目下互相污染"
status: open
labels: [bug, discussion]
assignee: null
milestone: null
priority: high
created: 2026-09-11
updated: 2026-09-11
deps: []
related: ["T1-110", "W3-006", "W3-007"]
---

# plan/run 内嵌 cc 与普通 cc 无隔离：同一项目下互相污染

**一句话**：`awf plan` / `awf run` 驱动的 cc，与同一目录下用户自己起的普通 cc，跑在**同一份项目级注册**
（`.claude/settings.json` 的插件 + 项目级 `.mcp.json`）上，双方共享运行态，没有任何隔离机制。
hook 串台是**已实证**的一个子问题；技能、命令、MCP 属同类。

**优先级**：high，但**不在 v0.2.0（W4-001）范围内** —— 架构级改动，须单独立项评审。

---

## 一、已实证的子问题：hook 串台（2026-09-10 事故）

### 机理

| 环节 | 事实 | 位置 |
|---|---|---|
| 端口烘死 | hook 命令是 `node gateway.cjs 8787`，端口在**渲染期**写死 | `plugin/core/hooks/hooks.json` |
| 注册面 = 项目级 | 插件在项目 `.claude/settings.json` 启用 → **该项目里任何会话**都触发这些 hook | `awf init` 注入 |
| 普通 cc 无身份 | 非 `bootstrap.sh` 起的会话没有 `CC_PROJECT` → `P_QS` 为空 → `POST /hook?...` **不带 `?p`** | `plugin/core/hooks/gateway.cjs:33` |
| 静默兜底 | 无 `?p` → `resolveCtx` 落到 **boot 项目**（= 起 server 的那个） | `src/server/project-context.cjs`（T1-110 已加写类守卫） |

### 事故因果链（时间戳可查）

w-monitor 会话 `97ead51c` 在 `cc-control` 目录启动（**非 bootstrap 起**），
其首次事件 `2026-09-10T15:06:08.466Z` 与 T1-108 报告里记录的
「`run-meta.json` 被重写，`startedAt=15:06:08Z`」**精确吻合**：

| 时刻 (Z) | 事件 |
|---|---|
| `15:06:08.466` | 路人会话的 `SessionStart` hook 无 `?p` → 落到 boot 项目 cc-control |
| —— | `server.cjs` SessionStart 分支：`resetRunLogs()` + `resetRunMeta()` + **`pcx.mainSessionId = body.session_id`**（主会话标识被顶掉） |
| `15:08:08` | 真会话的 `UserPromptSubmit` 因 `isMainSession()` 判否 → **`setBusy` 不再触发** → `pcx.state` 恒为 `ready` |
| —— | 宿主等待循环判据失效 → 2 分钟无变化窗口到期 → **过早进 `settleTask`**，收尾提示灌进正忙的会话 |
| `15:28:06` | 路人会话又一条无 `?p` 的 `curl /run/state/mode -d '{"mode":"pause"}'` → 宿主 settle 的 `send()` 卡在 `waitWhilePaused` → **静默停摆 4 小时** |

「T1-108 卡住」与「pause 冻死」是同一条链的两段，根因同一个：**无身份的请求走了兜底**。

### 已修部分

- `T1-110`：写类端点缺 `?p` → 400（不再兜底），并补齐两个 MCP 的写端点。
  详见 `.awf/bugs/write-endpoint-missing-p-fell-back-to-boot.md`。
- 但这只是把**错投**变成**丢弃**，没有回答「普通 cc 的这些行为本就不该发生」。

---

## 二、这一类问题的完整边界（不止 hook）

项目级注册的资产，普通 cc 同样能触发：

| 资产 | 位置 | 普通 cc 触发后的后果 |
|---|---|---|
| **hooks**（7 个） | `plugin/core/hooks/hooks.json` | 改 run 的会话状态 / 运行日志 / 主会话标识（**已实证**） |
| **slash commands** | `plugin/core/commands/`（`/w-start` `/w-pause` `/w-monitor` `/w-state`）、`plugin/plugin-code/commands/`（`/w-dev` `/w-plan` …） | 直接改运行态：`/w-pause` 暂停 run、`/w-dev` 抢跑任务 |
| **skills** | `awf-run-*`（运行态专属）、`awf-state`、`awf-plan-*`、`code-*` | 运行态 skill 在普通会话里被触发 → 按运行态假设行动 |
| **MCP servers** | `awf-state`(18 tools) / `awf-session`(5) / `awf-oneshot`(1)，经**项目级** `.mcp.json` 注册 | 普通 cc 可调 `awf_mode` / `awf_task_complete` 等写工具（本次事故的 pause 即此类入口） |
| **环境身份** | `CC_PROJECT` / `CC_SID` / `CC_AWF_STATE_SERVER` | 只有 run 会话有；普通 cc 一律缺失 → 各处只能靠兜底，而兜底就是污染源 |

**注**：`run-settings.json`（`.awf/run-settings.json`，经 `claude --settings` 注入）是**run 专属**的，
不污染用户会话 —— 这条路已经被证明可行（statusLine 等）。隔离的答案可能就在这里。

---

## 三、根因抽象

> run 会话与普通 cc 共享**同一份项目级注册**，却只有 run 会话有**身份**。

- **有身份**（`CC_PROJECT` / `CC_SID`）→ 路由正确。
- **无身份** → 走兜底 → 落到 boot 项目、落到运行态。

所以缺的不是「某个端点的 `?p` 校验」，而是**「身份」这一层**：
普通 cc 不应被当作「没带 `?p` 的 run」，而应被明确识别为**非 run 会话，不参与运行态**。

反过来同样成立：run 会话也不该被普通 cc 干扰 —— 这是双向隔离。

---

## 四、候选方案讨论（待评审，非结论）

### 4.1 方案 A：运行身份令牌（capability token）— 主推

**思路**：`awf plan` / `awf run` 启动时生成一枚随机令牌，随环境注入它拉起的会话；
所有运行态入口（hook 网关、三个 MCP、CLI）带上令牌，server 校验不过 → **拒绝，不兜底**。

#### 为什么不记 sid，而记令牌

**（a）启动时拿不到 sid。** sid 由 Claude Code 生成，是**第一个 `SessionStart` hook** 才带上来的。
`bootstrap.sh` 拉起 claude 的那一刻，CLI 与 server 都不知道它是什么。所以「启动时把产生的 sid 记进许可」
在时序上做不到，只能退化成「首个声明者认领」—— 而首个认领**有竞态**：bootstrap 到 run 会话发第一个 hook
之间的窗口里，任何在项目里起的 cc 都能抢（或像 §一 那样直接覆盖）。

**（b）sid 会变。** 上下文压缩走 `/clear`（`task-channel.maybeCompactContext` → `clearSession()`），
之后 `SessionStart` 会再发一次；而 `server.cjs` 现在的分支就是
`if (body.session_id !== pcx.mainSessionId) { resetRunLogs(); resetRunMeta(); }`
—— **代码自己预期 sid 会变**。纯 sid 白名单会在第一次压缩后把 run 自己锁在门外。

> **待实测确认**：`/clear` 是否换 sid、`SessionStart` payload 的 `source` 字段取值。
> 仓库里查不到证据 —— 本项目的 run 上下文占用一直在 36~44%，从未到 80% 阈值，**压缩一次都没真跑过**。

**结论**：sid 降级为令牌的**附属信息**（用于日志 / 展示 / 路由），不再是身份本身；
`/clear`、`--resume`、`--attach` 换 sid 都不影响身份连续性。

#### 两个必须一并处理的坑

| # | 坑 | 说明 |
|---|---|---|
| 1 | **w-monitor 会被误伤** | 它按设计就是「非 run 会话，但要能操作 run」（读 state / pause / intervene）。纯「只有 bootstrap 起的会话才算数」会把监控一起挡掉 → 需要**显式授权通道**（带令牌启动，或令牌落 `.awf/` 由监控读取）。**这是策略决策，不是纯技术问题。** |
| 2 | **`awf plan` 没有 server** | 已核实 `src/cli/plan.js` 零 server 引用（CLAUDE.md 亦载「plan（无 server）离线直写」）。令牌不能只活在 server 内存，须落 `.awf/` 下的身份文件，plan / run 共用同一套。 |

#### 覆盖边界

| | |
|---|---|
| ✅ 挡得住 | hook 串台、MCP 写工具被外部会话调用、`awf_mode` 被误调 —— 即**服务端写面** |
| ⚠️ 挡不住 | 普通 cc 仍能跑 `/w-dev` **改文件**（只是写不进 state）→ 需命令 / skill 层再守一道（**本方案暂不覆盖，见 4.2**） |
| ⚠️ 挡不住 | 同用户进程读令牌（`ps -E` 等）。本地开发工具的威胁模型下可接受 |

#### 与现状的衔接

这条链路**已经建了一半**：

| 环节 | 状态 |
|---|---|
| 透传端 | ✅ 在（`gateway.cjs` 的 `SID_QS` / 两个 MCP 的 `sessionQuery()`） |
| 路由端 | ✅ 在（`server.cjs` 的 `handleSidHook` / `runSlotFor`） |
| **注入端** | ❌ **live 路径上没接** —— `run.js:252` 明确注释不注入 `CC_SID`；本该注入的载体 `session-launch.cjs`（`buildSessionEnv`）是零生产引用的死模块，已被 T3-009-F1 删除 |

即：不是从零开始，是**把 W3-006 那条半截链路按「令牌」语义重新接上**。

### 4.2 其余方向（本轮不展开）

| # | 方向 | 状态 |
|---|---|---|
| 1 | **注册面隔离**：run 专属 hooks / MCP 不进项目级注册，改走 run-session 专属 settings | 保留候选。`run-settings.json` 经 `claude --settings` 注入已被证明可行（statusLine），是现成范式 |
| 2 | **兜底语义清理**：boot 兜底只保留给只读探活（`GET /status`） | 已被 T1-110 部分落实（写类端点点缺 `?p` → 400） |
| 3 | **命令与技能的运行态守卫**：`awf-run-*` / `/w-dev` 等在普通会话里应报错或引导 | **用户明确：到时再说，本方案暂不覆盖。** 仅在此登记 |

---

## 五、验收

**本轮（方案 A，hook + MCP 写面）**

- 同一项目下，普通 cc 触发的 hook 与 MCP 写调用**都不会改变** run 的 `state.json`、
  会话状态、运行日志。
- run 会话的行为**不受**普通 cc 影响。
- 真机回归 case 覆盖：同一项目 + 一个普通 cc 并行 + 一个 run。
- w-monitor 的授权通道有明确策略且可用（见 4.1 坑 1）。

**完整目标（含命令 / 技能，待到时展开）**

- 普通 cc 的任何行为（hook / 命令 / skill / MCP 调用）都不得改变 run 的任何运行态。

---

## 六、关联

- 已修子问题：`.awf/bugs/write-endpoint-missing-p-fell-back-to-boot.md`（T1-110）
- **W3-006 门禁（T3-006）的「遗留 1」从未被任何任务承接**：
  「curl 类 hook 事件未带 `&sid`、每 run `CC_SID` 未注入 → 多 run boot 接线（T1-098 双 run 前完成）」。
  T1-098 已 done，该遗留落空 —— 属同一类「有据可查的『待接入』变成永不接入」，
  与 T3-009 门禁报的 N-2 同源。
- 承接载体 `src/server/session-launch.cjs`（`buildSessionEnv` 会注入 `CC_SID`）本身就是零生产引用的
  死模块，已被 T3-009-F1 删除 —— 「将来接线」的载体从没接上，现在也没了。
