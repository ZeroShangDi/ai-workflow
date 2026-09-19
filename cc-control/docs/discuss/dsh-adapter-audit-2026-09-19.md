# DSH 接入独立审查（2026-09-19）

审查基线：`f01a6e6`，开始审查时工作区干净。依据为 `dsh-adapter-design-codex.md`、用户已确认的 U1～U17（包含 U15 的 MCP 权限例外）、执行记录、handoff、当前生产代码及测试。此次只做审查，未修复生产代码；新增本文和最小复现材料。

**结论：遵循了总体目录划分和一部分实施顺序，但没有完成已确认规划。P2 的生产 CLI 链路存在阻断，P3 的归属、决策、停止、失联、上下文等出口条件未满足。不能把现状定性为“七命令全通，只剩 UI 和增强项”。**

以下严重程度：P1＝应在继续依赖接入能力前修复；P2＝影响特定场景，应纳入本轮收口。没有将未经实测的推测写成平台真机结论。

## 一、已确认问题

### A01 / P1：`awf run` 的 CLI 直接调用 detached bridge，启动路径不能工作

- 位置：`cli/lib/context.cjs:35`、`cli/lib/session.cjs:90`、`cli/commands/run.cjs:139`、`server/adapters/dsh/index.cjs:109`。
- `buildContext()` 在 CLI 内构造 DSH 适配器，没有注入 bridge；`bringUp()` 随后调用 `ensureSession()`，直接执行该适配器的 `kill()` 和 `start()`。这两个都是异步函数，但调用点没有 await。
- 最小复现 R1：`ensureSession()` 返回 `true`，随后出现两个未处理 rejection，分别为 `session.stop` / `session.create` 的“本进程没有 bridge”。默认 Node 行为会导致进程异常退出；即使外层捕获未处理 rejection，也没有创建会话。
- `stopSession()` 和 CLI 的信号退出同样没有等待异步停止。
- 当前真机 `roundtrip.cjs --run` 在 `scripts/probe/dsh/roundtrip.cjs:521` **直接创建 runtime、注入 bridge、调用宿主**，没有执行 `awf run` CLI。这解释了为什么探针通过而生产入口仍有问题。
- 修复方向：会话创建、恢复核对和停止通过常驻 server 的平台无关入口执行；CLI 全链路等待结果。`plan` 的 F41 已解决过相同的跨进程问题，但没有覆盖 `run`。

### A02 / P1：会话按 cwd 取第一条，正常 plan → run 就可能派发到旧会话

- 位置：`dsh-plugin/lib/ops.js:135`；同文件所有依赖 `findSession()` 的 prompt/stop/facts/snapshot/open 操作。
- 查找只检查目录，不检查是否 AWF 创建、会话用途、当前执行绑定或父子身份；缺项目时甚至回退到全局第一条。
- 最小复现 R2：同项目先有 `plan-old`，再调用 `session.create` 得到新执行会话；随后 `session.prompt` 的实际目标仍是 `plan-old`。停止、观察同样会选错对象。
- U2 要求新执行会话，U17 又要求保留旧会话，因此不能靠删除旧对话规避。
- 修复方向：明确保存 project → planning/execution session 的绑定；指令带目标 sessionId，平台同时核对项目和用途。禁止以列表顺序决定执行者。

### A03 / P1：已确认接收但结果超时，会被上层返回为成功

- 位置：`server/adapters/dsh/bridge.cjs:164`、`server/adapters/dsh/index.cjs:149`。
- bridge 超时返回 `{delivery:'accepted', error:…}`，没有 `ok:false`；`must()` 只拒绝 delivery 非 accepted 或 `ok === false`，因此返回 undefined。
- 最小复现 R3：仅回 accepted，不回 result，触发真实超时处理后，`interactive.launchDialog()` 返回 `{ok:true,url:null,sessionId:null}`。`session.start()` 还会据此写入“会话存在”的缓存。
- 另一个同类漏洞是平台 prompt 回 `{accepted:false}` 时，插件仍包在 `ok:true` 结果里，适配器不验证内层受理值。
- 修复方向：送达状态与操作结果分离，只有明确完成且满足该操作后置条件才成功；超时保持 unknown/unconfirmed，不能自动补发。

### A04 / P1：共享 bridge 的事实缓存没有项目维度，串用会话状态

- 位置：`server/adapters/dsh/bridge.cjs:51,107,181`、`server/adapters/dsh/index.cjs:175,207`。
- bridge 是进程级单例，facts 却只有一份；各项目 `hasSession/exists/cwd/capture` 全部读同一份。事件 cwd 过滤发生在刷新共享 facts **之后**，不能隔离缓存。
- 最小复现 R4：仅收到 A 的 started 事件，B 的 `exists()` 返回 true，`cwd()` 返回 `/project-a`。反过来，停止 A 会令 B 的存在性也变 false。
- 修复方向：通道只持有连接级状态；会话事实按规范化项目路径 + sessionId 分开存储，并标明连接代次、采样时间和未知值。

### A05 / P1：子 Agent 有 start 事件就能落账，未验证当前 run / 派发任务归属

- 位置：`server/runtime/index.cjs:175`、`server/run/subagent.cjs:157,171,99`。
- DSH started 事件没有设置 `session.mainSessionId`，因此父会话过滤条件实际不生效。`trackAgent()` 也不绑定 taskId/runId/执行尝试；结算只检查 RESULT 中的 task 是否存在且不是终态，连 pending 任务都可被写成 done。
- 最小复现 R6 使用真实 runtime、解析器、store 和临时 state.json：当前会话已报告为 `execution-current`，旧规划会话 `plan-old` 的 child start/stop 仍被接收，未派发的 `T2:pending` 被写成 `done`，`mainSessionId` 仍是 null。
- “有 start 基线”只证明见过这个 agent，不证明它有权完成这个任务。此问题的 taskId 校验部分也存在于公共结算路径，不能仅在 DSH 插件加提示词修补。
- 修复方向：派发时生成并记录 executionId，绑定 runId/taskId/主子会话；落账在锁内核对当前执行尝试。V06 应加入错 taskId、旧 run、迟到和重复结果。

### A06 / P1：决策门阀之前先唤醒派发者，下一任务能抢先提交

- 位置：`server/runtime/index.cjs:165`、`server/runtime/session.cjs:44`。
- READY 分支先 `session.setReady()` 唤醒所有 waitReady，再异步发决策指令。等待者已获得通行结果，之后 setBusy 不能撤回已 resolve 的 Promise。
- 最小复现 R7 使用真实 runtime/channel：有一个等待就绪的派发者时，收到 `<AWF_DECISION_REQUIRED>` 后实际提交顺序为 `NEXT TASK` → `DECISION INSTRUCTION`。
- 门阀发送失败还仅打印日志，不保留阻断语义。平台回合结束被过早解释成业务可派发，违反 U10。
- 修复方向：先处理回合结束并锁定决策状态，再决定是否释放派发；所有派发入口共用互斥入口，不能只依赖一个 ready 布尔值。

### A07 / P1：停止请求未等真正停止，部分失败仍广播 stopped

- 位置：`dsh-plugin/lib/ops.js:451`、`server/adapters/dsh/index.cjs:224`。
- cancel 返回是否 accepted 没有检查，也没有等待规划中明确要求的 idle 完成信号；子 Agent interrupt 的错误只写进数组，最终仍 `ok:true`、删除 inFlight 并发出 stopped。
- 最小复现 R5：cancel 返回 accepted=false，子 Agent interrupt 抛错，整体仍返回 `ok:true,cancelled:true`，errors 中才看到子 Agent 仍在跑。上层 kill 又把会话标为不存在。
- stop 没有清待执行 inbox 的实现；同文件 interrupt 明确保留 inbox。当前源码不能证明 U11/V04 的“父、子、排队指令全部停止”。
- 修复方向：停止应核对主/子完成状态和队列处理结果；失败/未知保留事实，不能先发 stopped。中断一次回答与停止整个 run 必须有不同后置条件。

### A08 / P1：断线只处理在途 RPC，已经开始的任务仍可能无限 busy

- 位置：`server/adapters/dsh/bridge.cjs:88`、`dsh-plugin/lib/bridge-client.js:50`、`server/runtime/executor.cjs:90`。
- session.prompt 通常在受理后便结束 RPC；模型仍执行时 pending 已空。此时 detach 不通知 runtime 进入失联状态，runtime 仍保留 busy，executor 的 busy 分支永远不累计超时。
- 若 turn/end 的 HTTP 回传丢失，插件仅记日志，无状态补齐；重连也没有会话核对。DSH 插件重启后 createdByAwf/inFlight 的内存集合丢失，旧会话的后续事件不会自动恢复归属。
- 这是代码路径核查，未在本轮重启用户 DSH 实测。风险场景明确：prompt 已受理、任务未落账、随后断线或丢回合结束事件。
- 修复方向：连接/事件连续性成为 runtime 的输入；失联阻止新派发并进入可诊断状态，重连先核对现场。这不要求通用无损崩溃恢复，也不要求重放执行指令。

### A09 / P1：已确认的“换新会话 + 交接”没有接入，仍发送 `/clear` 文本

- 位置：`server/runtime/channel.cjs:98,46`、`server/adapters/dsh/index.cjs:191`、`dsh-plugin/lib/ops.js:386`。
- 公共 compactor 的 clearSession 硬编码 `sendLocalCmd('/clear')`；DSH 路径将它作为普通 content 文本交给 prompt。没有 reset 操作、换会话、交接确认或原生命令执行接线。
- 默认又只挂 awf-state MCP，缺少用于上报 handoff 完成的 awf-session。当前可能根本进不了重置流程；即使外部设置 contextReady，进入后也不满足 U17。
- 修复方向：将 reset/executeCommand 作为真实能力落实，业务层只等待语义完成；不能用定时器把 DSH `/clear` 标成完成。

### A10 / P1：生产资产装配没有覆盖规划命令和专用 worker，batch 使用不完整的替代协议

- 位置：`dsh-plugin/lib/ops.js:150,183`、`plugin/plugin-code/prompts.json:1,26`、`plugin/core/agents/awf-worker.md:1`。
- 建会话只挂 standard preset 和默认 awf-state MCP；安装器只复制桥接插件。没有将 AWF commands/skills/worker 挂载到 DSH 的生产实现。
- planEntry 仍输出 `/ai-workflow-code:w-plan`，没有 DSH 资产发现/命令解析配套；创建会话且收到回复不能证明执行了规划流程。
- DSH 的 worker 参数明确写“没有 awf-worker 身份”，改用普通 subagent + 缩写 RESULT 提示。没有落实非 MCP 工具限制；相较原 worker 正文还漏掉门禁 verdict/architecture 协议等内容。
- U15 仅批准会话级 MCP 权限例外，不能推导为免除专用身份、非 MCP 限制及完整 worker 协议。
- 修复方向：复用现有资产正文，提供 DSH 的发现/挂载/身份描述层；生产测试验证实际工具面、规划产物、review/test 非 pass 的修复闭环。

### A11 / P1：桥接入口没有实例鉴权，任意连接能替换当前插件通道

- 位置：`server/web/api/index.cjs:110,163`、`server/web/bridge-channel.cjs:52`。
- WS 仅按路径和 WebSocket key 握手，pluginVersion 是自行声明的查询参数，没有 token/实例校验，也未验证 Origin；attachSocket 直接覆盖全局 socket。
- callback 只要求 JSON object，平台事件甚至不要求 commandId；没有绑定当前连接代次。旧实例和非插件调用方都能提交状态事件。
- 因为服务监听 loopback，此项不是“公网直接可访问”的结论；但 loopback 不是实例鉴权。能连接该端口的本地调用方可抢占通道、接收下行，且不符合 spec 的实例/版本绑定要求。浏览器风险还取决于其本地网络访问策略，本轮未做浏览器攻击测试。
- 修复方向：实例凭证、严格握手/来源校验、版本兼容判断及回传代次核对。未知或缺身份的事件拒绝，不能广播到所有项目。

### A12 / P2：项目卸载直接移除共享插件，影响其他已启用项目

- 位置：`cli/commands/plugin.cjs:56`、`server/adapters/dsh/install.cjs:169`。
- `awf plugin uninstall` 直接摘全局 profile 块并删除全局插件目录，没有本项目禁用操作或其他项目使用检查；本项目的 runtime.adapter 还会保留 dsh。
- 两个项目都已启用时，从 A 执行该命令会破坏 B 在重新加载/重启后的接入。违反 U5 的“全局安装、项目分别启用；注销 A 不卸掉 B 的共享插件”。
- 修复方向：分离 enable/disableProject 和共享包 install/uninstall；单项目注销不删除全局包。

### A13 / P2：用于落账的文本被按展示快照截断，末尾 RESULT 会丢

- 位置：`dsh-plugin/lib/ops.js:88,96`、`dsh-plugin/index.js:128,155`。
- `lastAssistantText()` 默认只保留前 8000 字符；turn reporter 直接拿这份 text 做 RESULT/NEEDS_INPUT/决策解析，并丢弃 truncated 标志。
- worker 协议要求 RESULT 在最后一行。一条超过 8000 字符的报告会稳定丢掉关键尾部，导致任务不结算、补发或 blocked；无需模型异常即可触发。
- 修复方向：展示快照和协议提取分开；在完整的本回合内容中提取结构化结果，输出受控大小的结构化事件。不应扫描到上一轮文本后冒充本轮结果。

## 二、是否按规划实施

| 阶段/约定 | 判断 | 依据 |
|---|---|---|
| P0 先验证平台关键机制 | 基本遵循，有较完整历史记录 | 有隔离探针、冲突登记，U15/U16/U17 有确认；本轮未重新证明所有历史实测 |
| P1 按项目装配、host/session 收口、模板分离 | 主要结构已落地，但语义收口不足 | resolver、端口工厂、模板迁移存在；同步/异步调用、reset、metrics、CC hook 形状仍未统一 |
| P2 init → plan → run 最小完整链路 | **不满足出口** | A01 直接阻断 CLI；A02 令同项目连续流程选错会话；已有探针绕过真实 CLI |
| P3 全能力与异常路径 | **未完成** | A03～A10；上下文、归属、决策顺序、停止/失联都不是仅“待补真机截图” |
| P4 三个空页面和安装包 | 部分落地 | 空页面符合 U4，不应要求本轮补完整 UI；但 AWF 独立 SPA 占位不等于 DSH 原生插件受鉴权 UI/暂停输入接线，项目卸载语义也不满足 |
| U3/U13 最小恢复 | 部分/不足 | run -r 有查询活跃 run 的代码，但在它之前已走错误 bringUp；plan -r 只换提示词，新建会话时没有原对话核对及明确丢失说明 |
| C05 自动准备后台 | 未完成 | plan 依赖先手动 `awf server start`，生产代码没有 ensure DSH 后台能力；init 安装提示重启，不等于 plan/run 自动确保可用 |
| C25～C28 观测 | 部分/未完成 | 插件有 snapshot op，但公开 host.capture 只读没有被填充的缓存，probe 不取文本；上下文用量和进度仍读 CC 文件，原生 token/速度未接入 |
| C22/U14 提问与人工介入 | 未完整接入 | 生产插件没有 tools.guard 或输入框暂停按钮接线；P0 探针验证能力存在不等于生产已经使用 |

原 spec 的 P3 明确以 C01～C30/C33～C36 达到约定语义为出口，不能用执行记录后来“只标剩余未做”替代原验收要求。U4 的完整业务 UI 和 U8 的首次响应时间确实不属于本轮必交，不应误报为遗漏。

## 三、抽象、架构、解耦与边界

总体分层方向可保留，**不建议重写 scheduler**。应修的是下面几个跨模块契约：

| 边界 | 当前问题 | 建议 |
|---|---|---|
| CLI ↔ runtime | 外观看似统一 session 端口，实际 CC 同步、本地可调用；DSH 异步、必须在 server | CLI 用统一 server 用例入口；端口明确异步返回与结果语义 |
| 项目 ↔ 会话 ↔ run ↔ task | cwd 被当作执行身份，缺持久最小绑定 | 引入最小执行归属记录，不建设通用事件库；所有派发/回报核对同一身份 |
| 通道 ↔ 业务状态 | 共享 facts、缺断线领域通知、平台 READY 等于可派发 | 通道只报告事实；runtime 负责状态转换和派发许可 |
| decision ↔ adapter | 领域层仍生成 ccOutput，runtime 再读 ccOutput.reason | 决策返回平台无关的 block/continue/instruction；各 adapter 编码自己的控制语义 |
| 观测 ↔ 控制协议 | 展示截断文本被复用来落账，原生观测仍绑 CC 文件 | 完整协议提取与可截断快照分离；usage/progress/history 提供明确未知状态 |
| tooling ↔ 安装 | DSH tooling.install 发送插件明确拒绝的 plugin.install，真实 CLI 却绕到 tools.profile | 一个对外职责只保留一条有效实现路径；不为凑七端口返回必败方法 |
| 资产 ↔ 平台参数 | 只替换工具名字，完整 worker/技能协议没有挂载 | 业务正文单源，平台描述层负责注册与权限，不复制缩写版业务正文 |
| 生命周期 ↔ 订阅 | adapter 注册 channel.onEvent 后未保存退订；runtime.reset 没有解除它 | adapter/runtime 提供明确 dispose，避免项目重建后重复处理回报 |
| 验收 ↔ 宣称 | conformance 假 bridge 对所有 op 回成功，“不抛”即通过；架构门禁未覆盖 dsh-plugin 层 | 保留结构检查，增加生产 CLI、负面回执、多会话/双项目、门阀并发行为测试 |

## 四、本轮证据与验证范围

- `npm run check:arch`：通过（193 个生产文件，0 越界/豁免）。只证明所配置的结构约束。
- `npm run check:capability`：通过；实际登记为 implemented=3、partial=24、planned=8、blocked=1、unsupported=1，并非 37 项实现完成。
- DSH 定向测试：8 个文件、125 项通过；另在允许本地端口监听的环境跑 `dsh-plan-route.test.js`，3 项通过；合计 **9 文件/128 项通过**。
- 全量 `npm test` 在初始受限沙箱中：102 文件通过、19 文件失败，969 项通过、16 项失败、208 项跳过，20 个 error。日志包含本地 `listen EPERM`、tmux socket 权限错误及后续连接失败；**不能将这个结果当成产品 16 个 bug，也不能宣称全量回归通过**。本轮没有解除限制重跑全部会接触外部进程的测试。
- 新增 7 组最小缺陷复现：R1～R5 在 `dsh-audit-2026-09-19/boundary-repro.mjs`，R6～R7 在 `runtime-repro.mjs`，输出随文件保存。它们使用真实项目模块 + 平台替身，不调用模型、不操作真实 DSH，不等同于 DSH 真机验收。
- 本轮没有修改用户真实 `~/.dsh`，没有启动/停止其 DSH，没有调用真实模型，没有修改生产实现。

复现命令（仓库根目录执行；当前实现下应观察到报告描述的错误行为，脚本是取证工具而非通过/失败测试门禁）：

```sh
node docs/discuss/dsh-audit-2026-09-19/boundary-repro.mjs
node docs/discuss/dsh-audit-2026-09-19/runtime-repro.mjs
```

## 五、建议修复顺序与收口条件

1. **先修身份与生产入口**：A01/A02/A04/A05。否则更多 happy-path 探针只会继续绕过真正问题。
2. **再修控制语义**：A03/A06/A07/A08/A11；区分受理、完成、未知、断线和业务允许继续。
3. **补齐约定能力**：A09/A10/A12/A13、自动准备后台、C22/U14、观测与最小恢复，逐项回填能力表。
4. **以真实入口验收**：同一干净项目连续执行 init → plan → run → run -r；同项目至少保留一个规划会话和一个旧执行会话；双项目同时运行、停/卸 A 不影响 B；断线/重启后未知状态不成功、不重发、不无限 busy；review/test 非 pass 走完整门禁修复。
5. **最后更新交付口径**：报告只追加，不改历史用户回答；删除“七命令全通”这类超过证据的当前结论，给每项能力挂对应行为验收。完整业务 UI 仍按 U4 后续指导。
