# dsh 适配：待定清单（临时）

> 配套：`docs/discuss/dsh-adapter-design.md`（设计方案，待据此修订为 v2）
> 日期：2026-09-15

## 约定（本清单的确认方式）

C-1 每个选项里，我方推荐的选项标「（推荐）」；推荐只是建议，勾选才算定。

C-2 每题结构固定，四段：`###` 问题 → `>` 描述（可在其下追加 **补充说明**）→ `- [ ]` 选项（末项「其他：」留自定义）→ `**补充问题**`（空位，有补充问题时在此提出/回答）。

C-3 只打补丁，不改原文：已确认的项、既有描述、既有选项一律不动；新增内容一律**追加**（补充说明追加在引用下方，新问题追加到清单末尾的新编号）。

C-4 勾选 `[x]` = 最终确认；未勾选 = 该问题尚未结束。

C-5 讨论中出现的新问题，追加到清单末尾，不插入已确认区。

---

## A. 契约与能力面

### A1 `host` 新契约的最终方法集是什么？

> 现契约是 tmux 形状：`sendText` + `sendEnter` 两段式、`capture()` 返回渲染后文本、`sessionName` / `hasSession()` 是 tmux 专有。新契约按能力设计，每条要能回答「不提供它，哪个目的达不成」。改造面：16 处消费点 + 1 处注入点。
>
> **补充说明**：暂无。

- [ ] `label` / `alive` / `submit` / `interrupt` / `snapshot` / `metrics` （推荐）
- [*] 上述再加 `injectLocal`（即 A2 选「进契约」）
- [ ] 其他：

**补充问题**：暂无。

### A2 「本地命令注入」是否进契约？

> 现在是 `server/runtime/channel.cjs:45` 的 `sendLocalCmd`，实现在 adapters 之外。两个消费者：`/cmd` 路由（`server/web/api/session.cjs:112`）与上下文压缩的 `clearSession`（`channel.cjs:98` → 注入 `/clear`）。cc 实现是发文本，dsh 对应 `commands.execute`。
>
> **补充说明**：暂无。

- [*] 进契约：`host.injectLocal(cmd)` （推荐）
- [ ] 不进契约，收进 `session.reset()` 内部实现，不对外暴露
- [ ] 其他：

**补充问题**：暂无。

### A3 `session` 端口转正后的方法集是什么？

> 现状态 `not-landed`，live 走 `scripts/bootstrap.sh`（shell 里拼 tmux + claude）。dsh 下对应「确保 dsh web 在跑 + 装插件」。同时它要承载上下文清空（`reset`）。
>
> **补充说明**：暂无。

- [ ] `start({ projectRoot, sid })` / `stop()`
- [*] 上述再加 `reset()` （推荐）
- [ ] 其他：

**补充问题**：暂无。

### A4 子 Agent 面是「新端口」还是「参数化值」？

> 涉及两件事：身份与派发（现在写在提示词里：`Agent 工具` + `subagent_type: ai-workflow-core:awf-worker`）与结果提取（`extract` 已存在，但只有 cc 实现）。若开新端口，契约从 7 个变 8 个。
>
> **补充说明**：暂无。

- [*] 纯参数化值 + 复用 `extract`，不开新端口 （推荐）
- [ ] 新开 `workers` 端口（`identity` / `dispatchFragment` / `parseResult` / `enforce`）
- [ ] 其他：

**补充问题**：暂无。

### A5 adapter descriptor 的形状是什么？

> P0 核心产出：提示词模板里的「值」从哪来。候选维度：工具名 / 身份注入 / 续话工具 / 打断方式 / 用量来源 / 清空上下文 / 回写形状。
>
> **补充说明**：暂无。

- [ ] 就这 7 维 （推荐）
- [ ] 7 维之外还要加（请在下一项写）
- [ ] 其他：

**补充问题**：暂无。

### A6 `ccShapes` 是否提升为端口？

> spec §4.6 提出重审：当年裁「不是端口」的理由之一是「无可替换性诉求」，多 CLI 下该理由失效——回写形状恰好由 CLI 决定（cc 用 stdout JSON；dsh hooks 桥用 exit 2 + stderr）。它现在直接泄漏进领域层（`decision/gate.cjs:60`、`decision/handler.cjs:18`）。
>
> **补充说明**：暂无。

- [ ] 提升为端口 （推荐）
- [ ] 保持非端口工具，但形状改由 adapter 提供
- [ ] 其他：

**补充问题**：暂无。

## B. 通道

### B1 指令下发的载体是什么？

> `/run/events` 是带 `afterSeq` 的可重放事件环（`server/run/host.cjs:493`）。把「submit 指令」混进去，插件重连会重放旧指令 → 重复派发。传输原语本身已定复用零依赖 WS（D-6）。
>
> **补充说明**：暂无。

- [ ] 新端点（复用 `ws.cjs` 原语）+ ack + at-most-once （推荐）
- [ ] 混进 `/run/events`，加事件类型 + 插件侧去重
- [ ] 其他：

**补充问题**：暂无。

### B2 结构化对话 `/conversation` 是否本轮补上？

> 该路由后端至今未落地（`web/mock/server.js` 是唯一实现）；cc 下真实对话只有 `/status?snapshot=1` 的抓屏文本。dsh 侧天然有 session projection，可由插件回吐。
>
> **补充说明**：本轮做的价值取决于 cc dashboard 的对话页是否保留。若按 spec §8.5「观测改为存储 + 推送」的方向走，则属于该方向的一部分，而非本设计新增面。此点是我的补充问题（见下）。

- [ ] 本轮做（插件回吐，顺带补上 cc）
- [ ] 本轮不做，只留接口位 （推荐）
- [ ] 其他：

**补充问题**：cc dashboard 的对话页（`/conversation`）在本轮之后是否还要保留并继续投入？

## C. 资产双轨

### C1 dsh 命令名与调用路径怎么定？

> dsh 命令名正则 `^[a-z][a-z0-9_-]*$`（`dsh-commands/lib/index.js:71`）禁冒号，`/ai-workflow-code:w-plan` 无法直用；命令是独立 RPC `commands.execute(sessionId, line)`，不是 prompt 文本展开（待 E2 实测）。
>
> **补充说明**：暂无。

- [ ] 扁平名（如 `w-plan`）+ 走 `commands.execute` （推荐）
- [ ] 扁平名 + 仍靠注入文本（若 E2 证明可触发）
- [ ] 其他：

**补充问题**：暂无。

### C2 36 个 skill 的 dsh 形态怎么落？

> cc 插件 skill 目录 vs dsh `dsh-skill` / `dsh-skill-filesystem`（格式未验）。
>
> **补充说明**：暂无。

- [ ] 复用现有 skill 源，加 dsh 侧挂载 （推荐）
- [ ] dsh 侧独立资产，各自维护
- [ ] 其他：

**补充问题**：暂无。

### C3 子 Agent 身份落地方式选哪个？

> cc 靠 `subagent_type` 引用 `plugin/core/agents/awf-worker.md`（含 frontmatter `tools:` 机器白名单）；dsh 靠实例级 `persona` + `toolFilter` + `toolName`（`dsh-subagent/lib/index.js:542-556`）。依赖 E4。
>
> **补充说明**：暂无。

- [ ] 插件自挂专用 tool-subagent 实例（不降级） （推荐）
- [ ] 降级：统一 agent + prompt 内联身份（损失机器工具白名单）
- [ ] 其他：

**补充问题**：暂无。

### C4 dsh 下哪些状态改由插件回吐？

> D 方案不用 hooks（`stop_hook_active` 恒 false；`last_assistant_message` 缺失）。cc 现有 7 个 hooks 承担 ready/busy 状态、子 Agent 落账、决策请求感知。
>
> **补充说明**：选项一与选项二并不互斥：主链路走插件回吐，`dsh-hooks-claude-code` 桥可同时保留为可选层（spec §4.3 已如此表述）。故此题的实质是「主链路归谁」，不是「是否彻底弃用桥」。

- [ ] 全部由插件回吐（ready / busy / 子 Agent 生命周期 / 结果） （推荐，作主链路）
- [ ] 保留 `dsh-hooks-claude-code` 作可选兼容层，不进主链路
- [ ] 其他：

**补充问题**：暂无。

## D. 生命周期与前置

### D1 谁起 `dsh web`？

> spec §8.1 把「dsh 模式必须开着 web 页面」列为前置，但没人负责。
>
> **补充说明**：暂无。

- [ ] `session.start()` 负责拉起并等就绪 （推荐）
- [ ] 只做前置校验，缺了就报错
- [ ] 其他：

**补充问题**：暂无。

### D2 谁装插件？

> `dsh plugin --profile web add link:<path>`（必须 `link:`，`file:` 会拷贝且不刷新）。现在 `awf init` / `awf plugin` 走 `tooling` 端口的 cc 实现（`claude plugin install`）。
>
> **补充说明**：暂无。

- [ ] `tooling` 端口加 dsh 实现，由 `awf init` 调用 （推荐）
- [ ] 独立步骤，文档指引手动执行
- [ ] 其他：

**补充问题**：暂无。

### D3 谁渲染 profile 的 `cordis.patch.yml`？

> MCP 挂载（3 个 server）与插件条目都靠它；现在 `scripts/render-config.mjs` 只渲染 cc 的 `.mcp.json` / `settings.json` / plugin.json。
>
> **补充说明**：暂无。

- [ ] 新增 dsh 侧 render，纳入 `render-config.mjs` （推荐）
- [ ] 插件自带静态 patch，不做渲染
- [ ] 其他：

**补充问题**：暂无。

## E. 待实测（spike）

### E1 运行时内打断的落点在哪？

> `session/cancel` 是 ACP wire 方法；D 方案的插件活在运行时内，不走 ACP；SDK 未暴露打断。
>
> **补充说明**：此为事实核查题，无推荐项，实测后回填。

- [ ] 运行时内 session controller service
- [ ] ACP `session/cancel`
- [ ] `prompt(..., mode: 'steer')`
- [ ] 其他：

**补充问题**：暂无。

### E2 注入文本里带 `/w-plan` 能否触发 dsh 命令？

> **补充说明**：此为事实核查题，无推荐项，实测后回填。

- [ ] 能触发
- [ ] 不能，必须走 `commands.execute`
- [ ] 其他：

**补充问题**：暂无。

### E3 `toolFilter.{allow,deny}` 支持什么工具名形态？

> 决定「worker 禁写 state」能否机器强制。
>
> **补充说明**：此为事实核查题，无推荐项，实测后回填。

- [ ] 支持 MCP 工具名，可精确禁写
- [ ] 只能禁内置工具，MCP 工具禁不掉
- [ ] 其他：

**补充问题**：暂无。

### E4 插件 patch 能否 insert 第二个 `tool-subagent` 实例？

> 配置项 `toolName` + `persona` + `toolFilter`（如 `toolName: awf_worker`）。
>
> **补充说明**：此为事实核查题，无推荐项，实测后回填。

- [ ] 能
- [ ] 不能 → C3 走降级
- [ ] 其他：

**补充问题**：暂无。

### E5 `subagent.finished.lastAssistantMessage` 的实际形态？

> **补充说明**：此为事实核查题，无推荐项，实测后回填。

- [ ] `ContentBlock[]`，`extract` 需适配
- [ ] 纯字符串，`extract` 可原样复用
- [ ] 其他：

**补充问题**：暂无。

### E6 `oneshot` 的 dsh 实现选哪个？

> 服务于 plan 的 check/wbs/tasks、monitor 诊断、replanning。
>
> **补充说明**：暂无。

- [ ] `dsh --profile sdk`（JSON-RPC over stdio） （推荐）
- [ ] `dsh-headless` 包
- [ ] 其他：

**补充问题**：暂无。

### E7 `dsh plugin` 有 remove / list 吗？

> **补充说明**：此为事实核查题，无推荐项，实测后回填。

- [ ] 都有
- [ ] 只有 add
- [ ] 其他：

**补充问题**：暂无。

### E8 `interactive` 面（plan 交互）在 dsh 下怎么落？

> **补充说明**：暂无。

- [ ] 退化为「在 web 页面里跑」，不设该面 （推荐）
- [ ] 保留，直开 dsh TUI
- [ ] 其他：

**补充问题**：暂无。

## F. 测试与门禁

### F1 per-adapter 一致性夹具怎么做？

> spec §9.5 遗留：dsh 侧要在测试里起可用环境，或做一套假件。
>
> **补充说明**：暂无。

- [ ] 假件（假 awf server + 假插件）
- [ ] 真环境（隔离 `DSH_HOME`）
- [ ] 混合：形状用假件，链路用真环境 （推荐）
- [ ] 其他：

**补充问题**：暂无。

### F2 改造面计数脚本要不要进 CI？

> **补充说明**：暂无。

- [ ] 进（与 `check:arch` 同类的门禁） （推荐）
- [ ] 只做脚本，不进 CI
- [ ] 其他：

**补充问题**：暂无。

## G. 文档

### G1 spec v2 修订哪些节？

> 候选：计数重算 / 能力面矩阵 / 资产双轨 / 通道语义 / §11 未验证项补齐。
>
> **补充说明**：暂无。

- [ ] 上述 5 节全改，仍留单文件 （推荐）
- [ ] 拆成多份文档（设计 / 契约 / 资产 / 测试）
- [ ] 其他：

**补充问题**：暂无。

### G2 阶段划分按草案推进吗？

> P0 定契约与口径 → P1 契约收口（cc-only，一次到位）→ P2 选择与解析 + 提示词内置 server → P3 dsh 能力面（run → batch → 其余六面 → UI）→ P4 收口。
>
> **补充说明**：暂无。

- [ ] 按草案 （推荐）
- [ ] 调整（请写下新划分）
- [ ] 其他：

**补充问题**：暂无。

### A7 `hook` 端口怎么处置？（新增）

> 实测：`hook` 端口声明为 `factory`，但**生产路径上没有消费点** —— `/hook` 路由自己处理 payload（`server/web/api/hook.cjs`），`hook` 端口只在 `ports.cjs` 与测试里出现。dsh 更是完全没有 hooks。另：申报的能力面与实际消费面一旦失真，端口名册就数不清了（`ports.cjs` 自己的纪律）。
>
> **补充说明**：暂无。

- [ ] 降级为 adapter 内部工具（不进端口名册）
- [ ] 删除该端口，hook 解析逻辑留在 server
- [ ] 保留为端口，把 `/hook` 路由改为经端口取用（兑现 D-12「回调点计入能力面」） （推荐）
- [ ] 其他：

**补充问题**：暂无。

### A8 插件侧资产里的 cc 机制回退怎么处置？（新增）

> 实测三处：（1）`plugin/core/mcp/awf-oneshot/server.cjs:16` 直接 require `server/adapters/cc/oneshot.cjs`（**绕过 ports.cjs 唯一门**），缺包时回退 `claude -p` 字面（:78）；（2）`plugin/core/mcp/awf-session/server.cjs:84` 失败回退本地 `tmux capture-pane`；（3）`plugin/core/agents/awf-monitor-*.md` 提示词里满是 tmux / CC 语义。
>
> **补充说明**：这些消费点不在 spec §3 的改造面统计里（那些只统计 server / cli 侧），但 dsh 下它们同样失效。

- [ ] 全部收口：插件侧改走 awf server 的 HTTP 面，去掉直连与字面 （推荐）
- [ ] 只收口 MCP 两处，agent 提示词按 adapter 参数化
- [ ] 其他：

**补充问题**：暂无。

### A9 适配器能力的管理方式怎么定？（新增）

> 提案三层：**面（port）** 稳定且少（目标 ≤8，改面 = 契约变更）／**能力（capability）** 全部登记（面内方法、descriptor 值、hook 事件；约 30 项）／**机制（mechanism）** adapter 内部私有（cc：tmux / hooks / statusline / transcript；dsh：运行时 service / 插件回吐），不进契约。能力登记为可执行表（`name` / `shape` / `required` / `status` / `why` / `consumers`）：加载期断言 `required` 存在，可选能力缺实现必须显式 `unsupported`、不许留空；上层只读 `status` 标记，不许探测「我是哪个 adapter」。再用 `count-adapter-surface.mjs` 扫生产消费点与登记表**双向对账**并进 CI（即 F2）。
>
> **补充说明**：暂无。

- [ ] 按提案三层（面 / 能力 / 机制 + 可执行登记 + status 标记 + CI 对账） （推荐）
- [ ] 只保留面与方法，不做登记表与 CI 对账（轻量，但名册仍可能失真）
- [ ] 其他：

**补充问题**：暂无。

### A10 「会话开始/结束」「回合提交」是继续当回调点用，还是 dsh 下改由插件直接提供会话状态？（新增）

> 现状：cc 拿这两个 hook 事件当**状态来源**（`/hook` 路由把 SessionStart → ready、UserPromptSubmit → busy、Stop → ready，见 `server/web/api/hook.cjs`），executor 的等待语义直接依赖该状态。D-12 已把「回调点」计入能力面，本题问的是**状态来源**归谁。
>
> **补充说明**：暂无。

- [ ] 状态由「回调点」统一供（dsh 插件在对应时机回吐同样的回调）
- [ ] 状态归「会话状态」能力，由 adapter 直接提供读数（回调点只作事件，不承担状态）
- [ ] 其他：

**补充问题**：暂无。

---

## 已定（已确认，不再改动）

D-1 dsh 覆盖范围 —— 全命令面（init / plan / run / plugin / server / open / attach 全通），不只 run。

D-2 提示词归属 —— 属编排的一环，内置 `server/`，不再算插件资产；参数化模板 + 值分离。

D-3 上下文用量读数 —— 挂进 `host` 面（`host.metrics()`），不新开端口。

D-4 推进方式 —— 先整体规划，再分阶段推进。

D-5 子 Agent 身份 —— dsh 有对等物（实例级 `persona` + `toolFilter` + `toolName`），不降级；优先「插件自挂专用 tool-subagent 实例」（待 E4）。

D-6 传输原语 —— 复用既有零依赖 WS（`server/web/ws.cjs`），不引 SSE。

D-7 `host` 契约方法集 —— `label` / `alive` / `submit` / `interrupt` / `snapshot` / `metrics` + `injectLocal`（据 A1、A2 勾选确认）。

D-8 `session` 端口方法集 —— `start({ projectRoot, sid })` / `stop()` + `reset()`（据 A3 勾选确认）。

D-9 工具安装（CLI 本体） —— dsh 与 cc 保持同步（同一能力面，各自实现）。

D-10 辅助工具安装（tmux / node 等依赖） —— dsh 与 cc 保持同步。

D-11 打开页面 —— dsh 无终端形态：dashboard 与 attach 都归为「打开页面」。

D-12 回调点（hook） —— 计入能力面；本质是会话提供的**回调点**，dsh 由插件实现；cc 的回写形状（阻塞回合 / 权限拒绝）属该能力的**返回值**。

D-13 一次性调用（oneshot） —— 计入能力面。

## 已重算的口径（待落进 spec）

`ctx.tmux.*` 消费点：文档 12 → 实测 16 消费 + 1 注入（`session.cjs` 12 · executor 4 · util 1 · `runtime/index.cjs:108` 注入点）。

经 `ports.cjs` 取句柄的生产文件：文档 12 → 实测 12（一致）。

cli 直连 tmux：文档 5（都在 session.cjs）→ 实测 session.cjs 4 + `attach.cjs:12` = 5。

测试含 host 词汇文件：文档 18 → 实测 26（18 含 `tmux`）。

测试方法调用点：文档 9/7/4/3/3/2 → 实测 hasSession 5 · sendText 5 · sendEnter 1 · capture 2 · sendCtrlC 1 · sessionName 属性 4（无调用）。

插件资产（文档未计）：命令 16 · 技能 36 · 子 Agent 定义 3 · MCP server 3 · hooks 7。

---

## 附录：适配器能力全表（参考，非问题）

> 来源：server / cli / plugin 三侧消费点实测。每行 = 上层要做什么 → 不提供会怎样 → cc 现实现（证据）。
> 本表是 A1 / A4 / A5 的事实底稿；A 区原文不改，差异以本表为准。

### 一、会话驱动（host 面）

1. `label` —— 出错时指明是哪个会话 —— tmux 会话名 `cc-<sid>`（`runtime/executor.cjs:54`、`web/api/util.cjs`）。

2. `alive` —— 派发前判断通道可用，避免空投 —— `tmux has-session`（`runtime/executor.cjs:53`；`web/api/session.cjs` 5 处 503 守卫）。

3. `submit` —— 把指令交给会话并知道是否受理 —— sendText + 间隔 + sendEnter（`runtime/executor.cjs:21,23`；`web/api/session.cjs:211,213`）。

4. `interrupt` —— 中止当前响应（w-monitor 干预 / 用户停止） —— `send-keys C-c`（`web/api/session.cjs:144,156`）。

5. `snapshot` —— 会话实时视图文本（复盘 + 实时看到） —— `capture-pane -p -S -`（`web/api/session.cjs:54`，唯一消费点 `/status?snapshot=1`）。

6. `injectLocal` —— 注入本地 slash 命令（不产生回合收尾） —— send-keys 文本 + 兜底定时器（`runtime/channel.cjs:45,98`；`/cmd` 路由 `web/api/session.cjs:112`）。

### 二、会话生命周期（session 面）

7. `start` —— 起环境并等到会话就绪 —— `scripts/bootstrap.sh`（tmux + claude）；cli 直连 tmux（`cli/lib/session.cjs:93,127`）。

8. `stop` —— 收口会话 —— `tmux kill-session`（`cli/lib/session.cjs:97,167`）。

9. `reset` —— 清空 / 压缩上下文 —— 注入 `/clear`（`runtime/channel.cjs:98`；消费点 `features/context/compaction.cjs:73`）。

### 三、状态与计量（metrics 面）

10. `usage` —— 上下文占用实测百分比 —— statusLine 探针写 `.awf/context/usage.json`（`runtime/channel.cjs:75`、`scripts/context-usage.mjs`；消费点 `compaction.cjs` 的 `readUsagePct`）。

11. 会话状态来源（ready / busy / 决策挂起） —— 派发与等待判据 —— cc hooks → `/hook` 路由（`web/api/hook.cjs`；`session.setReady/setBusy`）。

12. `inspect`（probe） —— 外部侦查会话在不在 + 状态（无失败态） —— host + status（`adapters/cc/probe.cjs`；消费点 `web/api/session.cjs:65` ← MCP `awf_session_status`）。

### 四、子 Agent（workers 面）

13. 派发值 —— 让主会话按约定派生 worker —— 工具名 / 身份引用 / 背景参数 / 续话工具（`plugin/plugin-code/prompts.json` 的 `batch-dispatch`、`subagent-dispatch`、`subagent-redispatch`、`subagent-resend`）。

14. 结果输入源 —— 拿到子 Agent 末条消息 —— `last_assistant_message`（消费点 `run/subagent.cjs:28`、`observability/run-logger.cjs:231`）。

15. 结果解析（extract） —— RESULT / NEEDS_INPUT / transcript 渲染 —— `parseSubagentResult` / `parseNeedsInput` / `parseTranscriptLine` / `renderTranscriptText`（同上）。

16. 约束 —— worker 不写 state、不提问 —— cc agent frontmatter `tools:` 白名单（`plugin/core/agents/awf-worker.md`）。

### 五、命令入口

17. 命令名与命名空间 —— 提示词里指名要跑哪个命令 —— `/ai-workflow-code:w-plan`、`/w-dev`（`prompts.json` 的 `plan-*`、`gate-fix`）。

18. 命令注册 / 安装 —— 让命令在会话里可用 —— `claude plugin install`（`cli/commands/plugin.cjs` ← `adapters/cc/tooling.cjs`）。

19. 交互对话 —— plan 的人机问答 —— 直开 claude TUI（`cli/commands/plan.cjs:30` ← `adapters/cc/interactive.cjs`）。

### 六、无状态 LLM 调用

20. 一次性出文本 —— plan 的 check / wbs / tasks、诊断 —— `claude -p`（`web/api/run.cjs:68`；MCP `awf_oneshot`）。

21. 长驻 / 流式子进程 —— monitor 现场诊断 —— `spawnClaudeP`（`features/monitor/diagnosis.cjs:127`）。

### 七、配置与装配

22. 项目配置注入 —— 会话能读到 hooks / MCP / settings —— cc `.claude/settings.json` + 项目 `.mcp.json`（`profile.installProfile`；`cli/lib/session.cjs`、`cli/commands/plugin.cjs:31`）。

23. 卸载 / 清单 —— 回滚与安装清单 —— `uninstallProfile` / `listDeclaredPlugins`（`cli/commands/plugin.cjs:39,49`）。

24. MCP 注册 —— MCP server 挂进会话 —— `installProjectMcp`（`cli/lib/session.cjs:155`）。

25. 运行期 settings 产物 —— 状态行 / 权限等 —— `generateRunSettings` → `.awf/run-settings.json`（`cli/lib/session.cjs:32`）。

26. CLI 可用性前置检查 —— 早失败 —— `claudeAvailable`（`cli/commands/init.cjs:32`）。

27. 市场与安装命令构造 —— 插件安装 —— `buildMarketplaceAdd` / `buildInstall` / `buildUninstall`（`cli/commands/plugin.cjs:54,55,59`）。

### 八、回写形状

28. 阻塞回合 —— 决策门阀接管 —— stdout JSON `{decision:'block'}`（`features/decision/handler.cjs:161` ← `ccShapes.blockDecision`）。

29. 权限拒绝 —— 拦截工具调用 —— `hookSpecificOutput.permissionDecision`（`features/decision/gate.cjs:111` ← `ccShapes.denyPermission`）。

### 九、hook 事件摄入

30. hook payload → 领域事件 —— 状态与子 Agent 落账 —— `adapters/cc/hook.cjs` 的 `translateHook`；**实测生产路径无消费点**（`/hook` 路由直接处理，`server/web/api/hook.cjs`）→ 见 A7。

### 十、插件侧消费点（清单必须覆盖）

31. MCP `awf_oneshot` 直连 adapter —— 会话内 AI 调用 —— `plugin/core/mcp/awf-oneshot/server.cjs:16` 直接 require `server/adapters/cc/oneshot.cjs`，缺包时回退 `claude -p` 字面（:78）→ 见 A8。

32. MCP `awf_session` 抓屏 —— 会话内 AI 自查 —— HTTP 优先，失败回退本地 `tmux capture-pane`（`plugin/core/mcp/awf-session/server.cjs:84`）→ 见 A8。

### 十一、附加终端

33. attach / 观看实时对话 —— 人看现场 —— `tmux attach`（`cli/commands/attach.cjs:12`）。

---

## 附录二：能力树（产品视角，按用户给出的格式梳理）

> 与附录一同物两切：附录一按代码消费面切，本附录按「用户能做什么」切。
> 标记：`＋` = 你这份有、我漏了；`－` = 我这份有、你那份未列；`⚠` = 表述不同或需澄清。

### 工具安装

- 检查 CLI 在不在 PATH（cc：`tooling.claudeAvailable()` ← `cli/commands/init.cjs:32`）。

- ⚠ 安装 / 升级 CLI 本体：cc 侧**只检查、不安装**（`init.cjs` 缺依赖即中止）。dsh 侧是否要代装待定。

### 插件安装

- 插件市场注册（`buildMarketplaceAdd`）、安装 / 卸载 / 清单（`install` / `uninstall` / `listDeclaredPlugins` ← `cli/commands/plugin.cjs`）。

- MCP server 注册（`installProjectMcp` ← `cli/lib/session.cjs:155`；dsh 走 `cordis.patch.yml`）。

- ＋ 插件声明模板：cc 是 `plugin/config.json` 单源 + `scripts/render-config.mjs` 渲染 marketplace / plugin.json / `.mcp.json` / hooks.json；dsh 对应 `package.json` 的 `dsh.bundle` / `dsh.client` + `cordis.patch.yml`。

### 辅助工具安装

- ＋ cc 现状只有**检查**：`init.cjs:18-33` 查 tmux / claude / node，`scripts/bootstrap.sh:10-13` 再查一遍；没有安装动作。

- ⚠ 需要定：是「检查 + 给安装指引」，还是要真代为安装（brew / npm）。

### 打开 web 页面

- cc：`awf open dashboard|tree|ui` → `open http://localhost:<port>/<path>?p=<projectRoot>`（`cli/commands/open.cjs`）。

- dsh：打开 dsh web 页面（并确保它在跑 → D1）。

- － 附加终端 `attach` —— 人看实时对话（`cli/commands/attach.cjs:12`）。

### 对话

- 项目文件夹（工作目录 / 项目寻址：`.awf` 布局 + 单 server 多项目 `?p` 路由）。

- 会话 sid（会话标识：hooks 提供 `session_id`，tmux 会话名 `cc-<sid>`，多 run 隔离用 `?sid`；端口面上就是 `label`）。

- 会话状态（`alive` 通道可用 + ready / busy + `probe.inspect()` 外部侦查）。

- 发送对话（不带命令 → `submit`；带命令 → `injectLocal`）。

- 停止对话（`interrupt`）。

- ＋ 选择选项（单选 / 多选）：cc 现状是 AskUserQuestion 被决策门阀在 `/hook` 拦下 + `/respond` 回填（`session.setDecision`），MCP `awf_await_choice` / `awf_await_input` 已停用；dsh 有 `dsh-tool-ask-user` + `dsh-client-ui-user-questions`，天然有问答 UI。

- 实时对话内容（cc：`capture-pane` 抓屏经 `snapshot` 出；结构化 `/conversation` 未落地；dsh：session projection）。

- － 上下文清空 / 压缩（`reset`；cc 注入 `/clear`；消费点 `features/context/compaction.cjs:73`）。

### 插件

- 自定义 agent（cc：`subagent_type` 引用 agent.md + frontmatter `tools:` 白名单；dsh：`tool-subagent` 实例的 `persona` + `toolFilter` + `toolName`）。

- 自定义命令（cc：`/ai-workflow-code:w-plan`；dsh：扁平名 + `commands.execute`）。

- 自定义技能（cc：`skills/`；dsh：`dsh-skill` / `dsh-skill-filesystem`）。

- 插件声明模板（同「插件安装」末条）。

### 信息

- 上下文用量（cc：statusline 探针 → `.awf/context/usage.json` ← `runtime/channel.cjs:75`）。

- ＋ Token 用量（总 / 输入 / 输出 / 输入缓存创建 + 读取）：cc **已有** —— `observability/metrics.cjs` 的 `tokens.{input,output,cacheReadInput,cacheCreationInput,coverage}`，数据源是 cc transcript jsonl。

- ＋ 近 1 分钟输出速度：cc **已有** —— `outputSpeed.currentTokensPerSecond`（`recentWindowSeconds: 60`）。附带 `averageTokensPerSecond`。

- ＋ 提问后首次响应平均时间：cc **现在也没有**（全仓无 TTFT 字段，`elapsedMs` 只是 run 总时长）→ 真新增能力，需定数据源（dsh 有 token meter / session stats；cc 只能从 transcript 时间戳推算）。

### 其他（我这份有、你那份未列）

- 会话生命周期 `start` / `stop`。

- 子 Agent 派发值（提示词参数）+ 结果提取（`extract` 的 RESULT / NEEDS_INPUT）。

- 回写形状：阻塞回合（`blockDecision`）+ 权限拒绝（`denyPermission`）。

- hook 事件摄入（实测 cc 生产路径无消费点 → A7）。

- `oneshot` 一次性 LLM 调用（`claude -p`；MCP `awf_oneshot`）。

- 外部侦查 `probe`（w-monitor 用）。

- 错误定位 `label`（报错文案用）。

- 插件侧消费点收口（`awf-oneshot` 直连 adapter、`awf-session` 回退 tmux → A8）。

---

## 附录三：能力树（清理版）

> 对附录二「其他」那批的重新归类：6 项里只有 `oneshot` 是真能力，其余是已有能力的子部分，或根本不是能力。

### 被移出能力清单的（说明）

- `label` —— 不是能力，就是**会话名**（报错时用来指认）。并入「对话 → 会话 sid」。

- 会话生命周期 `start` / `stop` —— 不是独立能力，是「打开页面」的**起停语义**（dsh 下页面在跑才有会话；cc 下 `stop` 是 `kill-session` 实体动作）。并入「打开页面」。

- 子 Agent 派发值（工具名 / 身份引用 / 背景参数） —— 不是能力，是**提示词内容**（「用 X 工具派 worker」）。承载它的是「发送对话」+「插件 → 自定义 agent」。

- 子 Agent 结果提取（`extract` 的 RESULT / NEEDS_INPUT） —— 不是能力，是**解析规则**（从子 Agent 末条消息里抠结构化结果）。承载它的是「回调点」+「实时对话内容」。

- 回写形状（`blockDecision` / `denyPermission`） —— 不是独立能力，是**回调点的返回值**（决策门阀要拦下提问 / 拒绝工具调用）。并入「回调点（hook）」。

- 外部侦查 `probe` —— 不是独立能力，是「会话状态」的**只读形态**（w-monitor 问「会话还在吗」）。并入「对话 → 会话状态」。

### 不是能力，是缺陷（移入债务）

- 插件侧消费点两处：`plugin/core/mcp/awf-oneshot/server.cjs:16` 直接 require `server/adapters/cc/oneshot.cjs`（**绕过 ports.cjs 唯一门**），缺包时回退 `claude -p` 字面（:78）；`plugin/core/mcp/awf-session/server.cjs:84` 失败回退本地 `tmux capture-pane`。→ 见 A8。

### 清理后的能力树

- 工具安装（dsh 与 cc 同步）

- 插件安装：市场 / 安装 / 卸载 / 清单；MCP 注册；插件声明模板

- 辅助工具安装（dsh 与 cc 同步）

- 打开页面（含起 / 停会话；dsh 下 attach 与 dashboard 同为此项）

- 对话：项目文件夹；会话 sid；会话状态（含只读侦查）；发送对话（带命令 / 不带命令）；停止对话；选择选项（单选 / 多选）；实时对话内容；上下文清空 / 压缩

- 插件：自定义 agent；自定义命令；自定义技能；插件声明模板

- 信息：上下文用量；Token 用量（总 / 输入 / 输出 / 缓存）；输出速度（近 1 分钟）；首次响应平均时间（**cc 现无，真新增**）

- 回调点（hook）：会话开始 / 结束、回合提交、工具调用前后、子 Agent 起停；返回值形状（阻塞 / 拒绝）随 CLI 而定

- 一次性调用（oneshot）
