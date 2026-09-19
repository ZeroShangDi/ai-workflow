# DSH 接入：执行记录（Codex 清单 / 设计 spec 配套）

> 建立：2026-09-18。维护者：AI（执行会话）。**换会话先读本文件的 §0 恢复指北与 §2 任务板。**
> 依据：`dsh-adapter-checklist-codex.md`（U1～U14 已确认）、`dsh-adapter-design-codex.md`（§7 P0～P4）。
> 本文件分工：**任务、依赖、验收方式、状态、证据、下一步**。不复制 spec 正文；设计结论回写 spec，
> 用户取舍问题追加到 checklist-codex 并标记未确认。
> **换机器接续**：见同目录 [`dsh-adapter-handoff.md`](dsh-adapter-handoff.md)（环境重建 + 未提交产出 + P1 入口）。
> 保留历史：已完成条目**不删**，失败与作废的证据同样保留并标注原因。

---

## 0. 恢复指北（换会话 / **换机器**只看这一节也能接上）

> **换机器请先读 [`dsh-adapter-handoff.md`](dsh-adapter-handoff.md)** —— 它包含环境重建、未提交产出的带走方式、
> 已知预期失败与 P1 入口。本节是会话内接续的摘要。

| 项 | 值 |
|---|---|
| 仓库 | `/Users/v-shangjunhao/MyProject/ai-workflow/cc-control`（git 根在其父目录 `ai-workflow/`） |
| 当前阶段 | **P0 基本完成（9/10 实验有真实证据；T-P0-12 只剩 U14 实机确认）→ 下一步 P1 CC 契约收口** |
| 当前阻塞 | 无硬阻塞。两项待接线（均有确认结论，属 P2）：U16 approval 受控自动批准、U17 上下文清空用「换新会话+交接」 |
| 待用户回答 | 无。新取舍问题追加到 `dsh-adapter-checklist-codex.md`，标 `【待你确认】` |
| 隔离实验环境 | `DSH_HOME=/tmp/awf-dsh-probe`；脚本 `.awf/probe/dsh/{env.sh,guard.sh}` |
| 真实 DSH | `~/.dsh`，**有正在运行的 `dsh web`，监听 `127.0.0.1:3080`（PID 5473）**。本工作**不得**改动它 |
| 未提交文档 | `docs/discuss/dsh-adapter-checklist-codex.md`（M）、`docs/discuss/dsh-adapter-design-codex.md`（??）为上一轮用户/Codex 产出，**保留，不覆盖不丢弃** |
| 本次开发不依赖 | 不依赖尚未实现的 AWF→DSH 接入；用隔离 profile + 独立探针脚本自举 |

**下一步动作（按序）**：
1. **换机器的话先做 [`dsh-adapter-handoff.md`](dsh-adapter-handoff.md) 的 §1 与 §3**（环境重建 + 把未提交产出带走）。
2. 进入 **P1（CC 契约收口）**：T-P1-01→T-P1-06，硬门槛是每步 `npm test` 全绿 + `npm run check:arch` 通过。
3. P1 完成后进 P2：按本文件「P2 已明确接线项」实现，避免重复试错（F19/F26/F29/F31/U16/U17/E-10）。
4. T-P0-12 的 U14 三条交互约定请在真实页面上确认；不阻塞 P1。

---

## 1. 阶段板（spec §7）

| 阶段 | 目标 | 出口条件 | 状态 |
|---|---|---|---|
| **P0** | 关键可行性验证 + 任务/记录建立 | X1～X9 有实测结论；U1～U17 已确认；能力登记与自动检查落地 | **基本完成**（T-P0-12 仅剩 U14 实机确认，不阻塞 P1） |
| P1 | 以 CC 为基线收口公共契约 | ports 按项目装配、能力/事件接缝、CLI 直连收口、编排模板迁移；CC 测试与架构检查通过 | **下一步** |
| P2 | DSH 最小完整链路 | init → 网页 plan → 单任务 run；单后台复用、项目 MCP、会话创建、提交回执、落账、快照、停止 | 未开始 |
| P3 | 全能力与异常路径 | C01～C30、C33～C36 达约定语义；`run -r` 最小恢复；双项目与 CC/DSH 混用 | 未开始 |
| P4 | 网页占位、安装包与最终验收 | C31/C32 三个**空页面**+必要入口；open/attach；干净环境安装/卸载/升级；能力矩阵区分占位与完成 | 未开始 |

P0 未通过前**不改** CC 公共契约（spec §7 明确要求）。

---

## 2. 任务板

状态词：`pending` / `in_progress` / `done` / `blocked`。每条任务写清「目标 / 依赖 / 验收方式 / 证据」。

### 2.1 P0 · 工程任务

#### T-P0-01 建立隔离实验环境 【done】
- **目标**：在不触碰用户真实 `~/.dsh`（含运行中的 `dsh web`）的前提下，能反复起一个独立 DSH profile 做实验。
- **依赖**：无。
- **验收方式**：① 隔离 `DSH_HOME` 下能创建 profile；② 真实 `~/.dsh` 配置面指纹前后一致；③ 固件版本记录在案。
- **证据**：`.awf/probe/dsh/env.sh`（强制 `DSH_HOME`）、`.awf/probe/dsh/guard.sh`（真实配置面指纹）。
  实测：`dsh --profile awfprobe --from-default-profile web --dump-config` 退出码 0、输出 539 行；
  profile 落在 `/tmp/awf-dsh-probe/profiles/awfprobe/`（`package.json` + `cordis.patch.yml` + `cordis.yml` + `pnpm-workspace.yaml`）。
  真实 home 配置面未被改动：`~/.dsh/profiles/web/cordis.yml mtime=1789716550`（早于本次实验）、
  `cordis.patch.yml mtime=1789442748`、`package.json mtime=1789382914` 均未变。
- **备注**：`guard.sh` 首版把 `storages/` 纳入指纹，因**本会话自身**的 dsh 进程在持续写 session 缓存而误报；
  已修订为只覆盖配置面，并在脚本头注明「不能证明没有其他进程写真实 home」。这是测量方法修正，不是被测结论变化。

#### T-P0-02 建立能力登记与自动检查（U9）【done ✅】
- **目标**：落实 U9 —— 建立可自动检查的适配能力登记，核对**真实实现与调用方**，区分公共能力/平台内部机制；必需能力缺失即失败，可选能力不支持要明说。
- **依赖**：无。
- **交付物**：
  - `server/adapters/capability-registry.json` —— **37 项能力**全量登记（C01～C37），每项含 `kind`(public/platform)、`port`、
    `cc.impl[]`/`dsh.impl[]`（**真实文件路径**）、`consumers[]`、`evidence[]`（F 编号 / E-* 实验）、`status`、`note`、`responsible`。
  - `scripts/check-capability.mjs` —— 对账门禁；`npm run check:capability`。
  - `tests/unit/capability-registry.test.js` —— 7 个用例（1 正面 + 6 负面）。
- **验收（逐条对照 U9）**：
  ① 登记机器可读 ✅（JSON，schema 字段白名单校验）；
  ② 实现与调用方能被核对 ✅（`impl`/`consumers` 的路径必须真实存在，`port` 必须出现在 `ports.cjs` 名册）；
  ③ **缺实现/缺调用方时检查失败** ✅（负面用例覆盖：路径不存在、名册外端口、`blocked` 缺 note、`implemented` 却无实现、未知字段、id 重复、非法 status、consumers 不存在）；
  ④ 不设端口数量上限 ✅（检查器注释与实现均无上限规则，只有名册一致性）。
- **实测结果**：`npm run check:capability` → `✓ 对账通过`；`npx vitest run tests/unit/capability-registry.test.js` → **7 passed**。
- **状态分布**（登记即真实进度口径）：`implemented=2 partial=24 planned=9 blocked=1 unsupported=1`（public 37 / platform 0）。
  其中 `blocked=1` 是 **C15 清空上下文**（DSH 0.1.5-rc.2 无公开 clear/reset，见 F 表）。
- **明确不做**：本检查**不判定语义正确**（脚本会打印这句）；语义由带证据的行为测试与真机验证负责。也不把「有实现 + 有调用方」当作已接入。
- **备注**：spec §3 明确「37 项能力 ≠ 37 个端口」，故登记按能力组织，端口只作一致性交叉检查。

#### T-P0-02b 全量测试基线（CC 回归门槛）【done，含 1 项环境性失败】
- 实测 `npm test`：**107/108 文件通过、1004/1008 用例通过**。
- 唯一失败文件 `tests/unit/init.test.js`（4 例），原因：**本会话 PATH 上没有 `claude`**
  （`which claude` 为空；`tmux`/`node` 在），而该文件第一例就叫「本机三项齐备（真机用例的前置条件，缺了这里先红）」。
- **与本次改动无关**：`git status` 显示本次只新增 `scripts/check-capability.mjs`、`server/adapters/capability-registry.json`、
  `tests/unit/capability-registry.test.js` 与改动 `package.json` scripts；`cli/commands/init.cjs` 零改动（`git diff --stat` 为空）。
- **处置**：保留为**环境性失败**记录，不修改该测试；有 `claude` 的机器上应复跑确认（列入 T-P0-13 交付检查）。

#### T-P0-03 把 P0 实测结论回写 spec 与 checklist 【done ✅】
- **目标**：P0 每项实验完成后，把「已验证/失败/未验证」与证据写回 spec §8 和 checklist 的 X1～X9 表；**保留历史状态**。
- **完成情况**：
  - `dsh-adapter-design-codex.md` §8「待 AI 验证」表 → 重写为 **P0 实测结论**表：每项标注 **已验证 / 部分已验证 / 仍有阻塞**，
    并写明关键约束（如 X1 的「注册异步需等」、X2 的「restrict 只能点名全局层」、X4 的「父取消不停子」）。
  - `dsh-adapter-checklist-codex.md` → 更新 X9 那一行的状态，并**追加**「P0 实测结论同步」一节（不改历史回答与选项）。
  - 口径：**不把「部分」写成「全部通过」**；静态核查与实测分开表述；失败与阻塞（F34、C15）显式列出。
- **证据**：上述两个文档的 §8 / 追加节；逐项证据指向本文件 T-P0-04～T-P0-14 与 F 表。

### 2.2 P0 · 验证实验（X1～X9 映射）

> 每个实验都要求「**真实运行**」证据，不能只凭静态源码或替身测试宣称通过（spec §8 末段）。

#### T-P0-04 E-01 隔离环境与版本基线 【done】
- 目标/验收/证据：即 T-P0-01。**实测基线：launcher 与内部包均为 `0.1.5-rc.2`**（`dsh --version` = 0.1.5-rc.2；profile 依赖池 `~/.dsh/profiles/node_modules/@deepseek-ai/*` 同上）。

#### T-P0-05 E-02 第三方插件包能否被 profile 加载（host 半侧 + client 半侧）【done ✅】
- **目标**：证明 `server/adapters/dsh/plugin/` 这种「仓库内、非 dsh workspace」的插件包能被真实加载并激活 —— 这是 D 方案（编排活在 web 运行时内）的**唯一前提**。
- **依赖**：T-P0-01。
- **验收方式**：① 等价离线装配能把插件登记进 `dsh.profile.bundles`；② `--dump-config` 能看到该插件的 patch 层；
  ③ **真实启动**后插件 `apply()` 被调用且有可观测输出；④ client 半侧进入网页 boot graph 并被真实服务。
- **结论：四项全部通过（真实运行 + HTTP 往返）。**

**证据 A —— 静态（装配与层叠）**
装配路径 `.awf/probe/dsh/probe-02-plugin.sh` 步骤 2（离线等价于 `dsh plugin add link:`：写 `dependencies` + `node_modules` 符号链接 + 追加 `dsh.profile.bundles`）。
`--dump-config` 末尾出现插件自带层：
```
# == @awf/dsh-probe-plugin
- id: awf-probe-plugin
  name: '@awf/dsh-probe-plugin'
```
（headless profile 351 行、web profile 539 行 dump 均含该层。）

**证据 B —— 真实运行（host 半侧 apply 与能力面）**
headless profile（`@deepseek-ai/dsh-base` + 插件）真实启动，`process.env.AWF_PROBE_EVIDENCE` 落盘 JSONL：
```
{"event":"apply","name":"awf-probe-plugin","services":["agents","sessions","sessionPersistence","llm","tools","loader","timer","commands"]}
{"event":"no-webServer"}            // headless 组合下确无 webServer，符合预期
{"event":"dispose"}                 // SIGTERM 后触发
```
web profile（`dsh-base` + `dsh-web-app` + 插件，`--patch` 覆盖 webserver 到 39081）：
```
{"event":"apply",...,"services":["webServer","agents","sessions","sessionPersistence","llm","tools","loader","timer","clientModules","commands"]}
{"event":"route-registered","path":"/api/awf-probe/ping","hasDispose":true}
{"event":"http-hit","url":"/api/awf-probe/ping","method":"GET"}
{"event":"dispose"}
```
**HTTP 往返实测**：用 `dsh web` 打印的 `?token=` 换取浏览器 cookie 后
`GET /api/awf-probe/ping` → `200` + `{"ok":true,"plugin":"awf-probe-plugin","services":[...],"pid":19083}`。
→ 插件能在运行时 HTTP 面上注册并响应自己的路由（鉴权仍由 dsh 浏览器 cookie 层把关；`GET /` 无 token 仍 401）。

**证据 C —— client 半侧（网页 UI）**
同一 profile 的 `GET /` 返回的 boot graph 里，我们这一行与 52 个内置插件并列：
`/plugins/??…,@awf/dsh-probe-plugin/client.js,…&rev=5b8309cc52e8`；
组合包真实下载（`code=200`，11,093,459 字节）内含我们手写的 lazy-CJS 注册行：
```
id: '@awf/dsh-probe-plugin',
factory: (require) => { … const name = 'awf-probe-plugin'; const inject = ['slots','sessions']; function apply(ctx) { … } }
```
→ `dsh.client{platform:"web"}` + `exports["./client"]` + `window.__ModuleLoader__.load({id,factory})` 的手写包
**无需构建工具链**即可进入网页 boot graph（旧 spike §5.3 的结论在 0.1.5-rc.2 复现）。

**证据 D —— 隔离与生命周期**
实验结束后 `guard.sh check` 输出 `IDENTICAL: 真实 ~/.dsh 配置面未被本次实验改动`；
用户自己的 `dsh web`（3080）全程可用；实验端口 39081 在 SIGTERM 后释放。

- **已知发现（静态）**：
  - `dsh plugin` 是**纯 pnpm 转发**：`lib/plugin-Ddi42qoW.js` → `spawnSync("pnpm", …)`；pnpm 不在 PATH 时返回 127 并打印 `pnpm not found on PATH — install pnpm to manage profile plugins`。
  - **本机 `which pnpm` = 空**（Node v24.21.0 / npm 11.19.0）。→ 装配可离线等价完成；但**交付给用户的安装路径需要 pnpm**，登记为 C02/D-9 依赖检查项（见 F13）。
  - bundle 判定：`exportsPatch()` 读依赖的 `package.json`，有 `dsh.bundle.patch` 才作为 profile 层入栈。
  - patch 覆盖是**浅覆盖**：`for (const [k,v] of Object.entries(overrides)) target[k] = value`（`dsh-app-boot/lib/index.js:104-107`）——
    给 `webserver` 只写 `port` 会丢掉 required 的 `host`，必须整块给全（本实验真实踩坑，见 F14）。
  - `dsh.client` 的 `inject` 是**包名依赖声明（信息性）**，不是 Cordis 服务注入；host 半侧的 `inject` 才是服务依赖。

#### T-P0-06 E-03 会话级 MCP：按项目挂 `AWF_PROJECT_ROOT`（X1）【done ✅】
- **目标**：证明同一个全局 DSH 后台下，可为**每个项目/会话**分别挂 3 个 AWF MCP server 且环境变量指向各自项目根。
- **依赖**：T-P0-05（已完成）。
- **验收方式**：两个项目各自会话内**模型真实调用** `mcp__awf-state__awf_read_state`，返回**各自** `state.json` 的 version/tasks；`AWF_PROJECT_ROOT` 不串。
- **结论：通过（真实运行 + 真实模型调用）**。

**决定性证据（2026-09-18）**
| 项目根 | 该根下 `.awf/state.json` | 模型回答（工具返回值） | turn 结果 |
|---|---|---|---|
| `/tmp/awf-dsh-probe/proj-a` | `version=0.2.0`、1 个任务 | **`0.2.0|1`** | `{"kind":"completed"}` |
| `/tmp/awf-dsh-probe/proj-b` | `version=9.9.9`、2 个任务 | **`9.9.9|2`** | `{"kind":"completed"}` |

证据文件：`/tmp/awf-dsh-probe/evidence/e03-FINAL.json`（含两个 target 的 `turnText`/`turnReason`），
事件流 `/tmp/awf-dsh-probe/evidence/e03final.jsonl`。

**通过路径（可复现）**：
1. 探针插件 `apply(ctx)` 内用 **`ctx.inject([...services], cb)`** 做运行时装配（`webServer`/`agents`/`sessions`/`sessionController`）。
2. 建会话：`agents.create({ sessionId, meta:{cwd}, agentOptions:{provider,model}, setup })`，
   `setup` 内 ① `installModelSelection(agentCtx, { current, assembled })` ② `agentPresets.mount(agentCtx, presetId)`。
3. **在该 agent 的 `agentCtx` 上**挂 MCP：`agentCtx.plugin(McpClient, { transport:'stdio', serverName:'awf-state', command, args, env:{ AWF_PROJECT_ROOT: root }, cwd: root })`。
4. 等注册完成：`agent.ctx.tools.get('mcp__awf-state__awf_read_state')` 出现（或首轮请求 header 的 tools 里出现）。
5. 投递：`sessionController.prompt(request, signal)`（signal 为**第二位置参数**），`await agent.whenIdle()`。

**关键实测数据**：注册完成后模型工具表 **48 个工具**，其中 `mcp__awf-state__*` 共 20 个全部在内。

**踩过的三个坑（都留有证据，避免后续重复）**
- F21：装配必须放 `ctx.inject` 回调；放 `apply` 顶层或 `setTimeout` 到其后都会命中非活跃上下文。
- F26：`sessionController.prompt(request, signal)` 的 signal 是第二位置参数（`dsh-api-session-controller/lib/index.js:2919`）。
- F29：**MCP 工具注册是异步的**（连接 → `tools/list` → `register`）；挂载后立刻提问会看到"没有该工具"。
  必须在提问前等注册完成（本次实测：等待轮询后工具表 48 个工具齐全）。
  `agent.ctx.tools.get(...)` 查不到**不代表**注册失败 —— 模型可见工具表由 preset standing scope 的装配路径给出，
  应以「prompt 后 `session.requestHeader().tools` 是否含该名」为准（本次用它确认）。

- **机制依据（静态）**：`dsh-acp/lib/index.js:216-219`（`mountAcpMcpServers` 逐台 `agentCtx.plugin(McpClient, config)`）、`:699`/`:717`（在 create/resume 的 setup 内挂）；`dsh-mcp-client/lib/index.js:171`（`ctx.tools.register`）、`:120-126`（公开名 `mcp__<serverName>__<rawName>`）。

#### T-P0-06a E-03 的机制选择（已确认）【done】
- 已确认用 `agentCtx.plugin(McpClient, config)`，而不是「全局挂载 + 运行期改 env」（后者会串项目）。
- 三个 server 的 `serverName` 必须唯一（`dsh-mcp-client` 在同一作用域内拒绝重名）→ 每项目/会话各自作用域内挂载是正确形态。
- 装配顺序（必须按此）：`ctx.inject` → `agents.create(setup: installModelSelection + agentPresets.mount)` → `agent.ctx.plugin(McpClient,…)` → 等注册 → `sessionController.prompt(req, signal)`。

#### T-P0-07 E-04 worker 工具权限不被降级 + 多实例（X2）【done ✅（按 U15 收口）】
- **目标**：在「会话级 MCP + 子 Agent」组合下验证 worker 的工具白名单/黑名单**真的生效**（调用被禁工具被拒绝，不是提示词自律），且多个专用 worker 实例互不串。
- **依赖**：T-P0-05、T-P0-06（均已完成）。
- **已完成的实测（真实运行，非替身）**

| 实验 | 挂载位置 | 对照组（不过滤） | 实验组（`deny:[该 MCP 工具]`） | 第二个 worker（`deny:['bash']`） |
|---|---|---|---|---|
| A | **全局层**（`ctx.plugin(McpClient)`） | 调用成功 → `0.2.0` | **`DENIED`（被拒绝）** ✅ | 调用成功 → `0.2.0`（filter 互不影响）✅ |
| B | **会话作用域**（`agentCtx.plugin(McpClient)`） | **`DENIED`**（子 Agent 根本看不到该工具） | `subagents.start` 直接抛错：`tools.restrict() names unknown global tool "mcp__awf-state__awf_read_state"` | — |

- **结论：X2 的「权限不降级」与「项目隔离」在当前 DSH 版本下不能同时满足。**
  - DSH 的 `tools.restrict()` 只能点名**继承层（全局）**的工具名；会话作用域注册的工具不在 `restrictableNames` 里，点名即抛
    （`dsh-tools/lib/index.js:2790-2804`，实测错误信息如上）。
  - 而项目隔离要求「每项目一份 `AWF_PROJECT_ROOT`」→ 必须**按会话**挂 MCP（E-03 已证明这条能通，且两项目互不串）。
  - 两者相交后：**会话作用域挂载 ⇒ 无法对 worker 施加工具级硬限制；全局挂载 ⇒ 所有会话共用一个固定 env 的 MCP，项目隔离失守。**
- **证据文件**：`/tmp/awf-dsh-probe/evidence/e04a.json`（实验 A：deny 生效）、`e04.json`（实验 B：会话作用域下 restrict 抛错）、
  `e04c.json`（全局挂载 + 唯一 serverName：`otherFilter` 读回 proj-b 的 `9.9.9`，但 `childCwd=null`、`deny` 仍报 unknown）。
- **不自动降级（遵 U6/D-5）**：本项**未自行选择弱实现**；冲突已作为 U15 提给用户，现按用户选择（保项目隔离）收口。
- **补充事实**：子 Agent 在全局挂载下会看到该工具并成功调用（`otherFilter → 9.9.9`），说明「全局挂载时 worker 能调用」是成立的；
  被拦的是「按会话挂载 + 想用 restrict 拦」这一组合。

**U15 结论（2026-09-18，用户已确认）：保项目隔离。** 据此本任务收口为：
1. **AWF MCP 按会话作用域挂载**（每项目各自 `AWF_PROJECT_ROOT`）—— E-03 已验证，多项目不串。
2. **非 MCP 工具仍用 DSH 原生 `tools.restrict()` 硬拦**（全局层工具，实测 deny 生效，F31 已证）。
3. **MCP 工具的 worker 约束采用身份/提示词协议**（与 CC 现有做法同类，不视为新增降级）；不采用「全局挂载 + 按调用指定项目」。
4. **多 worker 实例**：实测三个子 Agent 带不同 filter 并存、互不影响（`e04a.json`）。
- **验收（按 U15 重述，已达成）**：worker 能调用允许的工具（实测 `0.2.0`）；非 MCP 被禁工具调用被拒绝（F31 证 deny 生效）；
  多个专用 worker 实例互不串（实测通过）。MCP 工具按上面第 3 条执行，不作为「工具级硬拦」验收项。
- **对 spec/C 编号的影响**：C17～C20 的 worker 权限实现形态按上表；spec §3 能力边界表需同步此限定（列入 T-P0-03 回写）。

#### T-P0-08 E-05 决策拦截：提问前拦住 + 回合末不提前派发（X3）【done ✅（护栏部分；回合末门阀属 AWF 侧）】
- **目标**：等价于 CC 的「Stop 门阀 + PreToolUse 拦截提问」。
- **依赖**：T-P0-05、T-P0-06。
- **本轮验证的护栏（真实运行，硬证据）**：在 agent 作用域注册 `agentCtx.tools.guard(fn)`（`dsh-tools/lib/index.js:2805-2810`，返回字符串即拒绝），
  对 `mcp__awf-state__awf_task_complete` 设拦截后让模型去完成 T-1：

| 观测点 | 结果 | 说明 |
|---|---|---|
| guard 是否被调用 | `{"tool":"mcp__awf-state__awf_task_complete","denied":true}`（2 次） | 拦到了目标工具 |
| 被禁调用是否**到达 MCP 服务端** | **否**：本进程内服务端只记录 `awf_task_status T-1 -> ok`（1 次），**没有** `awf_task_complete` | 这是「执行前拦截」而非「事后打断」的判据 |
| 被禁工具是否真的没生效 | 磁盘回读 `T-1=active`（模型只能把 pending→active），未被标 done | 拦截在写入前生效 |
| 模型能否如实报告失败 | 模型回答：`I can't report DONE — awf_task_complete never succeeded.` 并说明读了 state 仍是 pending | 未把未执行说成成功 |
- **证据文件**：`/tmp/awf-dsh-probe/evidence/e05.jsonl`（`guard-called` / `guard-registered`）、
  `e05-resp.json`（模型回答 + 前后任务快照）、`web-fg31.out`（MCP 服务端日志）、
  磁盘 `/tmp/awf-dsh-probe/proj-c/.awf/state.json`。
- **结论（X3 的护栏部分）**：DSH 提供**执行前**工具拦截，且拦截发生在业务写入之前 → 等价于 CC 的 `PreToolUse` 拦截能力**成立**。
- **仍属 AWF 侧、不在本次 DSH 验证范围**：① 「决策挂起时不派发下一任务」是执行器读 state 的判定（`server/runtime/executor.cjs`
  已在收到决策后 `idleSince=null` 不超时），平台无关；② 「回合末门阀」（CC 用 Stop hook 返回 block）在 DSH 侧应由
  「AWF 自己判断能否继续派发」承担（U10 已确认），**不需要**用 DSH 的回合钩子复刻 CC 的 block 语义。
- **未验证/留给后续**：重复提问、无效决策结果、重复事件的收尾（属 AWF 决策状态机，P3 用统一替身 + 真机各测一次）。
- **顺带记录**：`guard` 是**同步**检查且不能强制放行已被别人拒绝的调用；多个 guard 串联时不可逆（`guardReason` 取最外层首个拒绝）。

#### T-P0-09 E-06 cancel / 队列 / 父子停止 / reset（X4）【done ✅（reset 部分见 C15：blocked）】
- **目标**：确认 cancel 的**真正完成信号**（不是回执即成功）、队列是否清理、父子是否同停、reset 是否有完成信号。
- **依赖**：T-P0-05、T-P0-06。

**实测一：cancel 的完成信号与队列语义**（`/api/awf-probe/cancel-test`，真实模型 + 真实长任务）

| 观测点 | 结果 | 结论 |
|---|---|---|
| `agent.cancel({kind:'user'})` 是否同步返回 | `cancelReturnedSynchronously: true` | 它只是**发起**取消，不是完成 |
| 真正的完成信号 | `await agent.whenIdle()` 在 cancel 后 **14 ms** 返回 | **`whenIdle()` 是可等待的完成信号** |
| 被取消回合的结束原因 | `turn/end → {"kind":"aborted","reason":{"kind":"user"}}` | 能区分「被用户中止」 |
| 默认 cancel 对队列 | cancel 后 `inbox.nextTurn=0, nextStep=0`；排队的 `QUEUED-RAN` **没有**执行 | 默认**清空**排队指令 |
| `cancel(cause,{keepInbox:true})` | `inbox.nextTurn=1`（保留） | 排队指令**保留** |
| 保留后是否自动恢复 | 1.5 s 后 `status=idle`，**不会自己跑** | 保留 ≠ 自动继续，需要外部再推进 |

**实测二：父子连停**（`/api/awf-probe/cancel-tree`，父会话 + 两个真实运行的子 Agent）

| 操作 | 结果 |
|---|---|
| 取消**父会话**（`parent.cancel({kind:'user'})`，父 `whenIdle` 2 ms 返回） | 两个子 Agent **状态仍为 `running`**（3 s 后复查仍是 running）→ **父子不同停** |
| 直接对子 Agent `subagents.interrupt(childId, parent)` | 子 Agent `running → idle`，无报错 → 子 Agent 可被**单独**停下 |
| 子会话的 `turn/end` reason | 仍是 `{"kind":"completed"}`（即使是被 interrupt 停下的）→ **不能只靠会话事件 reason 判中断** |

**结论（X4）**
1. `cancel()` = 发起；**`whenIdle()` = 完成信号**（编排要等它，不能把 cancel 回执当成功）。
2. 默认 cancel 清队列；`keepInbox:true` 保留队列但**不自动恢复**。
3. **停止「整个 run」必须显式覆盖子 Agent**：取消父会话不会连带停子 Agent（U11 要求的「主会话 + 子 Agent + 待执行指令」需分别落实）。
4. 中断证据取「`agent.status` 变为 idle + `whenIdle` 返回」，**不要**依赖 `turn/end.reason`。

- **证据文件**：`/tmp/awf-dsh-probe/evidence/e06.json`（cancel/队列）、`e06-tree3.json`（父子连停 + interrupt）、
  `e06-reset.json`（reset 候选核查）、事件流 `evidence/e06*.jsonl`。

**reset / 清空上下文（C15）的实测边界**
- 候选 ① `sessionController.fork({sessionId})` → **可用**，返回新 sessionId（`session-6889…`）；语义是「从既有会话切出新会话」，**不是清空**。
- 候选 ② `ctx.compaction` → web 组合下 **不存在**（`hasCompaction:false`），`compactNow` 不可用。
- 候选 ③ `agent.inbox` 无公开方法（`inboxMethods: []`）。
- **结论：DSH 0.1.5-rc.2 无公开的「就地清空会话上下文」能力**（与侦察一致）。C15 登记为 `blocked`。
- **不改既定语义的落地建议（待 P2 实现时确认，不在本轮擅自改变）**：把 C15 拆成「**新建会话承接已落盘交接**」——
  用 `sessionController.create` 在原项目建新会话，把 AWF 侧的 handoff 快照注入，旧会话保留可复盘；对上层表现为「已换新上下文并已交接」。
  这与 spec §2「DSH 保存原生对话、AWF 保存业务事件与引用」的方向一致，且**不会把未知当成功**。
- **本轮不做**：不修改 C15 的既有语义，不擅自降级为「假清空」；若 P2 需要真正 in-place clear，需上游提供接口或另提用户取舍。

**压缩（compaction）补测（2026-09-18，用户提示「有压缩可用」后核对）**
- `/api/awf-probe/compact-probe` 实测：`hasRootCompaction=false`、**`hasAgentCompaction=false`**（即经 `agent.ctx.get('compaction')` 仍取不到）、
  `tokenMeter` 可取（`before={totalTokens:9087, surfaceTokens:2254}`），三轮回合后 `seqBefore=35`、压缩调用为 `null`、`seqAfter=35`。
- 源码事实：`compaction` 服务由 `dsh-compaction-basic` 提供，**静态 inject = ["commands","compaction"]**（`dsh-compaction-basic/lib/index.js:761`、`:944` 的 `compactNow`），
  在 `standard/agent.cordis.yml` 里 `compaction-basic` + `command-compact` 位于**带 `isolate` 的 group 内**。
  故它在 preset 的**隔离 realm** 中；探针的 standing mount 取法（与 F32 同源）看不到该 realm 的实例。
- **结论**：压缩能力**存在**（`compactNow(agent, signal, sourceCommandId)`，以及人类命令 `/compact`），
  但**只能由与 preset realm 一致的作用域取得** —— 与本轮多次遇到的「agent 平面贡献对探针不可见」是同一根因。
  对 AWF 的落地含义：适配器要在**与 preset 同 realm** 的上下文里调用压缩（或由 AWF 直接驱动 `/compact` 命令），
  而不是在 root ctx 取服务。**待 P2 实现时按此接线，并补一次「压缩后 tokenMeter 下降」的效果验证。**
- **与 C15 的关系**：压缩**腾出窗口但不删除历史**，所以它**不能替代 clear**；用户已确认接受「换新会话 + 交接」作为 C15 等价语义（U16 方向），
  压缩可作为「不换会话时延长可用轮次」的辅助手段一并纳入。#### T-P0-10 E-07 单任务真实闭环：派发→回执→产出→落账（X5）【done ✅】
- **目标**：真实链路跑通「建会话 → 派发 → 平台受理回执 → 观测回合边界 → 提取产出 → **业务落账**」。
- **依赖**：T-P0-05、T-P0-06。
- **实测（真实运行 + 真实模型 + 独立磁盘回读）**，项目 `/tmp/awf-dsh-probe/proj-c`（`state.json` 有 pending 任务 T-1/T-2）：

| 观测点 | 结果 |
|---|---|
| 模型可见工具表 | `seenMcpCount=20`，`mcp__awf-state__*` 全在（`toolVisible=True`） |
| 平台受理回执 | `sessionController.prompt(request, signal)` 返回 `accepted:true`（E-03 已证） |
| 回合边界事件 | `turn/start` → `step/start` → `user/message` → `assistant/message` → `tool/call` → `tool/result` → `step/end` → `turn/end` |
| 模型产出（ContentBlock 提取） | `assistant/message.content` 取 text → **`DONE`**；`turn/end {kind:'completed'}` |
| MCP 服务端日志 | `[awf-state] awf_task_complete T-1 -> ok` |
| **业务落账（磁盘回读，不由探针自述）** | `T-1: status pending → done`，并写入 `exec.completedAt`；`T-2` 保持 pending；`lastUpdated` 更新 |

- **证据文件**：`/tmp/awf-dsh-probe/evidence/e07b-resp.json`（含 `seenMcp`、`landed:true`、前后任务快照）、
  事件流 `/tmp/awf-dsh-probe/evidence/e07b.jsonl`、服务端日志 `/tmp/awf-dsh-probe/evidence/web-fg30.out`。
- **顺带确认（X5 的其余子项）**：
  - 内部服务调用可用：`agents` / `sessionController` / `agentPresets` / `tools` / `llm` 在 `ctx.inject` 里均可取（F17）。
  - `ContentBlock[]` 提取：按 `b.type==='text'` 过滤拼接即可得产出（与 `dsh-headless` 的 `summarize` 同法）。
  - 工具调用与结果以 `tool/call` / `tool/result` 事件出现在会话事件流里 → 后续「本轮是否有产出」（C27）可直接用事件序列做证据。
- **踩坑记录**：探针两处 `McpClient` 挂载点的 `serverName` 曾不一致（一处带时间戳后缀），导致模型看到的工具名与提示词里写的
  期望名不符、`toolVisible` 恒 false。统一为 `awf-state` 后一次通过（**F33 的推论：同名挂载必须唯一，但探针内多处挂载必须用同一个名字**）。
- **尚未覆盖（留给后续任务）**：这是「单任务」闭环；batch 派发确认（C18）、运行中上下文压缩（C15/C26/C27）、
  门禁 verdict 落账（C36 的执行归属校验）仍待 P2/P3。
#### T-P0-10 E-07 单任务真实闭环：派发→回执→产出→落账（X5）【done ✅】
- **目标**：真实链路跑通「建会话 → 派发 → 平台受理回执 → 观测回合边界 → 提取产出 → **业务落账**」。
- **依赖**：T-P0-05、T-P0-06。
- **实测（真实运行 + 真实模型 + 独立磁盘回读）**，项目 `/tmp/awf-dsh-probe/proj-c`（`state.json` 有 pending 任务 T-1/T-2）：

| 观测点 | 结果 |
|---|---|
| 模型可见工具表 | `seenMcpCount=20`，`mcp__awf-state__*` 全在（`toolVisible=True`） |
| 平台受理回执 | `sessionController.prompt(request, signal)` 返回 `accepted:true` |
| 回合边界事件 | `turn/start` → `step/start` → `user/message` → `assistant/message` → `tool/call` → `tool/result` → `step/end` → `turn/end` |
| 模型产出（ContentBlock 提取） | `assistant/message.content` 取 text → **`DONE`**；`turn/end {kind:'completed'}` |
| MCP 服务端日志 | `[awf-state] awf_task_complete T-1 -> ok` |
| **业务落账（磁盘回读，不由探针自述）** | `T-1: pending → done` + 写入 `exec.completedAt`；`T-2` 保持 pending；`lastUpdated` 更新 |

- **证据文件**：`/tmp/awf-dsh-probe/evidence/e07b-resp.json`、事件流 `evidence/e07b.jsonl`、服务端日志 `evidence/web-fg30.out`。
- **顺带确认（X5 其余子项）**：内部服务调用（`agents`/`sessionController`/`agentPresets`/`tools`/`llm`）在 `ctx.inject` 里均可取；
  `ContentBlock[]` 按 `b.type==='text'` 过滤拼接即得产出；工具调用以 `tool/call`/`tool/result` 事件可见 → C27「本轮是否有产出」可直接用事件序列。
- **踩坑记录**：探针两处 `McpClient` 挂载点的 `serverName` 曾不一致（一处带时间戳后缀），导致模型看到的工具名与提示词里写的期望名不符、
  `toolVisible` 恒 false；统一为 `awf-state` 后一次通过。
- **尚未覆盖**：batch 派发确认（C18）、运行中上下文压缩（C15/C26/C27）、门禁 verdict 落账（C36 归属校验）留给 P2/P3。

#### T-P0-11 E-08 一次性任务与 UI 入口（X6/X7）【done ✅（tab 视觉渲染留给逐页指导阶段）】
- **目标**：短任务隔离执行与超时取消；UI 入口（`conversation.view` / 输入框右侧 / 设置入口）在真实页面可用。
- **依赖**：T-P0-05（E-02 插件加载）。

**A. 一次性隔离调用（C23 / X7）** —— `/api/awf-probe/oneshot`

| 场景 | 结果 |
|---|---|
| 正常调用 | `text='ONESHOT-OK'`、`finish={"kind":"stop"}`、**610 ms** |
| 用量 | `{inputTokens:52, outputTokens:6, totalTokens:58, cacheReadTokens:0, reasoningTokens:0}`（真实可读） |
| **隔离性** | `agentsBefore=1, agentsAfter=1, createdSession=false` → **未创建任何会话/子 Agent** |
| 取消 | `cancelAfterMs:300` → `finish={"kind":"aborted","failure":{"message":"DeepSeek request aborted by caller","code":"ABORTED"}}`，**303 ms** 内生效；未抛异常、未留会话 |

→ DSH 侧的「无状态短调用」用 `ctx.llm.stream({provider, model, system, messages, signal})` 即可，
不需要起会话；取消用 `AbortController`（与 AWF `oneshot` 端口语义对齐）。**证据**：`evidence/e08-oneshot.json`、`evidence/e08-cancel.json`。

**B. UI 入口** —— 用浏览器桥对**隔离实例**（`127.0.0.1:39081`）做真实页面验证

| 观测点 | 结果 | 证据 |
|---|---|---|
| 页面能打开并鉴权 | 导航成功，`title` 正常，页面文本为会话列表 | 浏览器评估 `location.href/title/bodyText` |
| **client 半侧真的在浏览器里执行** | 宿主收到三条回调：`apply-called`（`slots=object`）、`view-registered`（`view='awf-probe', order=100`）、`input-right-registered`（`disposeType='function'`） | `evidence/activation.jsonl` 的 `client-report` 事件（含真实 `userAgent`、`location.href`） |
| 宿主 HTTP 路由（设置/网页入口的落点） | `/api/awf-probe/ping` 带 cookie 返回 200 | E-02 证据 B |
| 三个空页面本体 | **本轮不做**（U4：由用户逐页指导） | — |
| tab 的视觉渲染（`conversation.view` 是否出现在会话 tab 行） | **未在本轮确证**：landing 页无会话 tab 行；打开某个会话后未逐一定位到该 tab | 见下方「未完成项」 |

- **未完成项（明确登记，不假装完成）**：`conversation.view` entry 的**视觉渲染**尚未在本轮确证。
  已知：entry 注册成功（client 回调为证）；未知：其 `render` 属性是否被运行时消费（dsh 内置实现走 `id` → 组件注册表，
  我方探针用的是 `render`，可能需要在逐页指导阶段改用运行时的组件绑定方式）。
  **这不阻塞 P0/P2**：三个业务页面按 U4 由用户逐页指导时一并确定绑定方式。
- **附带发现**：探针会话在页面会话列表中可见（含 `proj-c`、`Count bash outpu…` 等），说明**同运行时内会话驱动确实对网页实时可见**（印证 D 方案的核心前提）。
- **证据文件**：`evidence/activation.jsonl`（client 回调）、`evidence/e08-oneshot.json`、`evidence/e08-cancel.json`。

#### T-P0-12 E-09 原生输入协调与页面关闭（X9）【in_progress：页面关闭已验；U14 交互约定待你实机确认】
- **目标**：验证 U14 约定（执行中输入不可发送、输入框有暂停 AWF 按钮、暂停且响应结束后可介入）；关闭页面不影响后台生命周期。
- **依赖**：T-P0-05（E-02）。

**A. 关闭页面是否影响后台运行 —— 实测通过**
- 实验：宿主侧起一个真长任务（`/api/awf-probe/longrun`，prompt 要求调用 `bash: sleep 30`），
  期间浏览器**不在该会话页**（停留在 landing 页）；由**宿主侧**轮询会话状态（独立于浏览器）。

| 时点 | 会话状态 | 说明 |
|---|---|---|
| T+5s（页面未打开该会话） | `status=running`，`seq=24` | 后台在跑 |
| T+12s（浏览器在 landing 页） | `status=running`，`seq=24`，`lastEvents` 含 `tool/call`、`approval/asked` | 仍在跑，且已发出工具调用 |
| T+35s | 同上（停在 `approval/asked`） | 后台**没有**因页面不在而停止 |

→ **结论：后台运行不依赖浏览器页面打开**（与 spec §2 边界 6 一致）。会话状态由宿主侧可查，与页面无关。

**B. 一个必须解决的真实阻塞（新发现，记为 F34）**
- 该任务卡在 `approval/asked`：web 组合下 `permission-presets` 默认 `workspace-write + approval: ask`，
  子会话执行 `bash` 需要**人工批准**。页面上没人点、宿主也不代批 → **无人值守的 run 会永久停在待批准**。
- **影响**：这不只是 UI 问题 —— AWF 的 `run` 是无人值守执行；如果每个 worker 的 bash/write 都要人批，主链路走不通。
- **待决策（列入下轮或与 U14 一并确认）**：DSH 侧的 approval/authorization 策略应由 AWF 配置为**受控自动批准**
  （例如仅对 AWF 自己创建的会话放行、或按项目白名单），还是保留人工批准但把它接入 AWF 的决策/介入机制。
  这属于「既定要求无法同时满足」之外的新范围问题，**先记录证据，不擅自改权限策略**。

**C. U14 交互约定（执行中输入禁用、暂停 AWF 按钮、响应结束后介入）—— 待你实机确认**
- 这几条是**页面交互行为**，需要你按 U14 的约定在真实页面上确认；本轮不替你判定已达成。
- 与实现相关的落点已知：输入框右侧 slot（`conversation.input.right`，本轮 client 半侧注册成功，见 E-08 B），
  AWF 暂停按钮与「执行中输入禁用」将落在这里；AWF 侧的暂停闸门已有（`server/features/pause/index.js`）。
- **不处理**（已定）：直接点击原生 stop 属非正常操作，本轮不做。

- **证据文件**：`/tmp/awf-dsh-probe/evidence/e09-start.json`、`longrun` 路由状态输出（见上表）、
  `evidence/activation.jsonl`（client 回调）。

#### T-P0-13 E-10 安装/卸载/技能命令/发布包（X8）【done（含 1 项实测阻塞）】
- **目标**：干净环境安装/卸载、技能与命令挂载、link 与发布包差别、状态读取返回体大小。
- **依赖**：T-P0-05。

**A. 技能发现（实测：当前组合下不可用，原因明确）**
- 实验：在目标项目放 `.dsh/skills/awf-demo-skill/SKILL.md`（DSH 的项目技能根，`dsh-skill-filesystem/lib/index.js:150-160` 确认根路径），
  再经 `/api/awf-probe/skills` 调 `ctx.skills.list({cwd})` / `get(name,{cwd})`。
- 结果：装了技能的项目 `count=0`、`get` 返回 `null`；未装技能的项目同为 `count=0`。
- **原因（与 F18/F32 同源）**：web 组合把 `skill-filesystem` 与 `tool-skill` 的 host 行 `disabled: true`，
  改由 **agent preset 的 standing scope** 提供；而探针的 preset 挂载在工具/贡献层面无效（F32 已证 `tools.restrict` 也看不到它）。
  → 技能不是「坏了」，而是**归属 agent 平面**，本实验的作用域取法看不到。
- **对 P2 的要求**：AWF 资产（`plugin/plugin-code/skills`、`plugin/core/skills`）在 DSH 下的挂载必须走 **preset 平面**
  （与 `standard/agent.cordis.yml` 里 `skill-filesystem` 同层），或提供项目级 `.dsh/skills` 投影（把 AWF 技能按项目投影过去）。
  不能假设「全局放一个根目录就能被发现」。这条列入 T-P2-01。

**B. 状态读取返回体大小（spec §2.1 的独立待办，实测已确认是问题）**
- 造 305,051 B 的 `state.json`（400 任务 + 200 WBS 项），直接对 `awf-state` MCP server 发 `tools/call`：

| 调用 | 返回体 |
|---|---|
| `awf_read_state`（默认） | **346,279 B 文本** / **367,181 B 原始 JSON-RPC 响应**（≈ state.json 的 1.2 倍） |
| `awf_read_state({taskId:'T-1'})` | **747 B**（单任务读取是有效的收敛手段） |
| `awf_read_state({summary:true})` | **346,279 B** —— **`summary` 参数不被支持**，静默返回全量 |

- **结论**：① 默认全量读回体积随 state 线性膨胀；DSH 的 `maxInlineBytes: 50000`（spill 机制）下，
  ~40KB 以上的 state 就会以「落盘文件路径」形式进模型上下文（旧 spike 的现象在本轮复现，属**确认**非新发现）。
  ② **`summary:true` 是静默忽略参数**，这会误导调用方以为已经收敛。③ 单任务读取可用且很小。
- **待办（P2 前必须做，属 C30「状态读取需有边界」）**：给 `awf_read_state` 增加**真正的**摘要模式
  （默认只回 `version/mode/plan 摘要/任务 id+status 计数/当前 active 任务`），全量改为显式 `full:true`；
  并把 `summary` 这类未知参数改为**报错**而不是静默忽略（U6「明确失败」原则）。

**C. 本项未完成（明确登记）**
- 干净环境**安装/卸载**的发布包验证（`npm pack` → 目标目录 → 插件装配 → 卸载）未做：需要 pnpm（F13）与一次完整遍历。
- 命令（slash command）挂载未验：与技能同属 agent 平面（preset），结论同上 A。
- link 与发布包差别：E-02 已证 `link:` 可用；发布包形态（拷贝而非软链）未复跑。
- 以上三项与 F13/F18 的结论合流，留给 **T-P2-01** 与 **T-P4-02**（交付前必须复跑）。

- **证据**：技能判定来自 `/api/awf-probe/skills` 的实测响应；返回体大小来自直接 stdio 调 `plugin/core/mcp/awf-state/server.cjs` 的原始字节数。#### T-P0-14 E-11 恢复与失联（T2/T3 / U3）【done（核对完成）；`-r` 行为修复留给 P1】
- **目标**：核对现有 `run -r` 行为、给出最小恢复范围；失联必须进入执行器等待处理，不能永久 busy。
- **依赖**：无（CC 侧自带，可在 DSH 接入前独立核对）。

**核对一：`run -r` 的真实行为（静态 + 代码路径级验证）**

| 事实 | 证据（本仓代码，行号为当前树） |
|---|---|
| `-r` 与 `--attach` 在环境准备阶段都复用了现场 | `cli/commands/run.cjs:116` `bringUp(ctx,{reuseExisting: connectionMode!=='fresh'})` |
| **只有 `--attach` 会先查询活跃 run 并只订阅** | `run.cjs:125-135`：`runSnapshot()` → 找 `running|queued` → `observe(...)` → `return` |
| **`-r` 没有这个分支**：它落到 `submitRun` | `run.cjs:136-141`（`-r` 走这一行，与 fresh 完全相同） |
| 单槽宿主会拒绝第二个 submit | `server/run/host.cjs:465-468`：`hasActiveRun()` → `{ ok:false, error:'宿主正在驱动 run …' }`；同 runId 也会被拒（`:462-464`） |
| host 的 run 记录/事件环是**内存** Map/数组 | `host.cjs:143`（`activeRunId`）、`:146-149`（`runs` Map、`eventRing` 数组） |

- **结论**：帮助文案「活跃 run 挂接续观」在 `-r` 分支**未实现**（与 spec §5 的静态结论一致）。
  现场表现：`awf run -r` 在已有活跃 run 时会因 409 失败，而不是挂接上去看。
- **失联**：`server/runtime/executor.cjs:88-98` —— `session.state==='busy'` 时 `idleSince=null`，**不计时**；
  因此对端失联但状态仍停在 busy 时会**无限等待**。这正是 T3 描述的问题，且**与平台无关**（CC 同样受影响）。
- **`-r` 的最小恢复范围（U3 已确认采用）**：把 `-r` 改为「先查询活跃 run → 有则挂接（与 `--attach` 同路径）；无则按现状提交」，
  **不**新增通用崩溃恢复，**不**自动重置 `active` 任务。
- **修复推迟到 P1 的理由**：该分支的等价改造与 T-P1-01/T-P1-03（CLI 直连收口、`session` 端口转正）在同一批文件上，
  合并改动可避免同文件二次返工，也便于一次把 `-r`/`attach` 行为同时纳入契约测试。记录为 **T-P1-06**。
- **本轮不做**：不改 `cli/commands/run.cjs`（P0 纪律：不先动 CC 公共契约，也不制造未验证的中间态）。

**核对二：失联要进入执行器等待处理（设计边界，已确认方向）**
- 判据分开：**连接事实**（通道是否可达）与**任务恢复**（是否继续跑）不是同一件事（U3/T3 已定）。
- 失联时的最小行为：**停止新增派发**并显示失联；无法核实执行结果时保留现场，不做盲目重发。
- 未知结果不得显示为成功（U3 底线）。
- 具体实现落在 P2/P3（依赖 DSH 侧 adapter 与桥接），本轮只固定边界。

**证据**：以上均为本仓代码路径核对（行号见上）；无新增长跑实验。DSH 侧的「插件退出/运行时不可达」场景留到 P2 桥接可用后实测（列入 T-P2-01 验收）。### 2.3 P1 及以后（保留清晰边界，暂不细化）

| 编号 | 阶段 | 边界（做什么 / 不做什么） | 状态 |
|---|---|---|---|
| T-P1-01 | P1 | `ports.cjs` 按项目解析 adapter + `ccShapes`→`shapes` 去 CLI 化；**不改**调度算法 | **done**（2026-09-19，见 §2.4） |
| T-P1-02 | P1 | `ctx.tmux` → `ctx.host` 能力化；`ENTER_DELAY_MS` 下沉进 cc 实现 | **done**（与 T-P1-03 同批，见 §2.4） |
| T-P1-03 | P1 | `cli/lib/session.cjs` 5 处 tmux 直连 + `attach.cjs` 收口；`session` 端口转正 | **done**（见 §2.4） |
| T-P1-04 | P1 | 编排模板迁入 server（模板与平台参数分离）；技能/worker/决策资产保持单源 | **done**（见 §2.4） |
| T-P1-05 | P1 | 测试分层：编排层 CLI 无关 + conformance 套件 + 契约自检（可执行必填方法名断言） | **done**（见 §2.4） |
| T-P1-06 | P1 | **`run -r` 最小恢复修复**（把「查询活跃 run 并挂接」补进 `-r` 分支，与 `--attach` 同路径；不新增崩溃恢复、不自动重置 active）；提为显式公共行为修复（U3 已确认） | **done**（见 §2.4） |
| T-P2-01 | P2 | `server/adapters/dsh/` awf 侧 + 插件 host 半侧：WS 指令下行 + HTTP 回传 | pending |
| T-P2-02 | P2 | init/plan/run 的 DSH 接线（后台全局单实例、新建规划会话注入、run 新建执行会话） | pending |
| T-P3-01 | P3 | batch 走 DSH 原生子 Agent + 结果归属校验（旧结果不覆盖新执行） | pending |
| T-P3-02 | P3 | 决策/上下文/观测在 DSH 下的接线；`run -r` 最小恢复行为 | pending |
| T-P4-01 | P4 | 三个业务页面**空页面** + 项目/无会话入口（U4，后续逐页指导） | pending |
| T-P4-02 | P4 | 干净环境安装/卸载/升级；能力矩阵区分「占位」与「完成」 | pending |

#### T-P1-02 首次试改记录（2026-09-18，**已回滚**——历史保留）
- 试改内容：`server/runtime/project.cjs` 注入键 `tmux`→`host`；生产侧 20 处 `ctx.tmux.*`→`ctx.host.*`；测试替身键 `tmux:`→`host:`。
- 结果：**115 例测试失败**（5 个文件）。原因：测试替身被**跨变量名引用**——`tests/integration/server.test.js` 用
  `global.__CC_TMUX__ = m.tmux` 与 `m.tmux.hasSession`，`tests/unit/server-layering.test.js` 断言 `rt.ctx.tmux.hasSession`；
  只改注入键、不改这些引用，替身取不到。
- 处置：**按 P1 纪律回滚**（CC 必须可用），回到 `107/108 文件、1005/1009 用例`（仅 4 例无 `claude` 的环境性失败）。
- 结论与后续：2026-09-19 按本记录的范围**一次做完**（生产 6 文件 + 测试 5 文件 + `global.__CC_TMUX__`→`__CC_HOST__` +
  `tmuxFactory`→`hostFactory` + 替身键与断言同改），并与 T-P1-03 同批提交，一次通过。
- 另附：`.awf/probe` 探针夹具**不进 git**（已确认未跟踪），全部内容随 `/tmp/awf-dsh-p0-handoff.tar.gz` 转移。

### 2.4 P1 完成记录（2026-09-19，CC 基线收口）

P1 六项全部收口；每个提交都满足硬门槛：`npm test` 全绿 + `npm run check:arch` + `npm run check:capability` + `npm run lint`。

| 任务 | 提交 | 交付物（可核查的落点） |
|---|---|---|
| T-P1-01 | `093fea3` | `ports.cjs`：`ADAPTER_PLATFORMS` + `resolveAdapterName` / `resolveProjectAdapters`（读 `.awf/config.json` 的 `runtime.adapter`，`CC_ADAPTER` 可覆盖，未知/未落地显式抛错并点名责任任务）；`ccShapes`→`shapes`；cc 依赖清单下沉 `cc/checks.cjs`；`ctx.adapter` / `ctx.adapters` |
| T-P1-02 | `499b58e` | `ctx.host` 能力面 + `host.sendPrompt`（`ENTER_DELAY_MS` 下沉进 `cc/host.cjs`）；注入缝 `__CC_HOST__`、参数 `hostFactory`、替身键与断言同批迁移 |
| T-P1-03 | `499b58e` | `server/adapters/cc/session.cjs`（exists/cwd/start/kill/nudge/attach）；`cli/lib/session.cjs` 与 `attach.cjs` 零 tmux 直连；`session` 端口 `not-landed`→`factory`，7 端口全部收口 |
| T-P1-04 | `ef1e286` | `server/templates/prompts.json`（9 条编排模板）+ 插件 `platform-vars`；`prompts.js` 按 key 分流；golden fixture 逐字节守卫迁移不改产出 |
| T-P1-05 | `ec92a50` | `tests/conformance/adapters.conformance.test.js`（按已落地平台跑同一套契约断言）+ `REQUIRED_PORT_METHODS` / `assertRequiredMethods()` 加载即自检 |
| T-P1-06 | `e7074ec` | `attachActiveRun()` 抽公共路径；`run -r` 有活跃 run → 挂接不重复提交，无 → 照常提交；不新增崩溃恢复、不自动重置 active |

**P1 硬门槛达成口径**（本机，2026-09-19）：`npm test` 110/110 文件、1043/1043 用例通过（含 `claude` 在本机 PATH 上）；
`check:capability` ✓；`check:arch` ✓；`lint` ✓；`build` ✓。

**P1 明确未做（避免误读）**：
- 未新增 `server/adapters/dsh/`（平台注册表里 `dsh` 仍 `not-landed`，解析入口会显式报错）——这是 P2。
- 未改任何调度算法（scheduler / driver / 配额 / 门禁闭环），与 C34 的边界一致。
- 未做通用崩溃恢复与 active 自动重置（T-P1-06 只做最小挂接，U3 边界）。
- 未在真机 DSH 上复跑（P1 是 CC 基线阶段；DSH 侧从 P2 开始）。

### 2.5 P2 前置核对（2026-09-19，只读源码；本机 `dsh` 0.1.5-rc.1 启动器 + 内部包 0.1.5-rc.2）

P2 开写之前先把「已定位的落地机制」逐条对回本机安装包源码（`~/.nvm/.../node_modules/@deepseek-ai/dsh`）。
**这是静态核对，不是实测**；结论里标了「待实测」的项必须在 P2-5 用真运行证明。

**A. 已确认的 API（签名级）**

| 能力 | 确认结果 | 证据 |
|---|---|---|
| 会话内批准策略 | `ctx.approval.request({agent, toolName, callId, reason?, signal})` → `'allowed-once' \| 'rejected' \| 'cancelled' \| 'unavailable'`；**`allowed-once` 是唯一授权** | `dsh-user-approval/lib/index.js:127-146` |
| 批准应答者（answerer） | `ctx.waterfall(scope, 'approval/request', req, () => 'unavailable')`；应答者**按 agent 作用域分发**（`dsh-scope` 的取值函数就是 `args[0].agent`） | `dsh-user-approval/lib/index.js:175-192`、`dsh-scope/lib/invariant.js:23` |
| 注册应答者的写法 | `ctx.on('approval/request', (request, next) => …)`；返回结果即认领，`next()` 委派给下一个应答者 | `dsh-acp/lib/index.js:1115` |
| 批准策略取值 | **只有 `ask` / `never` 两个**；`never` 在**应答者之前**短路为 `'rejected'` —— 即 `never` = 自动**拒绝**，不是自动批准 | `dsh-user-approval/lib/index.js:37,74,178` |
| 权限预设表（默认） | `workspace-write` = `sandbox: workspace-write` + **`approval: ask`**；`danger-full-access` = `danger-full-access` + `approval: never` | `dsh-permission-presets/lib/index.js:80-90` |
| 预设切换 | `ctx.permissionPresets.set(session, name)` / `apply(session, name, setApproval)` | `dsh-permission-presets/lib/index.js:274` |
| 建会话后的完整组合 | `agents.create({…})` + `installModelSelection(agentCtx, {current, assembled})` + `agentPresets.mount`（F19 的配方在 `dsh-headless/lib/index.js:134-142` 可对照） | 同上 |
| 插件 HTTP 路由 | `webServer.register({kind, path, handler})` + 另有 `registerUpgrade(route)` / `registerFallback(handler)` / `tapIndex(transform)` | `dsh-host-webserver/lib/index.js:157-250`（upgrade 在 `:190`） |

**B. 与已确认决策的冲突（必须回报，不自行降级）**

`U16` 记录里写的「落地机制」是：`ctx.permissionPresets.set(session, 'workspace-write')`，并声称
「该预设 = `sandbox: workspace-write` + `approval: never`」。**源码核对不支持这个等式**：
0.1.5-rc.2 的默认预设表中 `workspace-write` 的 approval 是 **`ask`**，只有 `danger-full-access` 才是 `never`。
因此按原记录接线**不会消除** F34 的 `approval/asked` 卡死；而改用 `danger-full-access` 又等于放弃沙箱，
与「项目外仍需人工」相悖。**两者都不满足 U16「受控自动批准」**。

**C. 可满足 U16 的候选路线（待 P2-5 实测）**

1. **注册 AWF 自己的批准应答者**（推荐）：会话仍用 `workspace-write` 预设（沙箱边界保留），
   插件在**AWF 创建的 agent 作用域**内 `ctx.on('approval/request', …)`：项目范围内的请求回
   `'allowed-once'`，范围外 `next()` 委派（→ UI/人工，无应答者时 fail closed）。
   这正是 U16「AWF 自己创建的会话在项目范围内自动批准、项目外仍需人工」的语义，且用到的是平台原生应答者缝，不是绕过沙箱。
2. 走 `danger-full-access` 预设：不推荐——沙箱同时消失，等于用「全局放开」换「不卡」。若最终只剩这条路，
   必须在清单里改记范围并让用户重新确认，不能默默采用。

**D. 通信通道的既有约束复核**

AWF 的 `server/web/ws.cjs` 自述「只做服务端→客户端推送，未实现掩码解码/分片；一旦要支持客户端上传必须补齐」。
结合 spec §2（指令下行用独立 WS、回传用 HTTP POST），P2 的落点定为：**AWF 是 WS 服务端，插件 host 半侧是 WS 客户端**；
插件→AWF 的**送达确认与结果走 HTTP POST**（与既有 hook 回传同一形态），因此 AWF 侧的 WS 仍保持单向，
不需要为了 P2 去补掩码/分片。命令需带 `commandId`，超时未确认记为「无法确认」而不是「已送达」。

**E. 本机环境事实（换机后需重核）**

| 项 | 本机实测 | 影响 |
|---|---|---|
| `dsh` 可执行 | `/Users/shangjunhao/.nvm/versions/node/v24.14.1/bin/dsh`，`--version` = **0.1.5-rc.1** | 与 P0 记录的 0.1.5-rc.2 基线一致（launcher 与内部包版本号本就不同） |
| 真实 `~/.dsh` | 存在 `profiles/`（含 `web`）、`sessions/`、`storages/`、`settings.yaml`；用户 `dsh web` 正在 127.0.0.1:3080 运行 | **P2 实验一律隔离 `DSH_HOME`；不动真实 home** |
| 隔离探针 home | `/tmp/awf-dsh-probe` **不存在** | P0 的探针夹具已丢失且 `.awf/probe/` 不在 git → **必须先按 §5 重建**（P2-3） |
| `pnpm` | 仍需确认（P0 机器没有） | 无 pnpm 时走离线等价装配（F13） |

### 2.6 P2-3 完成记录（2026-09-19，隔离探针重建，**已纳入 git**）

P0 的探针夹具原本在 `.awf/probe/dsh/`（`.awf/` 被 gitignore），换机时丢失。P2-3 重建并**改放
`scripts/probe/dsh/`（进 git）** —— 夹具是可复现证据的一部分，不该随 `/tmp` 消失。

| 文件 | 作用 | 实测状态 |
|---|---|---|
| `env.sh` | 强制 `DSH_HOME=/tmp/awf-dsh-probe` + 指向真实 home 时报错；凭据符号链接；`profiles/node_modules` 只读复用真实 home 那份（本机无 pnpm） | ✓ |
| `guard.sh` | 真实 `~/.dsh` **配置面**指纹（snapshot/check），含 `profiles/node_modules` 顶层清单哨兵 | ✓ 实验后 `IDENTICAL` |
| `install-fixture.sh` | 离线装配：建 profile（`dsh-base`+`dsh-web-app` 两层 bundle）+ 符号链接插件 + 写 patch 层 | ✓ 幂等 |
| `serve.sh` | 静默起停：`dsh --profile awf-probe --port 39081 --no-open`（**不能用 `dsh web`**，见 F37） | ✓ `[serve] ready` + token URL |
| `fixtures/probe-plugin/` | Cordis host 半侧探针（ESM；`name`/`inject`/`apply`） | ✓ `/api/awf-probe/ping` 200 |

**已验证的真实运行证据**（隔离 `DSH_HOME`，真实 `~/.dsh` 配置面 `IDENTICAL`）：
- 探针后台**静默**起来（无浏览器弹窗），监听 39081，日志打印带 token 的 URL；
- `GET /api/awf-probe/ping` → 200 `{ok:true, plugin:'awf-probe-plugin', dshHome:'/tmp/awf-dsh-probe', profile:'awf-probe', pid, startedAt}`；
- 同实例鉴权对照：`/`=401、`/api`=401、`/api/sessions`=401、`/api/awf-probe/ping`=**200**、`/nonexistent-xyz`=404
  → **新增 F36（插件路由不受栅栏保护）**，这条直接改 P2 的 Web 入口设计；
- `/api/awf-probe/services` → **501 + 明确原因**（`ctx.root` 取不到服务表；不返回空清单冒充结果），
  能力面枚举待 P2-4 用 cordis `reflect` 重取（`cordis/lib/index.js:727`）。

**未做（明确登记）**：client 半侧（浏览器 entry / 业务页面）未重建 —— U4 的三个空页面属 P4；
本阶段只需要 host 半侧驱动会话。

### 2.7 P2-4 完成记录（2026-09-19，DSH 适配器 AWF 侧 + 指令通道，**替身级验证**）

**范围口径**：本轮交付的是 **AWF 侧的适配器与通道协议**；DSH 插件 host 半侧与真实链路在 P2-5。
所以 `ADAPTER_PLATFORMS.dsh.status` **保持 `not-landed`**（`resolveProjectAdapters` 继续显式拒绝 dsh 项目）
—— 结构就绪 ≠ 可用，不装成功。

| 交付 | 落点 | 说明 |
|---|---|---|
| 指令通道（传输无关） | `server/adapters/dsh/bridge.cjs` | 三种送达结论：`not-delivered`（未交给平台）/ `unconfirmed`（发了但无回执，**不等于失败**）/ `accepted`（已交给平台）；ack 与 result **两段窗口**；断开时在途指令一律判「无法确认」且**不自动重发**；事件上行分发；平台事实（含版本）缓存 |
| 7 端口实现 | `server/adapters/dsh/index.cjs` | host/session/probe/hook/oneshot/tooling/interactive 全部经通道发指令；`must()` 把三态与平台报错变成**显式异常**；cc 机制方法（`spawnClaudeP`/`claudePArgs`/`claudeAvailable`/`build*`）**显式 unsupported** 抛错，不静默返回假值 |
| 传输接线 | `server/web/bridge-channel.cjs` + `api/index.cjs` | WS 升级 `/bridge/dsh`（插件连上即 `attach`）+ `POST /bridge/dsh/callback`（accepted/result/event 回传；未知 commandId 回 `consumed:false` 并告警）；回传入口挂在 `PROJECT_AGNOSTIC_WRITES`（一个 DSH 后台服务多项目，不需要 `?p`） |
| 契约收窄 | `ports.cjs` 的 `REQUIRED_PORT_METHODS` | 把 cc **机制**方法从「必填」里拿掉（`spawnClaudeP`/`claudePArgs`/`claudeAvailable`/`build*`/`nudge`）：它们是 cc 的实现形状，不是平台无关能力。必填 = 任何平台都必须有且上层真会调的那批 |
| 一致性覆盖 | `tests/conformance/adapters.conformance.test.js` | 判据从「status==='factory'」改为「**有工厂**（create 是函数）」——dsh 结构面自动纳入；`status!=='factory'` 时断言**必须显式拒绝**（把「不装成功」也纳入门禁） |

**验证（替身级，明确不是 DSH 可用性证据）**：`tests/unit/dsh-bridge.test.js`（13 例，三态/两段窗口/幂等/断开/事件）、
`tests/unit/dsh-adapters.test.js`（31 例，端口↔指令映射/三态不被吞/cc 机制方法显式不支持/probe 四态/事件映射/依赖检查）、
`tests/unit/dsh-bridge-channel.test.js`（7 例，真实 WS 帧编码 + 回传 + 断开）、
`server-api-routes.test.js` 新增 3 例（回传路由 200/400/未消费告警）。
全量 `npm test` **113/113 文件、1105/1105 用例**；`check:capability` / `check:arch` / `lint` 全绿。

**下一步（P2-5）**：插件 host 半侧（`createSession`+preset+MCP 挂载+批准应答者 / `prompt(req,signal)` / `whenIdle` /
`subagents.interrupt` / `ctx.llm.stream`）实现本协议并在**隔离探针**上跑最小真实链路；届时才把 `dsh` 转 `factory`。

### 2.8 P2-5a 完成记录（2026-09-19，**真实链路**：AWF ↔ DSH 插件 指令通道）

本轮把 P2-4 定的协议在**真 DSH 进程**里跑通（真 WS 下行 + 真 HTTP 回传），
并用一条未实现的 op 验了错误路径。**尚未派模型**（省额度）：建会话/派发/落账留 P2-5b。

| 交付 | 落点 | 说明 |
|---|---|---|
| 生产插件（host 半侧） | `dsh-plugin/`（index.js + lib/bridge-client.js + lib/ops.js） | Cordis ESM 插件：连 AWF 的 WS `/bridge/dsh`，收指令 → **先回 accepted 再回 result**；断线按退避**重连不重放**；平台事件经 `{kind:'event'}` 上行；未实现的 op **显式失败**（带 P2-5b 指引），不冒充成功 |
| op 面（本轮） | `session.facts` / `session.nudge` / `session.open` | facts 读平台 `ctx.sessions.list()`（身份 = `header.cwd` + `header.id`）；`ready` 用插件自己的「有无回合在跑」事实；`llm.oneshot` 已按 `ctx.llm.stream` 写好但**标 unverified**（未实测） |
| 夹具接线 | `scripts/probe/dsh/install-fixture.sh` | 隔离 profile 现在同时装**探针插件**与**生产插件**（符号链接，改源码即时生效） |
| 真实链路夹具 | `scripts/probe/dsh/roundtrip.cjs` | 起进程内 AWF（隔离临时项目 + 空闲端口）→ 起隔离 DSH（注入 `AWF_DSH_BASE`）→ 等插件连上 → 发真指令 → 断言回执；退出码即结论 |

**真实运行证据**（`node scripts/probe/dsh/roundtrip.cjs`，2026-09-19，本机）：

```
[roundtrip] AWF server 起于 http://127.0.0.1:55973（隔离临时项目）
[roundtrip] ✓ 插件已连上（platform=dsh, pluginVersion=0.0.1）
[roundtrip] ✓ session.facts 回执：{"sessionExists":false,"reachable":true,"ready":false,
                                  "cwd":null,"sessionId":null,"snapshot":null}
              → delivery=accepted, ok=true
[roundtrip] ✓ 未实现 op 明确失败：op "session.create" 尚未实现（P2-5b）…
              → delivery=accepted, ok=false（错误路径不静默）
[guard] check → IDENTICAL（真实 ~/.dsh 配置面零改动）
```

口径说明：`sessionExists:false` 是**对的** —— 隔离 home 里确实还没有 AWF 建的会话；
这条恰好证明 facts 来自平台真实现场，而不是写死的常量。

**仍未做**：见 §2.9（P2-5b 第一段已接走 `session.create` / `interrupt` / `stop`）。
`dsh` 继续 `not-landed`，`resolveProjectAdapters()` 继续显式拒绝。

### 2.9 P2-5b（第一段）完成记录（2026-09-19，**真实运行**：会话创建 / 停止，未派模型）

| 交付 | 落点 | 说明 |
|---|---|---|
| `session.create` | `dsh-plugin/lib/ops.js` | `ctx.get('sessionController').create({ cwd, agentPreset? })` —— DSH 侧一次完成「建会话 + 模型选择 + preset 装载」（F19）；创建出的会话 id 登记进 `createdByAwf`（供 U16 判断「这是不是我们的会话」）；上报 `session.started` 事件 |
| `session.interrupt` | 同上 | `sessionController.cancel({ sessionId })`；平台固定 `keepInbox:true` —— 回执 ≠ 已停（E-06） |
| `session.stop` | 同上 | cancel 主会话 + **逐个** `subagents.interrupt(childSessionId)`（按 `header.parentSessionId` 找子）；**不删会话、不关共享后台**（spec §2 边界） |
| U16 批准应答者（**只记录 + 委派**） | `dsh-plugin/index.js` | `ctx.on('approval/request', (req, next) => …)`：记录 `toolName`/`reason`/是否 AWF 会话并上报 `approval.requested` 事件，然后 `next()` 委派（不自动批准）。**定策略前先测清「workspace-write 下什么操作真的请求批准」** —— 在没测清之前自动批准可能把沙箱边界一起放开 |

**真实运行证据**（`node scripts/probe/dsh/roundtrip.cjs`，2026-09-19，隔离 DSH + 隔离 AWF，**未派模型**）：

```
✓ 插件已连上（platform=dsh）
✓ session.facts(建会话前)：{"sessionExists":false,…}
✓ 未实现 op 明确失败：op "session.snapshot" 尚未实现（P2-5b）…（delivery=accepted, ok=false）
✓ 会话已创建：session-118c8852-026a-415c-a7a5-67362e3f426a（preset=standard）
✓ facts 已反映该会话（sessionExists=true, cwd=<临时项目>）
✓ 已停止且会话仍在（cancel keepInbox，未删会话）：{"sessionId":"session-…","cancelled":true,"subagents":[]}
[guard] check → IDENTICAL（真实 ~/.dsh 配置面零改动）
```

**口径**：`session.stop` 后 facts 仍是 `sessionExists:true` 是**期望行为**（停止 ≠ 删除；spec §2 明确不得顺带删对话）。

### 2.10 P2-5c 完成记录（2026-09-19，**真实运行 + 真派一轮模型**：提交/回执与回合结束）

| 交付 | 落点 | 说明 |
|---|---|---|
| `session.prompt` | `dsh-plugin/lib/ops.js` | `sessionController.prompt({sessionId, content:[{type:'text',text}], requestId}, signal)` —— **signal 是第二位置参数**（F26）；`requestId` 用 AWF 的 commandId（平台按它去重，补发不会变两轮）。返回 `accepted` 即「**平台受理**」，不含「任务完成」 |
| 回合边界上报 | `dsh-plugin/index.js` 的 `createTurnReporter` | `ctx.on('session/event', …)`（firehose）捕 `turn/start|end`：只报 **AWF 自己创建的会话**；`turn/start → turn.started`、`turn/end → session.ready`（+ facts 刷 ready）。**受理回执与回合结束是两件事，分开上报** |

**真实运行证据**（`node scripts/probe/dsh/roundtrip.cjs --prompt "只回复两个字：收到。不要调用任何工具。"`，
隔离 AWF + 隔离 DSH，**真派一轮模型**）：

```
✓ 会话已创建：session-45c5b527-…（preset=standard）
✓ 已停止且会话仍在（cancel keepInbox，未删会话）
✓ 平台已受理（accepted=true）；等回合结束…
✓ 回合结束：events=["turn.started","prompt.submitted","session.ready"]
   证据：session.facts(回合结束后).ready === true
[guard] check → IDENTICAL（真实 ~/.dsh 配置面零改动）
```

**口径**：「平台受理（accepted）」与「这一轮结束（session.ready）」在本轮被**分开观测**到了 ——
这正是 spec §6「不把『已发送』『已受理』『已完成』混用」在 DSH 侧的落地。

### 2.11 P2-5d 完成记录（2026-09-19，**P2 核心出口条件打通**：会话级挂 MCP + 真落账）

| 交付 | 落点 | 说明 |
|---|---|---|
| 建会话＝完整配方 | `dsh-plugin/lib/ops.js` 的 `session.create` | 改走 `agents.create({sessionId, meta:{cwd}, agentOptions, setup})`：在 **agent 发布前的 setup 窗口**里 ① `installModelSelection` ② `agentPresets.mount(agentCtx, 'standard')` ③ `agentCtx.plugin(McpClient, …)` 挂项目 MCP。`sessionController.create` **没有 setup 窗口**，挂上去的工具进不了会话工具表（实测 0 个工具） |
| 项目 MCP（C30） | 同上 `mountMcpInto` | 每项目各起一份 stdio MCP（`plugin/core/mcp/<name>/server.cjs`），把自己的 `AWF_PROJECT_ROOT` 传给子进程 —— 项目隔离不靠共享全局配置 |
| 工具表核对 | 新增 `session.tools` 指令 | 报 `session.requestHeader().tools`（模型可见工具表）。**只在首次模型请求之后才有值**：header 是 `request/header` 事件的折叠，建会话时恒为 undefined —— 这解释了为什么「建会话时等工具注册」不可行（F29 的核对点必须在首次派发之后） |
| 离线依赖装配 | `scripts/probe/dsh/install-fixture.sh` | 把 `@deepseek-ai/dsh-mcp-client`、`@deepseek-ai/dsh-agent` 从真实 home 的 hoisted node_modules **符号链接**进 `dsh-plugin/node_modules`（本机无 pnpm）；缺了插件会**明确报错**，不静默不挂 MCP |

**真实运行证据**（`node scripts/probe/dsh/roundtrip.cjs --task`，隔离 AWF + 隔离 DSH，**真派一轮模型**）：

```
✓ 会话已创建：session-7c7e13e2-…（preset=default，已含模型选择 + preset + MCP）
✓ 平台已受理（accepted=true）；等回合结束…
✓ 回合结束：events=["turn.started","prompt.submitted","session.ready"]
✓ MCP 工具已进可见工具表：20 个 mcp__awf-state__*（read_state / task_complete / dynamic_plan …）
✓ 经 AWF MCP 工具真落账：T1.status=done（磁盘 state.json 的 exec.completedAt 已写）
[guard] check → IDENTICAL（真实 ~/.dsh 配置面零改动）
```

**含义**：spec §7 的 P2 出口条件里，「项目 MCP / 会话创建 / 提交回执 / 任务落账 / 快照（facts）/ 运行停止」
**除快照投影外全部有真实运行证据**；这也同时验证了 C17/C19/C36 的**公共落账语义**在 DSH 侧成立
（模型经 MCP 工具写的是 AWF 的 state.json，不是平台侧另存一份）。

### 2.12 P2-5e（第一段）完成记录（2026-09-19，**真实运行**：可读快照 + U16 取证）

| 交付 | 落点 | 说明 |
|---|---|---|
| `session.snapshot`（C25） | `dsh-plugin/lib/ops.js` | 取会话日志里**最后一条 `assistant/message`** 的 `text` 块（`data.message.content` 是 ContentBlock[]，只取 `type==='text'`）；可 `maxChars` 截断并标 `truncated`；没有助手消息时回 `text:null` + 原因，**不编内容** |
| U16 取证（**结论改变了做法**） | 同上 + 批准应答者 | `--bash` 实验：让模型用 bash 在项目内跑 `pwd` → **零批准请求**，命令正常返回 |

**U16 实测结论（重要）**：在 `workspace-write` 预设下，**项目内的普通 bash 不会请求批准** ——
沙箱本身就 auto-allow 项目内操作，只有**越出沙箱**的操作才需要批准（预设描述即 "wider retries require approval"）。
所以：

- U16 说的「AWF 自己创建的执行会话在项目范围内自动批准」**已经由沙箱满足**，**不需要**再加自动批准规则；
- 「项目外仍需人工」= 保持现在的**只记录 + 委派**（无应答者时平台 fail closed，即拒绝）——既守住了沙箱，
  也没有把无人值守的主链路卡住；
- 这也修正了 P0 F34 的解读：`approval/asked` 卡死**不是**普通项目内 bash 的必然结果（P0 那次是另一种建会话路径的子会话）。
- **仍待验证**：子 Agent 会话里的 bash（子会话是否继承同一策略）—— 留给 P2-5e 余下。

**真实运行证据**（两次，真派模型；隔离 AWF + 隔离 DSH）：

```
$ node scripts/probe/dsh/roundtrip.cjs --bash
✓ 快照："/private/var/folders/…"          ← 模型 bash pwd 的真实输出
✓ 本轮无批准请求（workspace-write 下的普通 bash 不需要批准）

$ node scripts/probe/dsh/roundtrip.cjs --task
✓ 快照："DONE"
✓ MCP 工具已进可见工具表：20 个 mcp__awf-state__*
✓ 经 AWF MCP 工具真落账：T1.status=done
[guard] check → IDENTICAL
```

### 2.13 P2-5f 完成记录（2026-09-19，**真实运行**：规划入口 + 一次性调用 + 装配归属）

| 交付 | 落点 | 说明 |
|---|---|---|
| `plan.launch`（C07） | `dsh-plugin/lib/ops.js` | 抽出共用 `createSession({cwd, mountMcp})`（发布前 setup：模型选择 + preset + 项目 MCP）；规划会话 = 建会话 + 注入规划指令 + 回网页 URL。规划产物经 awf-state MCP 写 state.json，故规划会话**也要挂 MCP** |
| `llm.oneshot` 实装并实测（C23） | 同上 | 两个实测踩点：① `llm.stream` 的 `messages` **必须是平台形状**（`createUserMessage({content:[blocks], source})`）—— 传裸 `{role,content}` 得到 `content.some is not a function`；② 文本只能认 `text-delta`（兼容 `text-chunks` 记录），**再叠加 `block-end` 会算两遍**（实测 "OKOK"）。流为空时**明确失败并带回记录形状**，不装成功 |
| `plugin.*` 归属澄清（C03） | 同上 | DSH 的接入装配是「装 profile」（写 profile patch 层 / 链接包），**归 CLI**（T-P2-02）；插件侧对 `plugin.*` 明确回「不属于这一层」，不是「没做完」 |
| 离线依赖 | `install-fixture.sh` | 再补 `@deepseek-ai/dsh-llm` 的符号链接（连同 `dsh-mcp-client`、`dsh-agent`） |

**真实运行证据**（`roundtrip --plan --oneshot`，隔离 AWF + 隔离 DSH，真派模型）：

```
✓ 规划会话已建并注入指令：session-3f50add8-… url=http://127.0.0.1:39081/?session=session-3f50add8-…
✓ 一次性调用返回文本："OK"（未建会话；早前版本因 delta+block-end 重复得到 "OKOK"，已修）
[guard] check → IDENTICAL
```

### 2.14 P2-6a 完成记录（2026-09-19，**dsh 转 factory**：解析 → 适配器 → 插件整条通路真实跑通）

| 交付 | 落点 | 说明 |
|---|---|---|
| 平台依赖注入通道 | `server/server.cjs`（入口）→ `runtime/registry` → `runtime/index` → `runtime/project` → `resolveProjectAdapters(root, {…, adapterDeps})` | DSH 的适配器需要 `bridge`（指令通道）。bridge 住在 `server/web`，而 **adapters 不许反向依赖 web** —— 因此由**入口**从 web 取好注入，逐层透传 |
| probe 回落 | `server/runtime/index.cjs` | cc 的 `impls.probe` 是工厂（要 host/status）；DSH 的 probe 自带 bridge → 工厂缺失时回落到已绑定的 `ports.probe` |
| `dsh` 转 `factory` | `server/adapters/ports.cjs` | 同时给出 DSH 的 `tools`（cc 形状的项目资产工具在这里**显式抛错**，不返回 undefined 让人踩 `undefined is not a function`）与空 `impls`（见上回落） |
| **真实运行验证** | `scripts/probe/dsh/roundtrip.cjs --runtime` | 走 **runtime/适配器层**（CLI 与宿主实际用的那条路）：项目 `.awf/config.json` 写 `runtime.adapter=dsh` → `createProjectRuntime` → `session.start` → `probe.inspect` → `kill` |

**真实运行证据**（隔离 AWF + 隔离 DSH）：

```
✓ runtime 路径全通：adapter=dsh → session.start(session-68f43386-…) → probe.inspect(state=ready) → kill
[guard] check → IDENTICAL（真实 ~/.dsh 配置面零改动）
```

含义：`ctx.adapter` 按项目配置解析、DSH 适配器经 bridge 驱动真插件建出真会话、probe 报出 `ready` —— 
**「按项目选平台 + 适配器可用」这条链路不再只是结构断言**。

### 2.15 P2-6b 完成记录（2026-09-19，**P2 出口「单任务 run」真实跑通** + 打到一处 P1 回归）

| 交付 | 落点 | 说明 |
|---|---|---|
| 平台事件 → 会话态 | `server/adapters/dsh/index.cjs` + `server/runtime/index.cjs` | 插件事件带 `cwd`（多项目过滤）→ bridge 事件 → 适配器 `hook` 端口（`session.ready` 映射为 **`run.phase:READY`**）→ 项目总线 → runtime 刷 `session.setBusy/setReady`（`run.started` 还会 `bumpSessionSeq`，让 CLI 的「等会话就绪」在 DSH 侧同样成立）。这是 CC 侧 `/hook` 路由的**等价物** |
| CLI 起环境平台感知 | `cli/lib/session.cjs` | `bringUp` 里「项目 MCP 注入 + run-settings」**只为 cc 执行**；dsh 的项目 MCP 由插件在会话创建时按 agent 作用域挂，不做 cc 形状的资产注入。等待就绪两种平台共用 |
| 真实链路验证 | `scripts/probe/dsh/roundtrip.cjs --run` | 建会话 → `ensureRunHost` → `submitRun` → 宿主派发（经适配器）→ 模型执行并落账 → run 收尾 |

**真实运行证据**（隔离 AWF + 隔离 DSH，真派模型）：

```
$ node scripts/probe/dsh/roundtrip.cjs --run
✓ 会话已创建：session-3ad3adf4-…
✓ run 宿主单任务跑通：run=done T1=done
[guard] check → IDENTICAL（真实 ~/.dsh 配置面零改动）
```

**这次真运行打到一处 P1 回归（重要，如实记账）**：首跑时 `run=error`，`run.error = "sleep is not defined"`。
根因是 **T-P1-02** 把注入节奏下沉进 host 端口时，顺手删掉了 `server/runtime/executor.cjs` 顶部的 `sleep` 助手，
而**结算循环里仍在用它** —— 也就是说 **CC 的单 agent 真实路径当时也已被打断**。当时全绿是因为集成用例要么
覆盖 `__CC_RUN_HOST_DEPS__` 的假执行器、要么不走真实 executor。处置：

- 恢复 `sleep` 助手；轮询间隔提为常量 `EXECUTOR_POLL_MS`（`server/config.cjs`，env `CC_EXECUTOR_POLL_MS` 可覆盖）；
- 新增 **回归护栏** `tests/unit/executor-settle.test.js`：直接驱动**真实 executor** 跑完结算循环
  （落账 done / blocked / 无会话三条），把「循环体能不能执行」钉住；
- 改后 `run=done T1=done` 复跑通过。

教训（写进 §4 验证纪律口径）：**假执行器的集成用例证明不了真 executor 能跑**；平台无关的真运行
（这次是 DSH 单任务 run）是唯一能打到这类「跨平台共享代码里的死引用」的手段。

### 2.16 P2-6c 完成记录（2026-09-19，**CLI 装配路径真实可用**：`awf plugin install` → DSH profile）

| 交付 | 落点 | 说明 |
|---|---|---|
| DSH 侧装配模块 | `server/adapters/dsh/install.cjs` | 把 AWF 装进 DSH 的**用户级 profile**（全局一次、多项目共享；U5/U12）：① 在 `cordis.patch.yml` 插**标记块**（`# >>> awf-dsh` … `# <<< awf-dsh`）；② 把插件包**拷进** profile 的 `node_modules/`（无 pnpm 时的等价路径，F13）。带**备份**（`.awf-backup`，只备一次）、**幂等**（已有块即跳过）、**卸载只摘自己的块** |
| CLI 分支 | `cli/commands/plugin.cjs` | `localPlugin` 按平台分支：DSH 走 `installProfile({dshHome, profile, webPort})`（参数形状与 cc 的 `installProfile(projectRoot)` 不同，故必须分支）；`--scope global` 在 DSH 上**明确不支持**并说明「profile 装配本身就是全局安装」 |
| 工具面 | `server/adapters/ports.cjs` | DSH 的 `tools.profile` = 上面的装配模块；cc 形状资产仍显式抛错 |
| 无 bridge 也能构造 | `server/adapters/dsh/index.cjs` | CLI 进程没有常驻指令通道（bridge 在 AWF server 里）。**不抛**，改用「未连接」替身：工具面可用，真发指令即得 `not-delivered` + 原因 —— 与真断链同语义 |
| 真实链路验证 | `scripts/probe/dsh/cli-install.cjs` | 真 CLI 子进程 + 真 `dsh --dump-config`：装 → DSH 承认 → 用户注释保留 → 卸 → DSH 不再认 |

**真实运行证据**（隔离 `DSH_HOME=/tmp/awf-dsh-probe`，新 profile `awf-cli`）：

```
✓ CLI 已装配：已装配 DSH profile awf-cli → …/cordis.patch.yml
✓ dsh --dump-config 含 awf-dsh-plugin          ← DSH 自己承认这行 patch 才算数
✓ 卸载后 dump-config 不再含该插件，用户注释仍在
[guard] check → IDENTICAL（真实 ~/.dsh 配置面零改动）
```

### 2.17 P2-6d 完成记录（2026-09-19，**双项目隔离真实验收**：单后台、各自会话与项目 MCP）

| 交付 | 落点 | 说明 |
|---|---|---|
| 指令补项目身份 | `server/adapters/dsh/index.cjs` | DSH 的指令通道是**进程级共享**的（一个后台服务多项目），平台按 `projectRoot` 找会话；而 cc 的 host 每项目一份（tmux 会话名自带身份），端口签名里没有 projectRoot。统一用 `withRoot()` 给每条指令补上 |
| 双项目验收夹具 | `scripts/probe/dsh/roundtrip.cjs --two-projects` | 两个项目各建 runtime（共享同一 bridge）→ 各建会话 → 各派一句「用 awf_read_state 读本项目摘要并回 `<version>\|<任务id>`」→ 断言各读各的、且不串；再停 A，断言 B 不受影响 |

**真实运行证据**（隔离 AWF + 隔离 DSH，真派模型 ×2）：

```
[roundtrip] 两个项目各建会话：A=dsh B=dsh
✓ 双项目隔离：A→"0.2.0|T-A" B→"9.9.9|T-B"
✓ 停 A 不影响 B（单后台、多项目各自独立）
[guard] check → IDENTICAL（真实 ~/.dsh 配置面零改动）
```

与 P0 的 E-03 证据（`proj-a → 0.2.0|1`、`proj-b → 9.9.9|2`）同形 —— 但这次是**经 AWF 适配器/runtime**
（不是裸探针），也就是 CLI/宿主实际走的那条路。

**本轮打到的缺陷（如实记账）**：首跑两边都快照为空 —— 根因是 `host.sendPrompt` 只发 `{text}`，
**没带 projectRoot**，插件 `findSession(undefined)` 回落到「第一个会话」，两个项目的指令打到同一处。
这正是「单后台多项目」验收要抓的东西；修法是适配器统一补项目身份。

**仍未做（P2-6b）**：CLI 三命令的 DSH 接线（`init` 装 profile 插件 / `plan` 走 plan.launch / `run` 的 bringUp
对 DSH 不做 cc 资产注入）+ 单后台复用判定 + 双项目并发验收。

**仍未做（P2-5e）**：`session.snapshot`（可读快照投影，C25）、U16 自动批准规则（现只记录+委派）、
`plugin.install/uninstall`（C03）、`plan.launch`（C07）、`llm.oneshot` 实测（C23）、
`session.stop` 对**子 Agent** 的真实打断验证（现只覆盖无子 Agent 场景）、
以及 T-P2-02（CLI 三命令接线 + 单后台复用 + 双项目验收）。

**仍未做（P2-5c 余下）**：`session.snapshot`（可读快照投影）、**会话级挂 MCP**（C30，派发前等注册 F29）、
U16 自动批准规则（现在只记录+委派）、`plugin.install/uninstall`、`plan.launch`、`llm.oneshot` 实测、
以及**经 AWF MCP 工具真落账**的那一段（"建会话 → 派任务 → 落账 → 快照 → 停止"）。

**P2-5c 起点（本轮已核到）**：会话事件的观察接缝是 **`ctx.on('session/event', (session, event) => …)`**
（firehose；`dsh-acp:1102`、`dsh-agent-presets:1325`、`dsh-agent-instructions:1263` 都这么订阅），
`turn/start` / `turn/end` 都走这条 —— `session.prompt` 的「回合结束 → 上报 session.ready」就接在这里。
`prompt` 的平台形状：`sessionController.prompt({ sessionId, content: [{type:'text',text}], requestId? }, signal)`
→ `{accepted:true}`（`dsh-api-session-controller/lib/index.js:736` 公开方法 + `:2920` 的 Remote 包装即 F26 的两位参数）。

**仍未做（P2-5c）**：`session.prompt`（`sessionController.prompt({sessionId, content}, signal)` + 回合结束信号 ——
`turn/end` 是会话日志事件，需要找到插件侧观察会话 append 的接缝）、`session.snapshot`（投影）、
`plugin.install/uninstall`、`plan.launch`、会话级挂 MCP、U16 自动批准规则、`llm.oneshot` 实测。
最小真实链路里**派模型那一段**也留到这里。

**P2-5b 起点（本轮已核到的确定事实，省下轮重查）**：
- 建会话：`ctx.get('sessionController').create({ cwd, agentPreset?, sessionId? })` → `{ sessionId, agentPreset? }`
  （`dsh-api-session-controller/lib/index.js:2726` 注册服务名、`:571` 是 `create`；内部走
  `agents.ensureSession(sessionId, cwd, 显式 id?, presetId)`，preset 组合在 `dsh-agent` 侧完成 → F19）。
- **待查**：`sessionController`（api 侧）**没有** `delete/stop/close/cancel/interrupt` —— 取消/停止/`whenIdle`
  在 `dsh-acp`（E-06 引用的 `dsh-acp/lib/index.js:870/953/956/995`）。P2-5b 第一步就是核清
  「停会话/停 run/打断当前响应」在 web 组合里到底经哪个服务，再实现 `session.stop` / `session.interrupt`。
- U16 批准应答者：按 §2.5 的更正写法（`ctx.on('approval/request', …)`，范围内 `allowed-once`、范围外 `next()`），
  注册到 **AWF 创建的那个 agent 的作用域**（`dsh-scope` 按 `args[0].agent` 分发）。

### 2.18 P2-6e/6f 完成记录 + P2 收口（2026-09-19，真机）

| 交付 | 落点 | 说明 |
|---|---|---|
| 停 run 逐个打断子 Agent | `dsh-plugin/lib/ops.js` | 子 Agent 名单在 `cancel` **之前**取；user 权威补 `parentSessionId`；回执带 `subagents/subagentsSeen/errors` |
| 停止回执不被吞 | `server/adapters/dsh/index.cjs` | `session.kill()` 原样返回平台回执（此前丢弃 → 调用方无法验证子 Agent 真被打断） |
| init 记住平台 | `server/shared/workspace.cjs` + `cli/commands/init.cjs` | 新增 `applyAdapter()`：把**解析到的平台**记进 `.awf/config.json`；已有显式值不覆盖 |
| CLI 装配路径认平台 | `cli/commands/plugin.cjs` | `localPlugin` / global 预检不再写死 `env: {}`（它把 `CC_ADAPTER` 一起吞了） |
| attach 有落点 | `cli/commands/attach.cjs` + 插件 facts + 适配器 probe | 网页形态先经 server `/probe` 拿观看地址（CLI 进程没有 bridge），终端形态才 `attach()` |
| 会话身份规范化 | `dsh-plugin/lib/ops.js` | `findSession` 按 realpath 比路径（`/var` vs `/private/var` 不是两个项目） |

**真实运行证据**（隔离 `DSH_HOME=/tmp/awf-dsh-probe`；真实 `~/.dsh` 全程 `IDENTICAL`）：

```
$ node scripts/probe/dsh/roundtrip.cjs --subagent
✓ 子 Agent 已派发：1 个（105a3727-…）
✓ 停 run 时逐个打断子 Agent：["105a3727-…"]
✓ 停止后子会话已不在活动列表

$ node scripts/probe/dsh/cli-install.cjs --init
✓ `awf init` 在 DSH 项目上跑通（前置检查 ✓ dsh / ✓ node + 建骨架）
✓ 平台已记入 .awf/config.json（adapter=dsh）；重复 init 幂等（含去掉 CC_ADAPTER 仍是 dsh）
✓ `awf init --force` 只补缺失目录，state.json 与装配块不受影响

$ node scripts/probe/dsh/roundtrip.cjs --attach
✓ `awf attach`（独立进程）拿到会话地址：…:39081/?session=session-e4ccff06-…
```

**本轮打到的四个真缺陷（如实记账）**：

1. `session.kill()` 把平台回执丢了 —— 「子 Agent 是否真被打断」无从验证，测试会「看起来通过」（这正是 U11 要抓的）。
2. 子 Agent 名单在 `cancel` **之后**取 —— 平台 cancel 父会话会把子激活摘出活动列表，名单恒为空（F40）。
3. `subagents.interrupt(target, authority)` 的 user 权威**必须带 `parentSessionId`**，否则平台校验不过、UNAUTHORIZED（F39）。
4. 会话身份按路径**字符串**比 —— macOS 临时目录存在 `/var/…` 与 `/private/var/…` 两种写法，同一个项目被判成「没有会话」（F38）。

**七个命令在 DSH 下的真机状态**

| 命令 | 状态 | 证据 / 缺口 |
|---|---|---|
| `init` | ✅ | `cli-install.cjs --init`：干净项目（`CC_ADAPTER=dsh`）→ 骨架 + 平台入库 + 幂等 + `--force` + 卸载复原 |
| `plan` | 🟡 | `plan.launch` 真跑通（§2.13）；`awf plan` 命令层（门禁/WBS/交互式提问）未在 DSH 上端到端跑 |
| `run` | ✅（单任务） | `--run` → `run=done T1=done`（§2.15）；多 agent / 决策 / 门禁闭环属 P3 |
| `plugin` | ✅ | install/uninstall 真装进 profile（§2.16，cli-install 两模式） |
| `server` | 🟡 | 「单后台多项目、项目级隔离」已验（§2.17）；`awf server start` 在 DSH 项目上的独立启动/复用判定未实跑 |
| `open` | 🟡 | 页面地址由 `ctx.port` 拼，平台无关；但三个业务页面本身仍是空的（P4） |
| `attach` | ✅ | `--attach` 实测：DSH 下 = 打印并打开本项目会话页 |

**V01～V12 验收映射**（P2 收口；依据只有三类证据，见 §4）

| 验收 | 状态 | 已验 | 缺口 |
|---|---|---|---|
| V01（干净 init / 重复 / 双项目单后台） | 🟡 | `awf init` 干净项目 + 重复 + `--force` + 不可覆盖（`cli-install.cjs --init`）；双项目并发单后台、各读各自项目 MCP（§2.17） | 「init 之后一路 `plan` → `run`」的整链（P3） |
| V02（plan 注入 / 网页接续 / 技能命令可发现） | 🟡 | `plan.launch` 建规划会话 + 注入指令 + 回网页 URL（§2.13） | `plan -r` 不误归档；DSH 侧技能/命令可发现（C29 的 DSH 半侧） |
| V03（提交→受理→落账→网页可见；错提交不假成功） | ✅ | 提交→accepted→`turn.started/prompt.submitted/session.ready`；20 个 `mcp__awf-state__*` 可见且模型**真落账**（`T1.status=done`）；快照回真实文本；未实现 op / 未知参数显式失败（§2.10–2.13） | 「网页可见」为人工目视项（未截图留证） |
| V04（父子 Agent 停止 / 排队不偷跑 / 不影响别项目） | 🟡 | 子 Agent 真派出 + 停 run 逐个打断 + 停止后离开活动列表（本轮）；停 A 不影响 B（§2.17） | 「排队内容 + 子 Agent 同时存在」的停止验证 |
| V05（用量读数 / 交接 / 清空 / 完成信号 / 续跑） | ⬜ | — | C37 未纳入本轮；交接与 `-r` 续跑属 P3 |
| V06（worker 工具允许/拒绝；错 taskId 不污染） | 🟡 | 真落账走 MCP 工具（模型可调用、磁盘可见） | worker 禁写工具被拒、错 taskId/重复/迟到结果不污染（多 agent 属 P3） |
| V07（决策/提问/NEEDS_INPUT/门禁/动态规划） | ⬜ | — | 全属 P3（决策中继 + 门禁闭环在 DSH 侧的真实运行） |
| V08（隔离诊断 / 超时取消 / 不改主会话身份） | ✅ | `llm.oneshot` 真返回（不建会话、可超时取消，§2.13）；`session.stop` 不删会话、主会话 id 不变（§2.9） | — |
| V09（CLI 退出 / 桥断 / 各自重启 / `-r` 不重复提交） | 🟡 | 断链退避重连**不重放**（插件 + 桥接单测）；通道断开 → 在途指令判「无法确认」 | CLI 退出、AWF/DSH 各自重启的组合验收；`run -r` 不重复提交活跃任务（P3） |
| V10（三个空页面 / 项目与无会话入口 / 会话定位） | 🟡 | 关页面不停后台（P0 E-09）；会话定位打通（本轮 `awf attach` 拿到本项目会话地址） | 三个业务页面 + 项目/无会话入口（P4）；原生 stop 仍不处理 |
| V11（发布包新目录可装 / 禁用 A 不卸 B / 部分失败明确） | 🟡 | 从仓库真装进 profile + 精准卸载（§2.16）；`runPerSpec` 部分失败逐条报错（单测） | 发布包在**新目录**安装（不依赖开发机绝对路径）实测（P4）；禁用项目 A 不动 B 的能力 |
| V12（CC 回归 / 同一 server 服务两平台） | 🟡 | CC 路径全绿：`npm test` 1157 / `check:arch` / `check:capability` / `lint`；DSH 分支不改变 cc 缺省（`resolveAdapterName` 缺省仍是 cc） | 「同一个 AWF server 同时服务 cc 与 dsh 项目」的真实验收 |

**P2 出口判定**：P2 的目标（DSH 适配器与插件真实可用、指令通道承担全部会话操作）**已达成**：`init`/`run`/`plugin`/`attach` 四个命令真机可用，`plan`/`server`/`open` 三条有实测落到平台的一半。
V03/V08 两条验收完整通过，其余为「已验一半 + 缺口明确」。**P2 不再扩范围**，剩余缺口按性质归 P3（编排闭环）与 P4（页面/发布/跨平台）。

---

## 3. 已确认的静态发现登记（P0 期间累积，供后续阶段引用）

| 编号 | 发现 | 证据 | 对设计的影响 |
|---|---|---|---|
| F01 | `dsh plugin` 是 pnpm 转发；本机**无 pnpm** | `dsh/lib/plugin-Ddi42qoW.js`（`spawnSync("pnpm", …)`）；`which pnpm` 空 | 离线装配需等价路径；「pnpm 缺失」进 C02 依赖检查 |
| F02 | bundle 判定靠依赖包 `dsh.bundle.patch` | 同上 `exportsPatch()` | 插件包必须声明 `dsh.bundle`；仅装依赖不会自动生效 |
| F03 | profile 布局：`$DSH_HOME/profiles/<name>/{package.json,cordis.yml,cordis.patch.yml}` | 实测创建 | `runtime.adapter` 的项目配置不能写这里（全局单实例已定，U5/U12） |
| F04 | MCP 可按**会话**挂载，带 `cwd` | `dsh-acp/lib/index.js:216-219`、`:701`、`:720` | X1 的机制候选；单后台多项目隔离有解，但仍需实测 |
| F05 | `tools.restrict()` 必须有作用域，且只能限制**全局/继承层**工具名 | `dsh-tools/lib/index.js:2790-2804`、`2855-2876` | X2 的关键约束；**决定 worker 权限实现路线**，实测优先 |
| F06 | agent 作用域 guard 可拒绝工具调用 | `dsh-tools/lib/index.js:2805-2810` | X3「提问前拦截」的候选机制 |
| F07 | 取消后可用 `whenIdle()` 作为完成信号候选 | `dsh-acp/lib/index.js:870/953/956/995` | X4 的完成信号候选 |
| F08 | 服务名册：`agents` / `llm` / `sessions` / `sessionPersistence` | `dsh-acp/lib/index.js:1048-1053` | 插件 host 半侧可用能力面 |
| F09 | `ctx.webServer.register({kind,path,handler})` 可供插件注册 HTTP 路由（含 `registerUpgrade`、`registerFallback`、`tapIndex`） | `dsh-host-webserver/lib/index.js:157-250` | 插件→AWF 回传/鉴权入口的落点候选 |
| F10 | `dsh web` 的 HTTP 面默认鉴权：`GET /` → 401、`GET /api` → `unauthorized` | 实测 curl | 印证「浏览器不复制 cookie、跨源直连不当默认可用路径」 |
| F11 | 运行期 `~/.dsh/profiles/web/cordis.yml` 在本沙箱下写入 EPERM | `dsh web --help` 报 EPERM | 真实 profile 被运行中进程持有；**不得**在真机做实验性写入 |
| F12 | DSH 真实存储目录 `~/.dsh/{sessions,storages,attachments,...}` 由运行期持续写入 | 实测 mtime 变化 | 观测/落账设计须区分运行时数据与配置；影响 `guard.sh` 口径 |
| F13 | 用户侧安装/管理 profile 插件**必须有 pnpm**（`dsh plugin` 是 pnpm 转发器）；本机无 pnpm | `dsh/lib/plugin-Ddi42qoW.js:109-118`（ENOENT → 127 + 提示）；`which pnpm` 空 | 进 C02/D-9 依赖检查：`dsh plugin` 不可用时必须**明确报告**，不能静默跳过（U6「明确失败」原则） |
| F14 | include patch 是**浅覆盖**，不是深合并 | `dsh-app-boot/lib/index.js:104-107`；实测「只覆盖 webserver.port 导致 `$.host missing required value` 启动失败」 | 适配器注入 MCP/webserver 配置时必须给全字段，或改用 `insert` 新增行（不改既有行） |
| F15 | 第三方插件包 client 半侧**无需构建链**即可进入 boot graph | E-02 证据 C：手写 lazy-CJS 注册行被组合包原样服务 | 插件 UI 可以纯手写 CJS，不引入 tsdown/vite（延续旧 spike §5.3） |
| F16 | 插件注册 HTTP 路由后，**dsh 的浏览器 cookie 鉴权仍然先行**（无 token 401） | 实测 `GET /`→401、带 cookie 的 `/api/awf-probe/ping`→200 | 网页→AWF 的入口应复用插件路由 + dsh 鉴权，不在浏览器复制 cookie（spec §2 已定方向，此处得到实现落点） |
| F17 | runtime ctx 可用服务（web 组合实测）：`webServer/agents/sessions/sessionPersistence/llm/tools/loader/timer/clientModules/commands` | E-02 证据 B 的 `services` 字段 | host/session 端口在 DSH 侧的能力面清单基线 |
| F18 | **web 组合把 host 平面工具行整体 `disabled`**（tool-bash/tool-fs/tool-jobs/tool-skill/…，共 26 行），工具改由 **agent preset** 的 standing composition 提供 | `/tmp/awf-dsh-probe/dump-web.txt` 中 `disabled: true` 清单；`dsh-web-app/cordis.patch.yml:368-411` | 适配器不能假设「工具在全局层」；DSH 侧工具面必须按 agent 作用域理解 |
| F19 | `agents.create()` 只给「裸 agent」：**必须**同时 ① `installModelSelection(agentCtx, {current, assembled})` ② `agentPresets.mount(agentCtx, presetId)` ③ `agents.create` 自身；缺 ①/② 则无模型路由、无工具 | 对照 `dsh-headless/lib/index.js:134-146`（①②③ 齐备且实测能跑通）；`dsh-api-session-controller/lib/index.js:354-366`（网页路径的等价组合） | 适配器创建会话必须走「完整组合」，不能只调 `agents.create` |
| F20 | include patch 的 `config` 是**浅覆盖**，不是深合并 | 实测 F14 | 同 F14 |
| F21 | **agent 侧操作必须落在「激活窗口」内**：`apply()` 内直接 `agents.create`+跑一轮 → `error: reading 'kind'`（无 `step/*`，未发起模型请求）；把同一段 `setTimeout` 到 `apply()` 之后 → `cannot get required service "agentDefaultModel" in inactive context` | `headless-probe` 证据：`experiment-error` 链；web 侧 `controller-turn` 的 `promptError` | **这是 E-03 的唯一未解点**：需要找到 Cordis 的正确驱动时机 |
| F22 | provider/凭据/agent 本身都正常，可排除 | `ctx.llm.listProviders()`=`["deepseek-official"]`；`resolveModelInfo('deepseek-flash')` 有 `inputModalities`；`agentStatus=idle`；`composedPreset=standard`；`dsh --profile headless "…"` → `PONG` | 不要把上面的 `.kind` 错误误判成凭据或模型问题 |
| F23 | MCP server 进程确实按项目各起一份（`AWF_PROJECT_ROOT` 各归其位） | 探针两次挂载后服务端 stderr 出现两遍 `[awf-state] started` / `client initialized` | `agentCtx.plugin(McpClient, {env})` 这一层的**挂载动作本身可用**；剩下的只是驱动时机 |
| F24 | `dsh web` 的鉴权可用浏览器 cookie 打通（`?token=` → cookie → 插件路由 200） | E-02 证据 B/C | 网页→插件入口可复用 dsh 鉴权（F16） |
| F25 | **`ctx.inject([...services], cb)` 是 Cordis 里做「服务就绪后的装配」的正确入口**；在 `apply()` 顶层直接调用会命中非活跃上下文，`setTimeout` 到 `apply()` 之后会报 `cannot get create effect on inactive context` / `cannot get required service … in inactive context` | headless 探针 `experiment-error` 链（`INACTIVE_EFFECT`）；web 探针改为 `ctx.inject` 后 `/api/awf-probe/ping` 与 `/mount-mcp` 路由**确实注册成功并可响应 200** | 适配器 plugin 的所有运行期装配都必须放进 `ctx.inject` 回调，不能放 `apply` 顶层 |
| F26 | 用插件侧的 `sessionController.prompt(...)` 投递一轮时，必须传**第二位置参数** `signal`：签名为 `prompt(request, signal)`（`dsh-api-session-controller/lib/index.js:2919-2922`，函数体第一行就是 `signal.throwIfAborted()`）。把 signal 放进 request 对象无效。 | 实测：request 里带 signal → `store/index.js:2921` 抛 `reading 'throwIfAborted'`；改为 `prompt(req, new AbortController().signal)` 后**正常受理** | 适配器调用控制器 API 前必须核对真实签名，不能照抄类型里的字段名 |
| F27 | 绕开控制器直接 `agent.followup(message)` 投递，会命中标准预设里 `dsh-repeat-tool-reminder` 的 `x.kind` 读取而首轮即 error | `agent/error` 栈：`dsh-repeat-tool-reminder/lib/index.js:1510` | 驱动一轮必须走 `sessionController.prompt`，不要直接投 `followup` |
| F28 | **agent 本身已能跑通一轮**：`sessionController.create` + `agentPresets.mount('standard')` + `prompt(req, signal)` → `turn/end {kind:'completed'}` | `/api/awf-probe/controller-turn` 两个项目各跑一轮均 completed | 驱动链路成立；早期「工具缺失」是时序问题而非能力缺失 |
| F29 | **MCP 工具注册是异步的**（连接 → `tools/list` → `register`）；挂载后**立刻**提问会得到「没有该工具」。注册完成后模型工具表为 **48 个工具**，`mcp__awf-state__*` 20 个齐全 | 挂载即问 → 模型答「工具集里没有 MCP 工具」；等待注册后 `turn-done` 的 `mcpTools` 列出全部 20 个；E-03 FINAL 两项目分别答 `0.2.0\|1` 与 `9.9.9\|2` | 适配器**必须**在派发前确认「本次派发所需工具已注册」（可用首轮/预检），不能挂载后立即派发 |
| F30 | `agent.ctx.tools.get(name)` 返回 undefined **不代表**工具未注册；模型可见工具表由 preset 的 standing scope 装配路径给出 | `toolReady:false` 但同一 agent 的 `requestHeader().tools` 含全部 MCP 工具 | 判定「工具是否可用」要看模型侧工具表（requestHeader/预检），不要用 `agent.ctx.tools.get` 下结论 |
| F31 | **`subagents.start('spawn', { toolFilter })` 真能硬拦**：被 deny 的工具子 Agent 调用被拒绝（回 `DENIED`），对照组同一工具调用成功 | `e04a.json`：全局挂载下 control→`0.2.0`、deny→`DENIED`、另一 filter→`0.2.0` | 「权限不降级」在**全局挂载**前提下可达成；多 worker 实例的 filter 互不影响 |
| F32 | **会话作用域挂载的 MCP 工具无法被 `tools.restrict()` 点名**（判 unknown global tool 直接抛错），子 Agent 也看不到该工具 | `e04.json` / `e04c.json`：`tools.restrict() names unknown global tool "mcp__awf-state__awf_read_state"`；会话作用域下 control 也回 `DENIED` | **与项目隔离正面冲突**：隔离要按会话挂载，硬限制要全局挂载，当前版本二者不可兼得（见 T-P0-07） |
| F33 | 全局层同名 `McpClient` 实例在**同一进程内不可重复挂载**（`serverName` 必须唯一） | `e04b.json`：重复调用同一路由 → `serverName "awf-state" is already in use` | 全局挂载形态必须每项目用不同 `serverName`，或只挂一次 |
| F34 | **子会话执行 `bash` 会停在 `approval/asked`**（web 组合 `workspace-write + approval:ask`）；页面上无人批准、宿主也不代批 → 无人值守 run 会被卡死 | E-09 实验：`lastEvents` 长时间停在 `tool/call`/`approval/asked`，`status=running` 不变 | **AWF 必须定义 approval/authorization 策略**（受控自动批准 vs 接入 AWF 决策），否则主链路不可用；不得擅自放开权限 |
| F35 | **`compaction` 取不到不是因为它不存在**：服务在 preset 的 isolate realm 内；root ctx 与 `agent.ctx` 都取不到（实测均 false），只有与 preset 同 realm 的作用域可取 | `/api/awf-probe/compact-probe`：`hasRootCompaction=false`、`hasAgentCompaction=false`、`compactNow=null`；源码 `dsh-compaction-basic/lib/index.js:761,944` + `standard/agent.cordis.yml` 的 `isolate: {compaction:true}` | AWF 的压缩接线必须走 preset 同 realm（或驱动 `/compact`），不能假设 root ctx 可取；与 F32 同根因 |
| F36 | **插件注册的路由不在 dsh 的浏览器信任栅栏内**（2026-09-19 实测，隔离探针）：`webServer.register({kind:'exact', path:'/api/awf-probe/ping'})` 无 cookie 直接 200；同一实例的 `/`、`/api`、`/api/sessions` 都是 401 | 隔离探针（`DSH_HOME=/tmp/awf-dsh-probe`，端口 39081）逐路径状态码：`/`=401、`/api`=401、`/api/sessions`=401、`/api/awf-probe/ping`=**200**、`/nonexistent-xyz`=404 | **与 F16 的推断相反**（F16 只做了「带 cookie → 200」的正向观测，缺「不带 cookie」对照）。含义：**网页→AWF 的入口若走插件路由，插件必须自己做鉴权**；不能假设「注册在 `/api` 下就自动受 dsh 鉴权保护」。spec §2「通过 DSH 插件的受鉴权入口请求 AWF」里的「受鉴权」要由 AWF 实现，不是继承来的 |
| F38 | **会话身份按路径比必须规范化**：平台记的 `header.cwd` 与 AWF 传进来的项目根可能一个是 `/var/…`、一个是 `/private/var/…`（macOS 临时目录的真实路径），字符串不等 → 「明明建过会话却找不到」 | `roundtrip.cjs --attach` 首跑：CLI 拿到的是 web 根地址而非会话地址；插件 `findSession` 用 `realpathSync.native` 规范化后同一会话立即命中 | 凡是「按路径找资源」的插件 op（findSession 及其全部下游）都要走同一规范化；路径相等 ≠ 字符串相等 |
| F39 | **`subagents.interrupt(target, authority)` 的 user 权威必须带 `parentSessionId`**：平台校验 `child.header.parentSession === authority.parentSessionId`，不给就 `UNAUTHORIZED`；`authority.kind==='ancestor'` 则要求 `authority.agent`；且 `activation === undefined` 时静默返回（不抛） | `dsh-subagent/lib/index.js:853`；实测 `--subagent` 首跑 `stopped.subagents` 为空、异常只落在日志里 | 停 run 的打断调用必须构造完整权威；**并且把异常带回回执**，否则「没打断」和「打断失败」在调用方看是一样的 |
| F40 | **平台 cancel 父会话会把子激活摘出活动会话列表**：先 cancel 再 `sessions.list()` 过滤 `parentSession` → 恒为空 | 实测：`session.children` 能找到子会话，同一进程里 cancel 之后再取 → 0 个；改为 cancel 前取名单后逐个打断即通过 | 「停 run」的正确顺序是 **先取子 Agent 名单 → cancel 父 → 逐个 interrupt**；顺序错了就是静默不打断 |
| F37 | `dsh web` 是 `--profile web` 的**别名**，不接受父级 `--profile`（报 `web takes none of parent --profile …`） | 隔离探针实测：`dsh --profile awf-probe web --port …` 失败；`dsh --profile awf-probe --port … --no-open` 成功 | 自定义 profile 的启动方式必须写成 `dsh --profile <name> <app 旗标>`；探针 `serve.sh` 已按此修 |

---

## 4. 验证纪律（本项目内约定）

1. **区分三类证据**：静态代码核查（读源码/`--dump-config`）、替身测试（假件/单测）、**真实运行验证**（真模型/真进程）。
   对外只能说清是哪一类；「假件通过」不得表述为「DSH 可用」。
2. **不确定就标未知**：无法核实的执行结果不得显示为成功（U3/T2）。
3. **失败不降级**：worker 权限、子 Agent 身份等既定要求不满足时，记录冲突与影响，不自行改用弱实现（U6/D-5）。
4. **CC 路径可用是硬门槛**：P0 期间不碰 CC 生产代码；P1 起每次改动后 `npm test` 必须全绿。
5. **不动真实 `~/.dsh`**：实验一律 `source .awf/probe/dsh/env.sh`。

---

## 5. 变更日志

| 日期 | 变更 |
|---|---|
| 2026-09-19 | **P2 收口（P2-6e/6f + V01～V12 映射）**：子 Agent 停止链路真机打通（先取名单→cancel 父→逐个打断；权威补 `parentSessionId`；停止回执不再被吞）、会话身份按 realpath 规范化（F38）、`awf attach` 在 DSH 下经 server `/probe` 拿到会话地址（跨进程，CLI 没有 bridge）、`awf init` 把解析到的平台记进 `.awf/config.json`（并修掉 CLI 装配路径吞掉 `CC_ADAPTER` 的缺陷）。七个命令真机状态：`init`/`run`/`plugin`/`attach` ✅，`plan`/`server`/`open` 🟡；V03/V08 完整通过，其余缺口按 P3/P4 归档。详见 §2.18 |
| 2026-09-19 | **P2-6d 完成（双项目隔离真实验收）**：适配器给每条指令补 `projectRoot`（进程级共享通道的必需项；首跑因漏它导致两项目打到同一会话，实测抓到并修）。`--two-projects` 实测：A→`0.2.0\|T-A`、B→`9.9.9\|T-B` 各读各的、互不串，停 A 不影响 B。详见 §2.17 |
| 2026-09-19 | **P2-6c 完成（CLI 装配路径可用）**：新增 `server/adapters/dsh/install.cjs`（profile patch 标记块 + 包拷贝 + 备份 + 幂等 + 精准卸载），`awf plugin install/uninstall` 在 DSH 项目上分支到它；适配器支持无 bridge 构造（CLI 侧只需工具面）。真 CLI + 真 `dsh --dump-config` 验证：装→DSH 承认、卸→DSH 不再认、用户内容始终保留。详见 §2.16 |
| 2026-09-19 | **P2-6b 完成（P2 出口「单任务 run」真实跑通）**：平台事件→会话态接线（session.ready → run.phase:READY；runtime 作为 CC /hook 的 DSH 等价物）、CLI bringUp 平台感知。实测 `--run`：**run=done T1=done**。首跑打到 **P1 回归**（executor 结算循环用了已被删掉的 `sleep`，CC 真实路径同样受影响）→ 已修复 + 新增真实 executor 的回归护栏。详见 §2.15 |
| 2026-09-19 | **P2-6a 完成（dsh 转 factory）**：入口注入 `adapterDeps.bridge`（adapters 不反向依赖 web）、probe 工厂回落、DSH tools 显式抛错；`--runtime` 实测「项目配置 → 解析 dsh → 适配器 → bridge → 插件」整条：adapter=dsh、session.start 建出真会话、probe.inspect=ready、kill。真实 home `IDENTICAL`。详见 §2.14 |
| 2026-09-19 | **P2-5f 完成**：`plan.launch`（共用 createSession 配方 + 注入规划指令 + 网页 URL）与 `llm.oneshot`（平台 createUserMessage 形状、只认 text-delta、空文本明确失败）双双真实跑通；`plugin.*` 归属澄清为 CLI 侧。真实 home `IDENTICAL`。详见 §2.13 |
| 2026-09-19 | **P2-5e（第一段）完成**：实现 `session.snapshot`（最后一条 assistant/message 的 text 块，可截断、无内容不编），实测拿回模型真实输出。**U16 取证改变做法**：workspace-write 下项目内 bash **零批准请求** → 「项目内自动批准」已由沙箱满足，无需额外规则；保持「只记录+委派」即可（项目外 fail closed），且同时修正了 F34 的解读。真实 home `IDENTICAL`。详见 §2.12 |
| 2026-09-19 | **P2-5d 完成（P2 核心出口打通）**：`session.create` 改走 `agents.create` + **发布前 setup** 里 ① installModelSelection ② agentPresets.mount ③ 挂项目 MCP（`agentCtx.plugin(McpClient,…)`）；新增 `session.tools` 诊断。真派一轮模型实测：20 个 `mcp__awf-state__*` 进可见工具表，模型调用后 **磁盘 state.json 的 T1.status=done**（真落账）。真实 home `IDENTICAL`。快照/批准规则/装配/plan 入口留 P2-5e。详见 §2.11 |
| 2026-09-19 | **P2-5c 完成（真实运行 + 真派一轮模型）**：实现 `session.prompt`（`prompt(request, signal)`，F26 第二位置参数；requestId=commandId 去重）与回合边界上报（`ctx.on('session/event')` 捕 turn/start|end → turn.started / session.ready）。实跑观测到 **「平台已受理」与「回合结束」分开**：accepted=true 后 events = turn.started → prompt.submitted → session.ready，facts.ready 复位为 true；真实 home `IDENTICAL`。挂 MCP/快照/落账那段留 P2-5d。详见 §2.10 |
| 2026-09-19 | **P2-5b（第一段）完成（真实运行，未派模型）**：插件侧实现 `session.create`（`sessionController.create` → preset=standard 建出真会话）/ `session.interrupt`（cancel，keepInbox）/ `session.stop`（cancel + 逐个 `subagents.interrupt`，不删会话）；U16 批准应答者先按「只记录 + 委派」接线并上报事实。roundtrip 扩到 7 步全绿，真实 `~/.dsh` `IDENTICAL`。派模型那一段与 prompt/snapshot/挂 MCP 留 P2-5c。详见 §2.9 |
| 2026-09-19 | **P2-5a 完成（AWF ↔ DSH 插件 指令通道真实链路）**：新增生产插件 `dsh-plugin/`（Cordis host 半侧：先 accepted 再 result / 断线重连不重放 / 事件上行 / 未实现 op 显式失败）+ 真实链路夹具 `scripts/probe/dsh/roundtrip.cjs`。实跑证据：隔离 AWF（临时项目）+ 隔离 DSH 下 `session.facts` → `delivery=accepted, ok=true`（facts 来自平台真实现场），未实现 op → `accepted + ok=false`（错误路径不静默），真实 `~/.dsh` 配置面 `IDENTICAL`。建会话/派发/落账仍属 P2-5b（尚未派模型）。详见 §2.8 |
| 2026-09-19 | **P2-4 完成（AWF 侧适配器 + 指令通道，替身级验证）**：`server/adapters/dsh/bridge.cjs`（三种送达结论 + ack/result 两段窗口 + 断开不重发）、`dsh/index.cjs`（7 端口；cc 机制方法显式 unsupported）、`server/web/bridge-channel.cjs`（WS `/bridge/dsh` + `POST /bridge/dsh/callback`）、`REQUIRED_PORT_METHODS` 收窄为平台无关面、conformance 判据改为「有工厂」并把「未落地必须显式拒绝」纳入门禁。`dsh` **仍 not-landed**（插件半侧待 P2-5），`npm test` 113/113、1105/1105。详见 §2.7 |
| 2026-09-19 | **P2-3 完成（隔离探针重建）**：夹具改放 `scripts/probe/dsh/` 并**纳入 git**（P0 那份在 `.awf/probe/` 被 gitignore，换机丢了）；env/guard/install-fixture/serve + 探针插件 host 半侧全部可用。真实运行证据：隔离 home 起静默后台（39081），`/api/awf-probe/ping` 200，实验后真实 `~/.dsh` 配置面 `IDENTICAL`。**新增 F36**（插件注册的路由不受 dsh 浏览器信任栅栏保护：同实例 `/`=401 而 `/api/awf-probe/ping`=200 → Web→AWF 入口必须自做鉴权）与 **F37**（`dsh web` 是 `--profile web` 别名，自定义 profile 必须 `dsh --profile X <app 旗标>`）。详见 §2.6 |
| 2026-09-19 | **P2 启动**：P2-1 完成 C30 状态读取边界（`awf_read_state` 缺省摘要 / `full:true` 全量 / 未知参数报错；400 任务摘要 <5KB vs 全量 346KB，提交 `2b9b70f`）。P2-2 完成**前置源码核对**（§2.5）：确认批准应答者缝与预设表；**发现 U16 记录的落地机制与 0.1.5-rc.2 源码不符**（workspace-write 的 approval 是 `ask` 而非 `never`；`never` 是自动拒绝），已回报并给出候选路线（清单 U16 更正节 / 接续文档 §6）。本机可执行 `dsh` = 0.1.5-rc.1、真实 `~/.dsh` 有运行中的 web、隔离探针 home 与 `.awf/probe/` 均已丢失 → 下一步 P2-3 重建探针 |
| 2026-09-19 | **P1 全部完成（T-P1-01～06，6 个提交）**：按项目解析适配器平台、`shapes` 去 CLI 化、`ctx.host` 能力化与 `sendPrompt` 节奏下沉、`session` 端口转正（7 端口全收口）、编排模板迁入 server（模板/平台参数分离 + golden 守卫）、conformance 套件 + 必填方法自检、`run -r` 最小挂接。每步 `npm test`/`check:arch`/`check:capability`/`lint` 全绿；调度算法与 DSH 适配器均未动（后者属 P2）。详见 §2.4 |
| 2026-09-18 | 建立本文件；登记 T-P0-01～T-P0-14、P1～P4 边界；完成 E-01（隔离环境+版本基线）；E-02 启动；累积 F01～F12 静态发现 |
| 2026-09-18 | **E-02 完成并验证通过**：第三方插件 host/client 两半侧均真实加载（HTTP 往返 200 + boot graph 含自研 bundle）；累积 F13～F17；E-03 启动 |
| 2026-09-18 | E-03 机制确认（per-agent MCP 挂载、按项目起独立 server），但**未跑通一轮**；定位其唯一未解点为「Cordis 激活窗口内的驱动时机」（F21）。累积 F18～F24。真实 `~/.dsh` 配置面全程 `IDENTICAL`，用户 3080 未受影响 |
| 2026-09-18 | **E-03 驱动链路打通**：`ctx.inject` 装配 + `sessionController.prompt(req, signal)` 后，两个项目各跑出一轮真实模型回复（`completed`）。剩余唯一问题：MCP 工具未进入模型可见工具表（F26～F28）。累积 F25～F28 |
| 2026-09-18 | **E-03 完成并验证通过**：`proj-a → 0.2.0\|1`、`proj-b → 9.9.9\|2`（各自 `AWF_PROJECT_ROOT`，未串）。根因是 F29「MCP 工具注册异步，挂载后需等注册完成再派发」。累积 F29/F30；T-P0-06a 关闭。下一步 E-04（worker 权限硬门） |
| 2026-09-18 | **P1 第一批试改并回滚**：`ctx.tmux`→`ctx.host` 改名导致 115 例失败（测试替身按旧名跨变量引用），按纪律回滚，CC 恢复可用；已记录完整改动范围，建议与 T-P1-03 同批做。 |
| 2026-09-18 | **P0 收尾 + 换机准备**：U16（approval 受控自动批准）、U17（C15 用「换新会话+交接」）已确认；压缩补测（F35：存在但属 preset isolate realm）；新增 [`dsh-adapter-handoff.md`](dsh-adapter-handoff.md) 作为换机接续入口。 |
| 2026-09-18 | **T-P0-03 完成**：X1～X9 的 P0 结论已回写 `dsh-adapter-design-codex.md` §8（重写为实测结论表）与 `dsh-adapter-checklist-codex.md`（更新 X9 + 追加同步节），保留历史、区分「已验证/部分/阻塞」。 |
| 2026-09-18 | **E-10（X8）完成（含明确未完成项）**：技能发现为空且有明确原因（`skill-filesystem` 属 agent preset 平面，F18/F32 同源）→ 记入 T-P2-01；**返回体大小问题实测确认**：346KB 全量 / 747B 单任务 / **`summary:true` 静默无效**；安装卸载与发布包验证登记为 T-P2-01/T-P4-02 待办。 |
| 2026-09-18 | **E-09 部分完成 + 新增阻塞 F34**：实测「关闭页面不影响后台运行」（页面不在时任务仍在 running）；但发现**子会话执行 bash 会停在 `approval/asked`**，无人值守 run 会被人工批准卡死 —— 权限策略需决策，先留证据不擅自改。U14 的页面交互约定待用户实机确认。 |
| 2026-09-18 | **E-08（X6/X7）完成**：一次性调用隔离性/用量/取消全部实测通过（未创建会话）；用浏览器桥在隔离实例上确认 **client 半侧真的在浏览器执行并注册** entry（宿主收到 `client-report`）。tab 视觉渲染未确证，登记为逐页指导阶段的绑定方式问题，不阻塞 P0/P2。 |
| 2026-09-18 | **E-11 核对完成**：`-r` 确实没有「查询活跃 run 并挂接」分支（与 `--attach` 共用同一段代码），在单槽宿主下会 409；失联会因 busy 状态无限等待（与平台无关）。按 P0 纪律**不在本轮改 CC 代码**，修复提为显式公共行为任务 **T-P1-06**（U3 已确认范围）。 |
| 2026-09-18 | **E-06（X4）完成**：cancel 的完成信号是 `whenIdle()`（回执≠完成）；默认清队列、`keepInbox` 保留但不自动恢复；**取消父会话不停子 Agent**，停整 run 必须显式 `subagents.interrupt` 每个子 Agent；中断判定不能靠 `turn/end.reason`。reset 候选实测：`fork` 可用但非清空、`compaction` 在 web 组合不存在 → C15 维持 blocked，并给出「新建会话承接交接」的落地建议。 |
| 2026-09-18 | **E-05（X3 护栏）完成**：`agentCtx.tools.guard` 实测在**执行前**拦住被禁工具（服务端无该调用、磁盘未写入，模型如实报告失败）。回合末门阀归 AWF 侧判定（U10），不用 DSH 复刻 CC block 语义。 |
| 2026-09-18 | **实验改为静默运行**：探针后台统一 `--no-open`（新增 `.awf/probe/dsh/serve.sh`，并修 `with-web.sh`），不再弹浏览器。 |
| 2026-09-18 | **E-07（X5）完成**：单任务真实闭环跑通 —— 模型经 AWF MCP 工具把 T-1 标 done，磁盘回读 `pending→done` + `exec.completedAt`；同时确认回合事件序列与 ContentBlock 提取方式。 |
| 2026-09-18 | **T-P0-02 完成（U9）**：37 项能力登记 + `check-capability` 对账门禁 + 7 个负面/正面用例全绿；全量 `npm test` 107/108 文件、1004/1008 用例通过（4 例失败为 PATH 无 `claude` 的环境性前置）。 |
| 2026-09-18 | **E-04（X2）完成**：用户就 U15 选择「保项目隔离」→ MCP 按会话挂载，非 MCP 工具用 `tools.restrict` 硬拦，MCP 工具靠 worker 协议；多 worker 实例互不串。原始 blocked 记录如下（保留）：**既定要求冲突**。实测：全局挂载时 `toolFilter` 的 deny **真能硬拦**（对照组能调、实验组 DENIED、多实例互不影响）；但**会话作用域挂载的工具无法被 `tools.restrict()` 点名**（直接抛 unknown global tool），而项目隔离要求按会话挂载。→ 冲突已作为 **U15** 追加到 `dsh-adapter-checklist-codex.md`（标记未确认），未自行降级。累积 F31～F33 |
