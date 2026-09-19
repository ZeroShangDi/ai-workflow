# DSH 接入：换机接续上下文（cross-machine handoff）

> 目的：**换一台电脑也能在 15 分钟内接着干**。本文件是唯一的「新机器上手」入口；
> 细节在执行记录，设计在执行 spec，用户取舍在 Codex 清单。三份文件的分工见 §2。
> 最后更新：2026-09-19（P1 全部完成、进入 P2 前）。

---

## 0. 30 秒摘要

- 任务：按已确认 spec 把 AWF（ai-workflow）接入 DSH，覆盖全七命令，P0→P4 分阶段推进。
- **当前阶段：P1（CC 契约收口）已完成**（T-P1-01～06 全部收口，6 个提交）；**下一步进入 P2（DSH 最小完整链路）**。
- P0 已完成并验证：插件加载、会话级 MCP 多项目隔离、worker 权限边界（U15 已定）、decision 护栏、
  单任务真实落账、一次性隔离调用、取消/父子停止语义、UI 入口可执行。
- P1 已完成：按项目解析平台（`resolveProjectAdapters`）、7 端口全收口（`session` 转正）、
  `ctx.host` 能力化 + 派发节奏下沉、编排模板迁入 server、conformance 套件、`run -r` 最小挂接。
- **两个待接线项**（已有确认结论，属 P2 实现）：`approval` 受控自动批准（U16）、上下文清空用「换新会话+交接」（U17）。
- P0/P1 全程遵守：不越权动用户真实 `~/.dsh`、CC 路径保持可用、实验静默运行（`--no-open`）。

---

## 1. 新机器 15 分钟启动清单

```bash
# ① 取仓库（分支 feature/cc-control-v0.2.0）
cd <你的仓库父目录>
git pull                      # 或 clone 后切到 feature/cc-control-v0.2.0

# ② 关键：把未提交的 P0 产出带过来（见 §3 的「必须先做」）
#    若上一台机器已按 §3 提交/打包，这步跳过

# ③ 装依赖并验证基线
cd cc-control
npm install
npm test                      # 期望 110/110 文件、1043/1043 用例通过
npm run check:capability      # 期望 ✓ 对账通过
npm run check:arch            # 期望 结构门禁通过

# ④ 造隔离实验环境 + 起静默探针后台（不要用真实 ~/.dsh！）
bash scripts/probe/dsh/guard.sh snapshot      # 实验前记真实 home 配置面指纹
bash scripts/probe/dsh/install-fixture.sh     # 离线装配（本机无 pnpm）
bash scripts/probe/dsh/serve.sh start
bash scripts/probe/dsh/serve.sh wait          # 输出 [serve] ready + 带 token 的 URL
```

**若 `npm test` 有 4 例失败**：几乎一定是 `tests/unit/init.test.js`，原因是该机器 PATH 上没有 `claude`
（该文件第一例就叫「本机三项齐备（真机用例的前置条件）」）。有 `claude` 的机器上应全绿
（2026-09-19 P1 收口机即为全绿 110/110、1043/1043）。

实验收尾（**必做**）：`bash scripts/probe/dsh/serve.sh stop && bash scripts/probe/dsh/guard.sh check`，
必须 `IDENTICAL`。

---

## 2. 文档分工（先读哪个）

| 文件 | 作用 | 何时读 |
|---|---|---|
| **本文件** | 换机上手、环境、未提交产出、下一步 | **先读这个** |
| `docs/discuss/dsh-adapter-execution.md` | 执行记录：任务板、每项验收、证据、**F01～F37 发现表**、变更日志 | 干活时随时查 |
| `docs/discuss/dsh-adapter-design-codex.md` | 设计 spec：§8 是 **X1～X9 的 P0 实测结论表**；§7 是 P0～P4 | 需要设计依据时读 |
| `docs/discuss/dsh-adapter-checklist-codex.md` | 用户取舍清单：U1～U17（**U15/U16/U17 是本轮新增并已确认**） | 拿不准是否已决策时读 |
| `CLAUDE.md`（仓库根 cc-control/） | 项目结构与开发规范 | 第一次接触仓库时读 |

**历史文档**（设计依据追溯用，不要当当前状态）：`dsh-adapter-checklist.md`、`dsh-adapter-design.md`（DS 原始稿）。

---

## 3. 换机：一切都在 git 里

**P0 / P1 / P2 起步的产出都已提交**。换机 `git pull` 即可，没有需要手工带走的文件。

**P2-3 起探针夹具已进 git**：`scripts/probe/dsh/`（P0 那版在 `.awf/probe/dsh/`，被 `.awf/` 的 ignore 吞掉，
换机时真的丢过一次，代价是从零重建）。隔离 home `/tmp/awf-dsh-probe` 是**可抛弃的运行态**，
用 `scripts/probe/dsh/install-fixture.sh` 一条命令重建；`/tmp` 重启清空也无所谓。

```bash
bash scripts/probe/dsh/install-fixture.sh   # 重建隔离 home 的 profile + 装配探针插件
bash scripts/probe/dsh/guard.sh snapshot    # 实验前
bash scripts/probe/dsh/guard.sh check       # 实验后必须 IDENTICAL
```

重建要点与踩过的坑见 `scripts/probe/dsh/README.md`。

---

## 4. 环境事实（换机后需重新确认的点）

| 项 | 本机（P0 验证基线 / 2026-09-19 复核） | 换机后要做什么 |
|---|---|---|
| DSH 版本 | launcher **0.1.5-rc.1**（`dsh --version`），内部包 **0.1.5-rc.2** | `dsh --version` + `node -e` 读内部包版本；版本不同则 X/F 结论需复核 |
| 用户真实 DSH home | `~/.dsh`，**有正在运行的 `dsh web`（127.0.0.1:3080）** | **绝对不要动它**；实验一律用隔离 `DSH_HOME` |
| 隔离实验 home | `/tmp/awf-dsh-probe`（重建见 §3） | `/tmp` 重启会清空 → 重跑 `install-fixture.sh` |
| 实验端口 | `39081`（探针）/ `3080`（用户） | 39081 被占则设 `AWF_PROBE_WEB_PORT`（`serve.sh` 用 CLI `--port`，不写 patch —— F14 的坑已绕开） |
| pnpm | **本机没有** → `dsh plugin add` 不可用 | 有 pnpm 的机器可直接用官方路径；没 pnpm 就用 `install-fixture.sh` 的离线等价装配（F13） |
| 浏览器桥（bbx） | 可用（用于 UI 真实页面验证） | 需要时由你在扩展里启用；不用也不影响 P2 |
| `claude` 命令 | P0 机器 PATH 上**没有** → init 相关 4 例预期失败 | P1 收口机（2026-09-19）**有** `claude` → 110/110 全绿；换机后以实测为准 |

---

## 5. 探针环境（已进 git，随时可重建）

夹具在 **`scripts/probe/dsh/`**（P2-3 重建并纳入 git），不再是需要「打包带走」的东西：

```
scripts/probe/dsh/
  env.sh                强制 DSH_HOME=/tmp/awf-dsh-probe + 防呆（指向真实 home 直接报错）
  guard.sh              真实 ~/.dsh 配置面指纹（snapshot|check）
  install-fixture.sh    离线装配 profile + 符号链接**两个插件**（探针 + 生产）+ 写 patch 层
  serve.sh              静默起停 start|wait|stop|url（--no-open）
  roundtrip.cjs         AWF ↔ 插件 指令通道真实链路验证（起隔离 AWF + 隔离 DSH，断言回执）
  fixtures/probe-plugin/ 探针夹具（HTTP 路由，用于存活/能力侦查）
  README.md             用法 + 重建坑位
dsh-plugin/             AWF 的 DSH host 半侧（生产插件，profile 里以符号链接装入）
```

端口不再用 include patch 覆盖（那是浅覆盖，F14 的坑）——直接走 CLI `--port`。

**关键经验（重建时最容易踩的坑）**
1. 插件运行时装配必须放 **`ctx.inject([...services], cb)`**；放 `apply` 顶层或 `setTimeout` 之后都会命中非活动上下文（F25）。
2. `sessionController.prompt(request, signal)` 的 **signal 是第二位置参数**（F26）。
3. MCP 工具注册**异步**：挂载后立刻提问会看到「没有该工具」；派发前必须等注册（F29）。
4. 判定「工具是否可用」看 **`session.requestHeader().tools`**，不要用 `agent.ctx.tools.get`（F30）。
5. `workspace-write` 等 preset 的贡献在 **agent 平面的 isolate realm**，root ctx / `agent.ctx` 都可能取不到（F32/F35）。
6. include patch 的 `config` 是**浅覆盖**，覆盖 `webserver` 必须给全 `host`（F14）；本夹具改走 CLI `--port` 绕开。
7. `dsh web` 是 `--profile web` 的**别名**，不接受父级 `--profile`：自定义 profile 用 `dsh --profile X --port … --no-open`（F37）。
8. **插件注册的路由不在 dsh 的浏览器信任栅栏内**（F36）：`/`=401 而 `/api/awf-probe/ping`=200
   —— Web→AWF 的入口必须**自己做鉴权**，不能假设挂在 `/api` 下就受保护。

---

## 6. 现在该做什么（P2 入口）

**P0 状态**：T-P0-01～T-P0-14 全部收口，唯一遗留是 **T-P0-12 的 U14 实机确认**（需要你在真实页面确认
「执行中输入禁用 / 暂停 AWF 按钮 / 响应结束后介入」三条；不影响 P2）。

**P1 状态：已完成（2026-09-19，6 个提交）**

| 编号 | 交付 | 提交 |
|---|---|---|
| T-P1-01 | 按项目解析平台（`resolveProjectAdapters` / `ADAPTER_PLATFORMS`）+ `shapes` 去 CLI 化 + 依赖检查下沉 | `093fea3` |
| T-P1-02 | `ctx.host` 能力化 + `host.sendPrompt`（`ENTER_DELAY_MS` 下沉）+ 注入缝/替身同批改名 | `499b58e` |
| T-P1-03 | `cc/session.cjs` + CLI 零 tmux 直连 + `session` 端口转正（7 端口全收口） | `499b58e` |
| T-P1-04 | 编排模板迁入 `server/templates/prompts.json` + 插件 `platform-vars` + golden 守卫 | `ef1e286` |
| T-P1-05 | `tests/conformance/` 一致性套件 + `REQUIRED_PORT_METHODS` 可执行自检 | `ec92a50` |
| T-P1-06 | `run -r` 最小挂接（不重复提交、不新增崩溃恢复） | `e7074ec` |

**P1 出口状态（本机实测）**：`npm test` **110/110 文件、1043/1043 用例**；`check:capability` ✓；
`check:arch` ✓；`lint` ✓；`build` ✓。（与 P0 记录不同：本机 PATH 上有 `claude`，无环境性失败。）

**P2 进度（2026-09-19）**：P2-1 ✅ C30 读边界 · P2-2 ✅ DSH API 前置核对（含 U16 机制更正）·
P2-3 ✅ 隔离探针（进 git）· P2-4 ✅ AWF 侧 7 端口 + 指令通道 · **P2-5a ✅ 插件 host 半侧 + 指令通道真实链路**
（`dsh-plugin/` + `scripts/probe/dsh/roundtrip.cjs`；`dsh` 仍 `not-landed`）。
**P2-5b（第一段）✅ 会话创建/停止真实跑通**（`session.create` preset=standard、`interrupt`/`stop` 走 cancel+逐个打断子 Agent、U16 应答者先「只记录+委派」；未派模型）。
**P2-5c ✅ 提交/回执与回合结束真派模型跑通**（`prompt(request, signal)` → `accepted`；`ctx.on('session/event')` 捕 `turn/end` → `session.ready`；两者分开上报）。
**P2-5d ✅ P2 核心出口打通**：会话创建走「发布前 setup」完整配方（模型选择 + preset + 会话级挂项目 MCP）；真派一轮模型实测 **20 个 `mcp__awf-state__*` 进工具表、模型调用后磁盘 state.json 落账 T1=done**。
**P2-5e（第一段）✅ 快照 + U16 取证**：`session.snapshot` 实测拿回模型真实输出；**U16 结论**：workspace-write 下项目内 bash **不触发批准**（沙箱已 auto-allow），故「项目内自动批准」无需额外规则 —— 保持「只记录+委派」即可，项目外 fail closed。
**P2-5f ✅ 规划入口 + 一次性调用**：`plan.launch`（建规划会话 + 注入指令 + 网页 URL）、`llm.oneshot`（真返回文本、未建会话）实测通过；`plugin.*` 归属澄清为 **CLI 侧**（T-P2-02）。
**P2-6a ✅ `dsh` 已转 `factory`**：入口注入 bridge（adapters 不反向依赖 web），`roundtrip --runtime` 实测「项目配置 → 解析 dsh → 适配器 → bridge → 插件」整条通路（adapter=dsh、session.start、probe.inspect=ready、kill）。
**P2-6b ✅ P2 出口「单任务 run」真实跑通**：`roundtrip --run` 得 **run=done T1=done**（建会话 → 宿主派发 → 模型经 MCP 落账 → run 收尾）；期间修掉一处 **P1 回归**（executor 结算循环引用已删的 `sleep`，CC 也受影响），并补了真 executor 的回归护栏。
**P2-6c ✅ CLI 装配路径可用**：`awf plugin install/uninstall` 在 DSH 项目上装/卸 profile（`server/adapters/dsh/install.cjs`），真 `dsh --dump-config` 确认 DSH 接受；适配器支持无 bridge 构造（CLI 只需工具面）。
**P2-6d ✅ 双项目隔离真实验收**：单后台 + 两项目各自会话与项目 MCP，A→`0.2.0|T-A`、B→`9.9.9|T-B` 互不串，停 A 不影响 B（顺带修掉「指令没带 projectRoot」这个多项目致命缺陷）。
**P2-6e ✅ 子 Agent 停止链路真机打通**：子 Agent 真派出（`session.children` 按 `header.parentSession` 认出）→ 停 run 时**先取名单 → cancel 父 → 逐个 `subagents.interrupt`**（F39 权威要带 `parentSessionId`、F40 cancel 后会摘出活动列表）；停止回执不再被吞。
**P2-6f ✅ `awf attach` 有落点 + init 记住平台**：网页形态经 server `/probe` 拿本项目会话地址（CLI 进程没有 bridge）；`awf init` 把解析到的平台记进 `.awf/config.json` 并修掉 CLI 装配路径吞掉 `CC_ADAPTER` 的缺陷；会话身份按 realpath 规范化（F38）。

**P2 状态：已收口（2026-09-19）**。T-P2-01（`server/adapters/dsh/` + 插件 host 半侧）与 T-P2-02（init/plan/run 的 DSH 接线）均已落地，`ADAPTER_PLATFORMS.dsh.status` = `factory`。
七个命令真机状态：`init` / `run`（单任务）/ `plugin` / `attach` ✅；`plan` / `server` / `open` 🟡（各有一条实测落到平台，缺整链）。
V03、V08 两条验收完整通过，其余「已验一半 + 缺口明确」—— 对照表见执行记录 §2.18。
剩余按性质归 **P3**（决策/门禁/多 agent/续跑/重启组合）与 **P4**（三个业务页面、项目/无会话入口、发布包新目录安装）。

**P2 已明确的接线项（来自 P0 结论，避免重复试错）**
- 建会话：`sessionController.create` + `setup: installModelSelection + agentPresets.mount`（缺一即「裸 agent」，F19）。
- 挂 MCP：**会话作用域** `agentCtx.plugin(McpClient, {env:{AWF_PROJECT_ROOT}})`，派发前等注册（F29/E-03）。
- 派发：`sessionController.prompt(request, signal)`（F26）。
- 停止：`cancel()` 只是发起，**完成信号是 `whenIdle()`**；停整 run 要**逐个 `subagents.interrupt`** 子 Agent（E-06）。
- approval（U16，**落地机制已更正**）：会话保持 `workspace-write` 预设，插件在 AWF 创建的 agent 作用域内
  `ctx.on('approval/request', …)`——范围内 `'allowed-once'`、范围外 `next()` 委派。
  ⚠️ **不要**按 U16 原文的 `permissionPresets.set(session,'workspace-write')` 接线：该预设的 approval 是 `ask` 不是 `never`，
  且 `never` 是自动拒绝而非自动批准（详见执行记录 §2.5 B/C，清单 U16 更正节）。
- 上下文：**换新会话 + handoff 快照**（U17）；压缩需在 preset 同 realm 接线（F35）。
- 返回体：`awf_read_state` 默认全量 346KB、`summary:true` **静默无效** → 必须做真摘要 + 未知参数报错（E-10）。
- 资产：技能/命令属 **agent preset 平面**，不能假设全局根目录被发现（E-10 A）。
- 适配器落点（P1 已备好）：实现 `server/adapters/dsh/` 的 `createDshAdapters(opts)` 并注册进
  `ADAPTER_PLATFORMS.dsh`（status 转 `factory`、`impls`/`tools`/`checks` 齐备），
  `tests/conformance/adapters.conformance.test.js` 会**自动**把 dsh 纳入同一套契约断言。

---

## 7. 纪律（别丢）

1. **不动用户真实 `~/.dsh`**：实验前 `guard.sh snapshot`，实验后 `guard.sh check` 必须 `IDENTICAL`。
2. **实验静默**：一律 `--no-open`，不弹浏览器。
3. **证据分类**：静态核查 / 替身测试 / 真实运行 三类分开说；「假件通过」≠「DSH 可用」。
4. **失败不降级**：worker 权限、子 Agent 身份等既定要求不满足时，记录冲突并回报，不自行改用弱实现。
5. **未知不装成功**：无法核实的结果不得显示为成功。
6. **保留历史**：文档追加不覆盖；用户原始回答不修改；未提交文档不丢弃。
7. **新取舍进清单**：追加到 `dsh-adapter-checklist-codex.md` 并标「未确认」，同时同步到执行记录。

---

## 8. 变更日志

| 日期 | 变更 |
|---|---|
| 2026-09-19 | **P2-6d 完成**：双项目隔离实测通过；修掉「指令缺 projectRoot」缺陷。§6 进度切到 P2-6e（子 Agent + P2 收口） |
| 2026-09-19 | **P2-6c 完成**：CLI 装配路径（awf plugin install → DSH profile）真实可用并被 DSH 承认；适配器支持无 bridge 构造。§6 进度切到 P2-6d |
| 2026-09-19 | **P2-6b 完成**：DSH 单任务 run 真实跑通（run=done T1=done）；平台事件接入 runtime 会话态；CLI bringUp 平台感知；修掉 P1 回归（executor `sleep`）并加护栏。§6 进度切到 P2-6c |
| 2026-09-19 | **P2-6a 完成**：`dsh` 转 `factory` 并实测 runtime 路径全通（项目配置解析 → 适配器 → 插件建会话 → probe ready）。§6 进度切到 P2-6b（CLI 三命令接线 + 双项目验收） |
| 2026-09-19 | **P2-5f 完成**：plan.launch 与 llm.oneshot 真实跑通（含两个实测踩点：平台 message 形状、delta 只认一次）；plugin.* 归 CLI。§6 进度更新 |
| 2026-09-19 | **P2-5e（第一段）完成**：快照实测通过；U16 取证结论 —— 项目内 bash 不触发批准（沙箱 auto-allow），无需自动批准规则，保持委派即可。§6 进度更新 |
| 2026-09-19 | **P2-5d 完成**：会话级挂项目 MCP 打通并真落账（20 个 mcp__awf-state__* 工具可见 → 模型调用 → 磁盘 state.json T1=done）。关键校准：MCP 必须在 **agent 发布前的 setup** 里挂；`requestHeader().tools` 首次请求前恒为空，核对点只能在首次派发之后。§6 进度切到 P2-5e |
| 2026-09-19 | **P2-5c 完成**：真派一轮模型验证「平台受理 ≠ 回合结束」——`session.prompt` 拿到 accepted 后，事件序列 turn.started → prompt.submitted → session.ready，facts.ready 复位。§6 进度切到 P2-5d（挂 MCP / 快照 / 真落账） |
| 2026-09-19 | **P2-5b（第一段）完成**：隔离探针上真实建出 DSH 会话（preset=standard）、facts 翻转、stop 只 cancel 不删会话；U16 应答者先「只记录+委派」。§6 进度切到 P2-5c（派模型那一段）。未派模型、真实 home `IDENTICAL` |
| 2026-09-19 | **P2-5a 完成（指令通道真实链路）**：新增生产插件 `dsh-plugin/`（host 半侧）与 `scripts/probe/dsh/roundtrip.cjs`；§5 夹具清单补两项；§6 进度更新为 P2-5b（建会话/派发/落账，要派模型）。实跑：`session.facts` 回真实现场事实、未实现 op 显式失败、真实 home `IDENTICAL` |
| 2026-09-19 | **P2-4 完成（AWF 侧适配器 + 指令通道）**：§6 进度更新为 P2-5。AWF 侧已可按协议发指令/收回报，但 `dsh` 仍 `not-landed`（插件 host 半侧待 P2-5）——解析会显式拒绝，别误以为 `server/adapters/dsh/` 存在就等于能用 |
| 2026-09-19 | **P2-3 完成**：探针夹具重建并**纳入 git**（`scripts/probe/dsh/`）——§3 从「只剩 `.awf/probe/` 要打包」改为「一切都在 git」；§5 改为「夹具已进 git，随时可重建」+ 新增 F36/F37 两条坑；§1 启动清单改用脚本；实验已实测 `ping` 200 / 真实 home `IDENTICAL` |
| 2026-09-19 | **P2 启动**：C30 读边界完成（`awf_read_state` 缺省摘要/`full:true`/未知参数报错）；§6 的 approval 接线项按源码核对更正为「批准应答者缝」写法；新增本机环境事实（`dsh` 0.1.5-rc.1、探针 home 与 `.awf/probe/` 丢失 → 先做 P2-3 重建） |
| 2026-09-19 | **P1 完成，接续信息切到 P2**：状态摘要/启动清单基线（110 文件、1043 用例）/§3（产出已全部提交，只差 `.awf/probe/`）/§6（P2 入口 + 适配器落点）全部按 P1 收口后的实际情况改写 |
| 2026-09-18 | 建立本接续文件；P0 收尾；登记 U15/U16/U17 与 F01～F35；给出 P1 入口与 P2 接线清单 |
