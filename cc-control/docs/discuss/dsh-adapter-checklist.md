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

- [ ] 纯参数化值 + 复用 `extract`，不开新端口 （推荐）
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

---

## 已定（已确认，不再改动）

D-1 dsh 覆盖范围 —— 全命令面（init / plan / run / plugin / server / open / attach 全通），不只 run。

D-2 提示词归属 —— 属编排的一环，内置 `server/`，不再算插件资产；参数化模板 + 值分离。

D-3 上下文用量读数 —— 挂进 `host` 面（`host.metrics()`），不新开端口。

D-4 推进方式 —— 先整体规划，再分阶段推进。

D-5 子 Agent 身份 —— dsh 有对等物（实例级 `persona` + `toolFilter` + `toolName`），不降级；优先「插件自挂专用 tool-subagent 实例」（待 E4）。

D-6 传输原语 —— 复用既有零依赖 WS（`server/web/ws.cjs`），不引 SSE。

## 已重算的口径（待落进 spec）

`ctx.tmux.*` 消费点：文档 12 → 实测 16 消费 + 1 注入（`session.cjs` 12 · executor 4 · util 1 · `runtime/index.cjs:108` 注入点）。

经 `ports.cjs` 取句柄的生产文件：文档 12 → 实测 12（一致）。

cli 直连 tmux：文档 5（都在 session.cjs）→ 实测 session.cjs 4 + `attach.cjs:12` = 5。

测试含 host 词汇文件：文档 18 → 实测 26（18 含 `tmux`）。

测试方法调用点：文档 9/7/4/3/3/2 → 实测 hasSession 5 · sendText 5 · sendEnter 1 · capture 2 · sendCtrlC 1 · sessionName 属性 4（无调用）。

插件资产（文档未计）：命令 16 · 技能 36 · 子 Agent 定义 3 · MCP server 3 · hooks 7。
