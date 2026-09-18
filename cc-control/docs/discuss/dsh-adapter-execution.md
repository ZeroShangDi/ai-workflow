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
| T-P1-01 | P1 | `ports.cjs` 按项目解析 adapter + `ccShapes`→`shapes` 去 CLI 化；**不改**调度算法 | pending |
| T-P1-02 | P1 | `ctx.tmux` → `ctx.host` 能力化；`ENTER_DELAY_MS` 下沉进 cc 实现。**本轮试改后回滚**：见下方「T-P1-02 试改记录」 | pending |
| T-P1-03 | P1 | `cli/lib/session.cjs` 5 处 tmux 直连 + `attach.cjs` 收口；`session` 端口转正 | pending |
| T-P1-04 | P1 | 编排模板迁入 server（模板与平台参数分离）；技能/worker/决策资产保持单源 | pending |
| T-P1-05 | P1 | 测试分层：编排层 CLI 无关 + conformance 套件 + 契约自检（可执行必填方法名断言） | pending |
| T-P1-06 | P1 | **`run -r` 最小恢复修复**（把「查询活跃 run 并挂接」补进 `-r` 分支，与 `--attach` 同路径；不新增崩溃恢复、不自动重置 active）；提为显式公共行为修复（U3 已确认） | pending |
| T-P2-01 | P2 | `server/adapters/dsh/` awf 侧 + 插件 host 半侧：WS 指令下行 + HTTP 回传 | pending |
| T-P2-02 | P2 | init/plan/run 的 DSH 接线（后台全局单实例、新建规划会话注入、run 新建执行会话） | pending |
| T-P3-01 | P3 | batch 走 DSH 原生子 Agent + 结果归属校验（旧结果不覆盖新执行） | pending |
| T-P3-02 | P3 | 决策/上下文/观测在 DSH 下的接线；`run -r` 最小恢复行为 | pending |
| T-P4-01 | P4 | 三个业务页面**空页面** + 项目/无会话入口（U4，后续逐页指导） | pending |
| T-P4-02 | P4 | 干净环境安装/卸载/升级；能力矩阵区分「占位」与「完成」 | pending |

#### T-P1-02 试改记录（2026-09-18，**已回滚**）
- 试改内容：`server/runtime/project.cjs` 注入键 `tmux`→`host`；生产侧 20 处 `ctx.tmux.*`→`ctx.host.*`；测试替身键 `tmux:`→`host:`。
- 结果：**115 例测试失败**（5 个文件）。原因：测试替身被**跨变量名引用**——`tests/integration/server.test.js` 用
  `global.__CC_TMUX__ = m.tmux` 与 `m.tmux.hasSession`，`tests/unit/server-layering.test.js` 断言 `rt.ctx.tmux.hasSession`；
  只改注入键、不改这些引用，替身取不到。
- 处置：**按 P1 纪律回滚**（CC 必须可用），回到 `107/108 文件、1005/1009 用例`（仅 4 例无 `claude` 的环境性失败）。
- **下次要一次做完的范围**（避免再半途）：生产侧 6 个文件 + 测试侧 4 个文件（`decision.test.js`/`decision-gate.test.js`/
  `one-server-two-projects.test.js`/`server.test.js`）+ `tests/unit/server-layering.test.js` 的断言 + `global.__CC_TMUX__` 改名。
  建议与 T-P1-03（`session` 端口转正）**同批**做，因为都动 `cli/lib/session.cjs` 与 host 端口面。
- 另附：`.awf/probe` 探针夹具**不进 git**（已确认未跟踪），全部内容随 `/tmp/awf-dsh-p0-handoff.tar.gz` 转移。

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
