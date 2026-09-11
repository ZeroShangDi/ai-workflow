# 决策闸门 v0.2.0（ai-workflow-decision）— 测试用例文档

> 对应功能文档：docs/features/decision-system.md
> 源码：`src/server/server.cjs` / `src/server/decision*.cjs` / `src/cli/run.js` / `src/lib/{run-config,decision-config}.js/.cjs` / `plugin/core/hooks/gateway.cjs` / `plugin/decision/`
> 测试文件：`tests/integration/decision-gate.test.js` / `tests/unit/{run-config,decision-config,decision,decision-instruction,decision-store,gateway,run-resume,run-logger}.test.js` / `sandbox/decision-smoke/smoke.cjs`
> 用例编号与验收标准（T1-028 功能文档「验收标准」7 条）可追溯
>
> **决策入口换代**：旧入口 `awf_await_choice` / `awf_await_input` 已于 2026-09-10 在资产层停用（`awf-run-decision` 技能标注 + 提示词改输出 `<AWF_DECISION_REQUIRED>`）；本文件只覆盖决策门阀（新代）。停用说明见 `plugin/core/skills/awf-run-decision/SKILL.md`、`docs/bugs/decision-entry-two-generations.md`（T1-106，互斥化 pending）。

## 测试场景总览

| # | 场景 | 类别 | 验收标准 | 落地测试文件 |
|---|------|------|---------|------------|
| 1 | 开关加载：缺省 / 显式 true/false / 非法回落 | 单元 | 验收 1 | `tests/unit/run-config.test.js` `decision-config.test.js` |
| 2 | server helper 与 CLI 同源防漂移 | 单元 | 验收 1 | `tests/unit/decision-config.test.js` |
| 3 | 文字入口闸门触发（gate on） | 集成 | 验收 2 | `tests/integration/decision-gate.test.js` |
| 4 | AskUserQuestion 入口转 DC（gate on） | 集成 | 验收 2 | 同上 |
| 5 | 普通完成不触发 gate | 集成 | 验收 3 | 同上 |
| 6 | deny 一次 / 防递归 / 幂等 | 集成 | 验收 3 | 同上 |
| 7 | 结果捕获落盘 pending_review | 集成 | 验收 4 | 同上 |
| 8 | 无有效结果 deferred fallback | 集成 | 验收 4 | 同上 |
| 9 | 记录字段完整性 + run 日志对齐 | 集成 | 验收 4/5 | 同上 |
| 10 | Review API list/override/400/404 | 集成 | 验收 5 | 同上 |
| 11 | override → 纠偏任务回流 + runLoop 拾取 | 集成 | 验收 5 | 同上 |
| 12 | decisions.html 页面 + dashboard 入口 | 集成 | 验收 5 | 同上 |
| 13 | 三插件注册一致性 | 集成/单元 | 验收 6 | `tests/unit/render-config.test.js` `plugin-config.test.js` |
| 14 | gate off 回归基线（旧路径不变） | 集成 | 验收 1/7 | `tests/integration/server.test.js` `decision-gate.test.js` |
| 15 | 决策续跑（decisionResume）接入 run.js | 单元 | 验收 7 | `tests/unit/run-resume.test.js` |
| 16 | 真 run 冒烟证据 | 冒烟 | 验收 7 | `sandbox/decision-smoke/smoke.cjs` → `smoke-evidence.json` |

## 详细测试用例

### TC1: 开关缺省（config.json 缺失 / 无 run.decision 段）→ false
**类别**：单元 · 正常/边界 ｜ **验收**：1 ｜ **落地**：run-config.test.js / decision-config.test.js
- **前置**：临时项目 `.awf/config.json` 缺失；或存在但只有 `run.agents`
- **执行**：`loadRunConfig(projectRoot)`；`isDecisionEnabled(projectRoot)`
- **断言**
  - `decision.enabled === false`
  - `isDecisionEnabled(...) === false`
  - agents 回落默认（max=1）

### TC2: 开关显式 true / false 语义
**类别**：单元 · 正常 ｜ **验收**：1 ｜ **落地**：run-config.test.js / decision-config.test.js
- **前置**：`.awf/config.json` 含 `run.decision.enabled`
- **执行**：分别写 `true` / `false`
- **断言**：`enabled === true` / `false`（布尔精确，非字符串）

### TC3: 开关非法值回落 false（字符串/数字 + 非法 JSON）
**类别**：单元 · 边界/异常 ｜ **验收**：1 ｜ **落地**：run-config.test.js / decision-config.test.js
- **前置**：`enabled: 'true'` / `enabled: 1` / 非法 JSON 文件
- **执行**：`isDecisionEnabled` / `loadRunConfig`
- **断言**：全部回落 `false`（仅接受布尔）

### TC4: server helper 与 CLI 判定一致（单源防漂移）
**类别**：单元 · 一致性 ｜ **验收**：1 ｜ **落地**：decision-config.test.js
- **前置**：缺省态 / 显式 true 各一临时项目
- **执行**：`isDecisionEnabled(p)` 与 `loadRunConfig(p).decision.enabled` 对比
- **断言**：两态均相等（server/CLI 共用 decision-config.cjs 单一实现）

### TC5: gate on 普通任务完成不触发（多次 Stop）
**类别**：集成 · 防误触发 ｜ **验收**：3 ｜ **落地**：decision-gate.test.js（Stop ① / 闭环约束组）
- **前置**：gate on 项目；会话 busy
- **执行**：连续多次 `Stop`（消息无决策标记）
- **断言**：均 `ready`、无 ccOutput、无落盘、`decisionGate` 恒 null

### TC6: gate on 文字标记触发 → deciding + block（一次事务只 block 一次）
**类别**：集成 · 正常 ｜ **验收**：2/3 ｜ **落地**：decision-gate.test.js（Stop ②）
- **前置**：gate on；会话 busy；消息以 `<AWF_DECISION_REQUIRED>…</…>` 结尾且 `!stop_hook_active`
- **执行**：触发 `Stop`；再次带标记无结果的 `Stop`
- **断言**
  - 首次：返回 ccOutput `{ decision:'block', reason: <决策模式指令> }`（`reason` 含 `AWF_DECISION_RESULT` 与「禁止再向用户提问」）；`decisionGate.phase==='deciding'`；state 保持 busy（不 ready）
  - 二次：不再二次 block（收敛到 fallback 闭合，防递归）

### TC7: gate on AskUserQuestion 非 deciding → deny 转 DC
**类别**：集成 · 正常 ｜ **验收**：2 ｜ **落地**：decision-gate.test.js（PreToolUse）
- **前置**：gate on；会话非 deciding
- **执行**：`PreToolUse(AskUserQuestion)` 带 questions
- **断言**：ccOutput `{ hookSpecificOutput:{ permissionDecision:'deny', updatedInput:{ questions:[] } } }`；reason 指引模型以 `<AWF_DECISION_REQUIRED>` 标签收尾；不置 deciding、不捕获

### TC8: gate on ask deny 后标签收尾 → 进入 deciding（两入口合一）
**类别**：集成 · 正常 ｜ **验收**：2 ｜ **落地**：decision-gate.test.js
- **前置**：TC7 deny 后
- **执行**：模型以 `<AWF_DECISION_REQUIRED>…</…>` 收尾 → Stop 闸门②
- **断言**：进入 `deciding`（AskUser 入口与文字入口走同一 Stop 闸门）

### TC9: gate on deciding 中重复 AskUserQuestion → 拒绝
**类别**：集成 · 异常 ｜ **验收**：3 ｜ **落地**：decision-gate.test.js
- **前置**：`decisionGate.phase==='deciding'`
- **执行**：再次 `PreToolUse(AskUserQuestion)`
- **断言**：返回 deny（reason=决策闭合前禁再问）；不重新置 deciding

### TC10: deciding 中 Stop 含合法结果 → 落盘 + decisionResume + ready
**类别**：集成 · 正常 ｜ **验收**：4/7 ｜ **落地**：decision-gate.test.js（Stop ③a）
- **前置**：deciding；消息含 `<AWF_DECISION_RESULT>{合法 JSON}</AWF_DECISION_RESULT>`
- **执行**：`Stop`（stop_hook_active=true）
- **断言**
  - 无 ccOutput
  - store 落 `decision_completed`：`decision_id` / `status:'pending_review'` / `result.answer` 匹配 / `created_at` ISO
  - `/status` 暴露 `decisionResume`（`decision_id` 与 store 一致）；state→ready；decisionGate→null

### TC11: deciding 中 Stop 无有效结果 → deferred fallback 闭合
**类别**：集成 · 异常/兜底 ｜ **验收**：4 ｜ **落地**：decision-gate.test.js（Stop ③b）
- **前置**：deciding；多次 Stop 均无合法 Result（no_marker / invalid_json / missing_required / 中断）
- **执行**：收尾 `Stop`
- **断言**
  - 落 `decision_completed`（`fallback:true`，`result.type==='deferred'`，含答案字段供 Review）
  - `decisionResume` 带兜底注记；ready；不悬空不重复（收敛单条）

### TC12: 结果落盘后重复同 decision Stop 幂等
**类别**：集成 · 防递归 ｜ **验收**：3/4 ｜ **落地**：decision-gate.test.js
- **前置**：一次 decision_completed 已落盘
- **执行**：重复同 decision 的 Stop
- **断言**：store 不重复追加（幂等去重，防 Stop 双触发）

### TC13: 记录字段完整性（供 Review 消费）
**类别**：集成 · 结构 ｜ **验收**：4/5 ｜ **落地**：decision-gate.test.js（捕获记录字段组）
- **前置**：一次真实捕获（正式结果 + fallback 各一）
- **执行**：读 `.awf/decisions/runs/*.jsonl`
- **断言**：`decision_completed` 含 `runStamp/event/decision_id/status/fallback/source/created_at/result`；fallback 记录亦完整可 Review

### TC14: 决策事件入 run 日志且时间对齐 store
**类别**：集成 · 一致性 ｜ **验收**：4/5 ｜ **落地**：decision-gate.test.js + run-logger.test.js
- **前置**：一次完整决策事务
- **执行**：读 `.awf/logs/<run>/main.log`
- **断言**：含 `[DECISION][decision_started]` / `[DECISION][decision_completed]` 行；`at` 与 store `created_at` 对齐（Review 页可关联）；override 后有 `[DECISION][decision_overridden]`

### TC15: Review API — GET /awf/decisions 聚合倒序
**类别**：集成 · 正常 ｜ **验收**：5 ｜ **落地**：decision-gate.test.js（Review API 组）
- **前置**：≥1 条 decision_completed
- **执行**：`GET /awf/decisions`
- **断言**：`{ ok:true, total, decisions }`；各 run 倒序（新在前）；含 decision_completed 与 decision_overridden 事件

### TC16: Review API — POST override 追加 + 原记录保留
**类别**：集成 · 正常 ｜ **验收**：5 ｜ **落地**：decision-gate.test.js
- **前置**：一条 decision_completed（决策 id 已知）
- **执行**：`POST /awf/decisions/<id>/override`，body `{ instruction, original_answer? }`
- **断言**：200 `{ ok:true, decision_id, reviewTaskId }`；store 追加 `decision_overridden` 事件；原 `decision_completed` 记录保留

### TC17: Review API — override 校验（400 / 404）
**类别**：集成 · 边界/异常 ｜ **验收**：5 ｜ **落地**：decision-gate.test.js
- **前置**：无 override 权限边界
- **执行**：缺 `instruction` override；对不存在 decision 执行 override
- **断言**：分别 400（缺 instruction）、404（目标不存在）

### TC18: override → 纠偏任务回流 + runLoop 拾取
**类别**：集成 · 回流 ｜ **验收**：5 ｜ **落地**：decision-gate.test.js
- **前置**：override 成功（TC16）
- **执行**：读 state.json；`findNextTask(state)`
- **断言**：`state.tasks` 含 `<decision_id>-REV`：`{ kind:'dev', status:'pending', source:'decision_review', deps:[], plannedFiles:[], exec:{ decision_id, instruction, original_answer } }`；`findNextTask(state).id === <decision_id>-REV`（runLoop 下一轮拾取；run.js 同源原语）

### TC19: decisions.html 页面 + dashboard 入口
**类别**：集成 · UI ｜ **验收**：5 ｜ **落地**：decision-gate.test.js（decisions.html 组）
- **前置**：server 运行
- **执行**：`GET /decisions.html`；`GET /`
- **断言**：decisions.html 200 text/html，含标题/「决策 Review」/字段/Override/「标记 reviewed」；dashboard 含「决策 Review」入口链接

### TC20: gateway hook 输出协议（有/无 ccOutput）
**类别**：单元 · 协议 ｜ **验收**：7 ｜ **落地**：gateway.test.js（hooks.test.js）
- **前置**：异步 stub HTTP server + spawn `gateway.cjs`
- **执行**：响应含 ccOutput；响应 `{ ok:true }`；响应非 JSON；server 不可达；payload 无 hook_event_name
- **断言**：含 ccOutput → stdout 恰为 JSON.stringify(ccOutput) exit 0；其余分支 → 无 stdout 输出 exit 0（网络/解析异常静默）

### TC21: parseDecisionResult / validateDecisionResult
**类别**：单元 · 正常/边界/异常 ｜ **验收**：4 ｜ **落地**：decision.test.js
- **前置**：构造各形态 lastMessage
- **执行**：`parseDecisionResult` / `validateDecisionResult`
- **断言**：无标记→`no_marker`；非法 JSON→`invalid_json`；缺必填（answer/type/finality/real_question/decisive_factors/reconsider_when）→`missing_required` 且列出 missing；合法→`{ valid:true, result }`；数组字段非数组按缺失计

### TC22: DecisionStore — 追加式 jsonl / runStamp / override
**类别**：单元 · 存储 ｜ **验收**：4/5 ｜ **落地**：decision-store.test.js
- **前置**：临时项目 + state.json version + logs 目录
- **执行**：append / 重复 append / 跨 run append / listAll / override
- **断言**：runStamp 对齐 logs 最新 run（非旧 run）；append 不覆盖累积；同 decision_id 幂等跳过；override 追加不覆盖且目标不存在抛错；version 缺失 append 拒绝；isoStamp 与 run-logger 同形

### TC23: decision-instruction 经 marketplace 定位插件
**类别**：单元 · 正常/异常 ｜ **验收**：2/7 ｜ **落地**：decision-instruction.test.js
- **前置**：包根 plugin/config.json（含 ai-workflow-decision）
- **执行**：`decisionPluginDir` / `decisionInstructionPath` / `readDecisionInstruction`；插件未注册场景
- **断言**：按 name 解析 dir（不写死目录名）读到 mode-instruction.md trim 文本；插件未注册抛错

### TC24: 决策续跑 drainDecisionResume（run.js）
**类别**：单元 · 正常/异常 ｜ **验收**：7 ｜ **落地**：run-resume.test.js
- **前置**：mock `/status` 与 `/send`
- **执行**：有 decisionResume → 注入续跑消息 → 再等待；gate off 无 resume；多次决策多轮 resume；注入失败
- **断言**：注入含 answer（兜底注记）且续跑；无 resume 零注入零等待；多轮直到耗尽；注入失败停止（不死循环）

### TC25: gate off 回归基线（旧路径不变）
**类别**：集成 · 回归 ｜ **验收**：1/7 ｜ **落地**：server.test.js + decision-gate.test.js（gate off 组）
- **前置**：gate off 项目
- **执行**：AskUserQuestion → PreToolUse 捕获 decisionPending → PostToolUse answer 回写 → Stop 清空 ready；含决策标记的 Stop 亦走现状
- **断言**：无决策闸门介入、无落盘、无 ccOutput；既有上抛/autoSelect/问人路径行为与旧版一致（server 回归全绿）

### TC26: 真 run 冒烟（real server 全链路）
**类别**：冒烟 · E2E ｜ **验收**：7 ｜ **落地**：sandbox/decision-smoke/smoke.cjs
- **前置**：fixture gate on；真实 server（port 0）；清空 logs/decisions
- **执行**：SessionStart→busy→文字触发→结果 Stop→Review API→override→读 main.log
- **断言**：11/11 checks（block ccOutput / deciding / busy 保持 / capture ready / decisionResume 与 store id 一致 / decision_completed / override 200 / 纠偏任务 `<id>-REV` / main.log 含 decision_completed）；证据落 smoke-evidence.json

## Mock 策略

| 依赖 | Mock 方式 | 说明 |
|------|-----------|------|
| Session Server | 真实 `server.start(0)`（集成/冒烟） | decision-gate.test.js / smoke.cjs 起真实 server，hook payload 直发 |
| CC 会话 | hook 事件驱动，不依赖真实 Claude | smoke.cjs 以 Stop/PreToolUse payload 驱动状态机 |
| `.awf/config.json` 开关 | 临时项目目录注入 | 单元测试建 tmpProject 写配置，afterAll 清理 |
| state 写锁 | 真实 `.awf/state.lock`（withStateLock） | override 纠偏任务走真实锁，测试复位任务表 |
| HTTP 客户端 | 真实 spawn gateway.cjs + stub HTTP server | gateway.test.js 验证输出协议 |
| run.js 续跑 | mock `/status`、`/send` | run-resume.test.js 验证 drainDecisionResume 注入语义 |
