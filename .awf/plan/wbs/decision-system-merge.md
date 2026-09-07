# AWF 决策闸门 v0.2.0 — WBS（合并树）

> 项目 W4-001。模块 W3 层已与用户确认；功能 W2 / 任务 W1 为本文件产出。
> 验收标准为每叶子的 done 条件（可独立验证）。

```
W4-001 AWF 决策闸门（单 agent，route A / 当前 Session 切 DC）
```

## W3-001 打包与注册 —— 独立 ai-workflow-decision 插件

### W2-001 渲染器与配置泛化（多插件市场）
- **W1-001** 泛化 render-config.mjs / plugin-config.js：渲染按 `marketplace.plugins` 遍历，去掉对 `core`/`plugin-code` 的写死；hooks 仍单源渲染进 core（不按插件拆 hooks，防双 Stop 竞态）；各插件 plugin.json 依条目生成。
  ✅ plugin.json 生成逻辑接受任意 dir；`npm run build` 后 5 个注册文件全部正确生成；core/plugin-code 产物与现状一致。
- **W1-002** 渲染器单测：core/plugin-code 输出回归不变；新增任意第 3 插件 dir 时正确产出 marketplace 条目 + 该插件 plugin.json。
  ✅ 单测覆盖：双插件渲染结果 = 基线快照；+decision 后 marketplace 含 3 条目、decision/plugin.json 字段正确。
- **W1-003** config.json + settings.json 注册 decision：`marketplace.plugins` 增 `{dir:"decision", name:"ai-workflow-decision", version, keywords, description}`；settings.json `plugins[]`/`enabledPlugins` 增 `ai-workflow-decision@ai-workflow-dev`；重跑 render 且产物入库。
  ✅ plugin/config.json 与 plugin/settings.json 含 ai-workflow-decision；`.claude-plugin/marketplace.json` 与 `plugin/decision/plugin.json` 已生成并 git 可见。

### W2-002 决策技能与资产落地（含 mode-instruction）
- **W1-004** 建 `plugin/decision/` 资产布局：`skills/decision-core/SKILL.md`（frontmatter `name: decision-core` + description 含触发/引用方；正文保留 12 公理，无坏相对引用）+ 目录 README。
  ✅ decision-core skill 可被 `ai-workflow-decision:decision-core` 识别；无对旧路径 `.awf/skills` 的引用。
- **W1-005** 迁移 decision-workflow SKILL + PROTOCOL + schema 进 `plugin/decision/decision/{PROTOCOL.md,schemas/decision-result.schema.json}`；decision-workflow 明确"单 agent 下 server 扮演 DW、skill 供复杂/未来场景复用"。
  ✅ 三资产落位、内容与原型一致或更适配；decision-workflow 无坏引用。
- **W1-006** 新增 `plugin/decision/decision/mode-instruction.md`：决策模式短指令（对齐集成文档 §8：禁再问人、调 decision-core、必要时补本地/网络事实、只输出 `<AWF_DECISION_RESULT>` 包裹的 Decision Result）。
  ✅ 文件存在且被 W1-017 读取测试引用通过。

### W2-003 旧原型清理与文档同步
- **W1-007** 归档集成方案：`AWF_DECISION_INTEGRATION.md` → `cc-control/docs/discuss/decision-system-design.md`（保留 + 加指向新架构 note 的链接）；删除 `plugin/awf-decision-system/` 整目录。
  ✅ 旧目录删除、设计文档在 docs/discuss 可查、无残留引用（grep awf-decision-system 命中归零或均为指向新归档）。
- **W1-008** 文档同步：plugin/README.md 插件表、cc-control/CLAUDE.md 目录树/skills/命令描述、plugin/CHECKLIST.md、plugin/README「双插件」表述 → 三插件（core / decision / plugin-code）。
  ✅ 仓库文档不再称"双插件"且正确描述 ai-workflow-decision。

## W3-002 决策配置开关

### W2-004 run.decision 配置加载
- **W1-009** `src/lib/run-config.js` 增 `run.decision.enabled`（缺省 false）+ 校验/默认合并 + 单测。
  ✅ 加载器支持缺省/显式 true/false；单测通过。
- **W1-010** server 侧 enabled 判定 helper（读 `PROJECT_ROOT/.awf/config.json` 的 run.decision.enabled，与 CLI 同默认逻辑、单一来源防漂移）+ 单测。
  ✅ helper 对 缺省/true/false 返回预期；server 可注入。
- **W1-011** 模板/文档：`src/templates/awf-config.json` 增 `run.decision`（含注释语义：缺省走既有上抛逻辑）；README/config 说明。
  ✅ 模板与说明落库。

## W3-003 server 决策状态机与 Hook 链路（核心）

### W2-005 Hook gateway 命令
- **W1-012** 实现 `plugin/core/hooks/gateway.cjs`（node：读 stdin payload → POST server `/hook?event=X` → 响应含 `ccOutput` 则打印其 JSON，否则无输出 exit 0）；config.json.hooks 的 **Stop** 与 **PreToolUse(AskUserQuestion)** 命令改走 gateway，其余事件保持裸 curl；render；更新 hooks.test.js 断言。
  ✅ gateway 存在、两条命令指向它；hook 事件配置经 render 落库；hooks.test.js 通过。
- **W1-013** gateway/ccOutput 协议单测：server 响应含 ccOutput → stdout 恰为 `JSON.stringify(ccOutput)`；无 → stdout 空、exit 0。
  ✅ 单测覆盖两种分支。

### W2-006 server Stop 决策化
- **W1-014** decisionGate 状态对象 + `/status` 暴露 + Stop handler 重构为 decision-aware：
  - gate off：维持现状 `clearDecision()+setReady()`；
  - gate on 防递归三分支：①普通完成（无标记）→ setReady；②消息含 `<AWF_DECISION_REQUIRED>` 且非 deciding → `phase=deciding`，**不 setReady**，响应 `ccOutput={decision:"block", continuePrompt:<指令>}`；③deciding 中：消息含 `<AWF_DECISION_RESULT>` → 转捕获/落盘/fallback 判定后 setReady；deciding 中但无有效结果（stop_hook_active 或兜底）→ 构造 deferred fallback 落盘后 setReady。
  ✅ 三分支行为单测覆盖；gate off 时与现状一致；deciding 期间 busy 不翻转。
- **W1-015** `parseDecisionResult(last_assistant_message)`（正则抓 `<AWF_DECISION_RESULT>{…}`）+ 轻量校验（answer 非空，type/finality/real_question/decisive_factors/reconsider_when 齐全；不引 ajv）+ 结果→store 写入接口（store 由模块 D 提供，此处先按契约调用）。
  ✅ parse/校验单测：合法结果、缺 answer、非 JSON、无标记 四类输入按预期判定。

### W2-007 PreToolUse(AskUserQuestion) 决策化
- **W1-016** PreToolUse 分支：gate on → 置 deciding + 响应 `ccOutput={hookSpecificOutput:{permissionDecision:"deny", permissionDecisionReason:<指令>, updatedInput:{questions:[]}}}`；gate off → 维持 `setDecision` 现状；deciding 事务内重复 AskUserQuestion → 只首次 deny，后续拒绝并提示"决策闭合前禁再问"。
  ✅ 单测：gate on/off 两分支；重复调用只 deny 一次。
- **W1-017** 决策模式指令从 `plugin/decision/decision/mode-instruction.md` 解析（plugin-bridge 增读决策插件资产能力，插件路径由 config 的 marketplace 解析，不写死）；block continuePrompt 与 deny reason 共用该指令。
  ✅ plugin-bridge 能定位 decision 插件并读取指令；文案注入两处且可替换（改插件文件不动 server）。

### W2-008 单 agent 决策闭环回归保护
- **W1-018** 决策闭环约束：一次决策事务必须闭合（防递归、deny 只一次、无结果有 fallback）；**无 stop_hook_active 字段也能可靠判定**（deciding 态 + 消息含/不含结果）；普通任务结束绝不触发 gate。
  ✅ 集成测试覆盖：普通完成/文字触发/AskUserQuestion/防递归/fallback 各一例。

## W3-004 决策记录与 Review

### W2-009 decision-store
- **W1-019** `src/server/decision-store.cjs`：runStamp 解析（对齐 `.awf/logs/${version}-${ts}`）、append（追加式 jsonl）、list（聚合各 run 倒序）、override 追加事件、`runs/` 目录 mkdir；幂等/并发安全。
  ✅ store 单测：写读/聚合/runStamp 对齐/追加不覆盖。
- **W1-020** 捕获接线：server 捕获/fallback 均经 store 落 `decision_completed`（status=pending_review，含 fallback 标记）；单测验证记录字段齐全。
  ✅ 一次真实捕获在 `.awf/decisions/runs/*.jsonl` 落一条完整记录。

### W2-010 Review API 与页面
- **W1-021** API：`GET /awf/decisions`（聚合列表倒序）、`POST /awf/decisions/<decisionId>/override`（写 decision_overridden + 触发纠偏任务，见 W1-023）。
  ✅ API 单测/集成：list 返回聚合；override 落记录。
- **W1-022** 页面：`GET /decisions.html` 路由 + `src/server/decisions.html`（展示：时间/Decision ID/问题/answer/类型/finality/决定性因素/风险/未知/反转条件/fallback；操作：标记 reviewed / override 输入 instruction）；dashboard 增加入口链接。
  ✅ 浏览器可打开 Review 页并看到记录；override 表单触发对应 API。

### W2-011 纠偏任务回流
- **W1-023** override → server 追加纠偏任务：`kind=dev`、`source:"decision_review"`、携带 `decision_id/instruction/original_answer`、`deps=[]`、`plannedFiles=[]`（保守串行）、wbsRef 空；复用 state 写锁（对齐 settleSubagent）。
  ✅ 单 agent runLoop 下一轮 findNextTask 自动拾取该 pending 纠偏任务（集成验证）。

## W3-005 单 agent 编排收尾与回归

### W2-012 编排联调与 gate off 回归
- **W1-024** run.js/scheduler 兼容核对：gate on 下 AskUserQuestion 不进 decisionPending/不走 autoSelect（已由 deny 拦截）；`decisionPending` 仅剩人类明示路径（await_choice/input 等）；必要小改 + 日志；**gate off 回归：旧 autoSelect/上抛逻辑行为不变**。
  ✅ 回归单测：gate off 时 AskUserQuestion→decisionPending→handleDecision 路径与现状一致；gate on 时无 decisionPending 产生。
- **W1-025** run 日志/诊断呈现决策事件：决策开始/闭合/fallback/override 关键事件入日志（与 store 一致的时间戳）。
  ✅ run 日志能看到决策事件行，与 Review 页数据对齐。

### W2-013 集成测试与真 run 冒烟
- **W1-026** server hook 集成测试套件（gate on/off 双路径全覆盖，见 W1-014/016/018 场景 + record + override→task）。
  ✅ vitest 集成测试绿；gate off 全通过为回归基线。
- **W1-027** 真 run 冒烟：sandbox/ 临时 fixture 项目跑最小 `awf run`（gate on），验证文字/AskUserQuestion 触发、决策落盘、Review 数据、纠偏任务可拾取，产出证据记录。
  ✅ fixture run 完整跑通，决策记录与 Review 可查，输出冒烟证据文件。

---
## 依赖摘要
- W1-001/002/003（模块 A 顺序）→ W1-004/005/006 → W1-007/008
- W1-009/010/011（模块 B）→ 模块 C
- W1-012/013 → W1-014/015（依赖 W1-010 enabled helper）→ W1-016/017
- W1-019 → W1-020（W1-015 调其接口）
- W1-021/022/023 依赖 W1-019
- W3-005（W1-024/025/026/027）依赖模块 C/D 就绪
- 门禁：W3 模块级测试门禁各 1；项目文档门禁 1（tasks 阶段生成，ID 对齐 W3/W4）
