# T3-011 全量真机回归门禁（`--case all`）

> 门禁任务 T3-011 · 2026-09-11 · 非真模块核查之外的**真机全量**门禁。
> 入口：`npm run test:real -- --case all --port 8799 --clean`（隔离端口 8799，跑当前工作树；
> 常驻 8787 的 server 是旧代码，不带 `--port` 会得到失真结论）。基线 HEAD `e6385ec`，工作树未提交。
> 证据：`sandbox/regression/evidence-all.json` + 13 份 `evidence-<case>.json`（均为本轮产物）。

## 一、执行概要

| 轮次 | 命令 | 结果 | 说明 |
|---|---|---|---|
| ① | `--case all --port 8799 --clean` | **128/150**，22 项失败 | 全量连跑首跑；失败全由**测试侧顺序缺陷**造成（见 §二） |
| ② | 修 harness 后同命令 | **145/150**，5 项失败 | `decision` 1、`pause` 1、`pause-release` 2、`init` 1 |
| ③ | 同命令（复核 + 取统一证据） | **146/150**，4 项失败 | `decision` **本轮通过** → 该项**间歇**；其余 4 条稳定复现 |
| ④ | 对照实验：4 个涉事 case **单独跑** | `decision` 9/9 ✔、`pause-release` 17/17 ✔、`pause` 19/19 ✔、`init` **13/14 ✘** | 见 §三 |

**最终判定依据 = 轮次 ③**（146/150，四轮中唯一一次证据集完整且口径一致的全量跑）。

## 二、22 项失败的第一层根因：测试侧顺序缺陷（已修）

首跑 22 项失败全部指向同一处，且**与会话 pane 里的自述互相印证**（`multi` 沙箱会话现场）：

> Agent 注册表结果：Agent type not found；可用类型仅 claude / claude-code-guide / …
> 根因：本会话 `.claude/settings.json` 声明的 marketplace 源 `sandbox/regression/.plugin-8799` 已不存在……

代码位置 `tests/regression/fullflow-regression.mjs` `main()`：

```js
if (args.port) {
  ISOLATED_PLUGIN_DIR = isolatedPluginDir(SERVER_PORT);   // ← 在 SANDBOX_ROOT 里建插件副本
}
preflight();
if (args.clean) fs.rmSync(SANDBOX_ROOT, { recursive: true, force: true });  // ← 又把副本删掉
```

隔离插件副本住在 `SANDBOX_ROOT` 里，而 `--clean` 删的是整个 `SANDBOX_ROOT` —— **先建后删，副本在整轮里根本不存在**。
后果链：沙箱项目 marketplace 指向不存在的目录 → 三插件无法解析 → **agent 定义与 hooks 未注册** →
tmux 会话 `SessionStart` 永不到达（`⚠ 等待会话就绪超时（60s 未收到 SessionStart）`）→
单 agent 走 `still busy (ready timeout)`、多 agent 走 `派发未送达（主会话未在超时内就绪）` → run 卡死。

这是**测试侧缺陷**（不是产品回归）；产品在插件正常注册时的链路是通的 —— 轮次 ② 起全绿的部分即证。
处置：**已修**（把「清/建沙箱根」提到「建副本」之前，不改任何断言口径），修复后失败数 22 → 5。

## 三、剩余失败的归因（对照实验）

| case | 全量连跑 | 单独跑 | 归因 |
|---|---|---|---|
| `decision` | 轮② 8/9 ✘ / 轮③ **9/9 ✔** | 9/9 ✔ | **间歇**。失败时 `logStampOf()` 取不到基准值（`null vs 0.2.0-…`）——即该项目的 **per-run 日志目录未生成**（`.awf/logs/` 下只有 `run-meta.json`），而同轮 `gate`/`multi`/`dual`/`resume`/`recover`/`web` 的目录都在。机制未定位，**仅连跑模式出现** |
| `pause` | 轮② 18/19 ✘ / 轮③ 18/19 ✘ | 19/19 ✔ | **断言过具体**：断言用 `find()` 取**第一条**含 `pause 闩锁已挂起` 的行并强制要求它带 `dispatch:T2`；连跑（server 复用、更慢）时先到的是 **settle 等待路径**的告警，其 label 是 `pause-latch`（默认值，见 `src/lib/pause.js:62`），只有 batch 的派发路径才写 `dispatch:<id>`（`batch-transport.cjs:145`）。产品行为正确（告警含项目根 + 阶段），是断言把「哪条等待路径先告警」写死了 |
| `pause-release` | 15/17 ✘ / 15/17 ✘ | 17/17 ✔ | **case 间不独立**：全量连跑时 server 由首个 case（`single`）派生并被**复用**，`server.log` 落在 `single/.awf/logs/`，本 case 自己项目下为空 → 两条 `server.log` 断言失败 |
| `init` | 13/14 ✘ / 13/14 ✘ | **13/14 ✘** | **确定性，且与连跑无关**：`--port` 隔离把 marketplace 重指到插件副本，而 `awf init` 会把它写回仓库 `plugin/`（init 自有立场），于是「重跑 init 后 settings 不变」必然失败。**产品侧幂等成立**（scratch 项目连跑两次 init，settings 零差异，已实测） |

**归零的结论：5 项失败中 0 项是产品路径缺陷。** 所有真链路断言（收敛 / 落账 / 隔离 / 闩锁 / 生命周期 / 前端托管）
在两轮完整跑中均通过；`--strict` 之外的失败全部落在 **case 自身的隔离性与断言口径**上。

### 顺带记录的两处产品侧观察（不构成本门禁失败，但值得单独处置）

1. **复用 server 时没有 per-project 的 `server.log`**：`T1-112` 在 **spawn 时**把 server 输出接到 `<proj>/.awf/logs/server.log`，
   而单 server 多项目下 server 只为**首个**项目写日志 —— 之后的项目（即多数真实场景）在 `.awf/logs/` 下**看不到 server 日志**。
   与「把沉默变成会响的东西」的目标不完全一致。
2. **`RunLogger._init()` 静默早退**：读不到 `state.json` 的 `version` 时**直接 return，不打任何日志**（`src/server/run-logger.cjs:29`）
   —— 于是「这一轮的 per-run 日志目录没建起来」这件事没有任何出口。`decision` 那条间歇失败正是踩在这上面才难定位。

## 四、覆盖边界声明（本门禁**不**宣称的东西）

`--case all` 全绿 = 「**13 个已注册 case 覆盖的链路**在真机通过」，**不等于**「功能全绿」。本门禁**未**覆盖：

- `awf plan` 全链路（交互式入口，用户已裁定暂不测）；
- 门禁闭环失败分支、多 agent 真并发调度（在 `tests/eval/` 的另一套 case 里，合并方案仍是讨论稿）；
- 收尾协商、上下文压缩、写类端点缺 `?p` 拒绝、异常路径（server 挂 / tmux 丢 / hook 失败）；
- `commit` 流程与 `w-doc` 生成。

矩阵已同步：`docs/discuss/real-run-coverage-gaps.md`（现状 5 case → 13 case，缺口表按本轮实测重出，
新增第 17 条「case 间独立性」缺口 —— 本轮是**第一次**把 13 个 case 放进一次连跑，
单跑绿 ≠ 连跑绿，这条纪律此前从未被真的一致性验证过）。

## 五、结论

- 产品侧：**未发现真链路回归**。13 个 case 覆盖的编排链路（单/多 agent、决策闸门、门禁落账、双 run 隔离、
  重连、pause 闩锁与放行、中断恢复、init/MCP/生命周期/前端托管）在两轮完整跑中全部按预期收敛。
- 门禁侧：**未过**。`--case all` 未做到全部已注册 case 断言通过（146/150），
  且失败是**确定性的 case 侧缺陷**（`pause` / `pause-release` / `init`）＋ **一条间歇**（`decision`）。
- 首跑 22 项失败是测试侧顺序缺陷的假象，已修并复跑验证；该修复不改任何断言口径。

→ **verdict: changes_requested**

修复要求（按优先度）：

1. **`pause-release` / `pause` 的 case 间独立性**：全量连跑时不得依赖「server 为本 case 派生」——
   或让每个 case 自起 server（用完即停），或让断言按**实际** server 日志路径取（`server.log` 的归属应可查询而非假定）。
   顺带消解 §三「观察 1」。
2. **`pause` 的告警断言收口**：不再写死「第一条告警必来自 `dispatch:T2`」，改为「存在一条本 case 的闩锁告警，
   且它带项目根与**任一**合法阶段 label」——现断言把等待路径的实现细节当成了契约。
3. **`init` 的幂等断言与隔离口径对齐**：`--port` 下 marketplace 归隔离副本是既有设计，
   断言应基于「init 的稳定输出」而非「与隔离后的重指结果逐字节相等」。
4. **`decision` 间歇失败**：按 §三 观察 2，先给 `RunLogger._init()` 的早退加可见出口（不静默），
   再据此定位「连跑模式下 per-run 日志目录未生成」的触发条件。
5. **不改**：`--case all` 的调用方式、各 case 的断言口径与产品代码本轮均未动（除测试侧顺序修复）。

---

# 定向复审（改动面口径）— 2026-09-12 · **verdict: changes_requested**

> 口径：本轮 acceptance 指定「全量 `--case all` 有一次在案即成立（2026-09-12 已达成：15 case / 204 断言全绿、exit 0，
> 证据 `sandbox/regression/evidence-all.json`）」+「按改动面跑两条定向 case」。约束：隔离端口 8799、不得放宽断言口径。
> 本轮**未改任何测试断言口径**。

## 一、执行结果

| # | 命令 | 结果 | 证据 |
|---|---|---|---|
| ① | `npm run test:real -- --case single --port 8799` | **6/6 ✔ exit 0** | `sandbox/regression/evidence-single.json`（2026-09-11T17:54:00Z） |
| ② | `npm run test:real -- --case dynamic-planning-run --port 8799` | **✘ 0/1**（case 崩于 ENOENT） | `sandbox/regression/evidence-dynamic-planning-run.json`（18:12:56Z） |
| ③ | 对照实验：`--case dynamic-planning-run --port 8799` **重跑** | **同样失败**（同一处，现场见 §三） | tmux 会话 `cc-p1db8460ea88a` 现场 |

全量在案复核：`evidence-all.json` 的 `totals` = **204 checks / 204 passed**（generatedAt 2026-09-11T17:08:27Z）✔。

**本轮改动面**（acceptance 指定）：`plugin/core/hooks/gateway.cjs`（09b9e29 失败留痕）+ `src/server/server.cjs`（09b9e29/ae2b0f3 `/hook` 缺 `?p` 的 400 留痕）+ `src/server/dynamic-planning/service.cjs`（ab4489d 批准改闭包指纹 + 锁内重放）。

## 二、`single`：6/6 ✔ —— 但改动面的**一条腿没接上**

断言全绿（run 收敛 / T1 done / 产出落盘 / mode 复位 / per-run 日志 / 会话 env 归属）。其中「会话 env 归属」验的是 `CC_PROJECT`，与 hook 投递无关。

hook 链实测（这是本轮改动面的核心之一）：

| 观测 | 结果 |
|---|---|
| 沙箱 `hook-gateway.log` | `SessionStart → 已投递（**端口 8787**，CC_PROJECT=/…/sandbox/regression/single）` |
| 沙箱**隔离** server（8799）的 `server.log` | `listening … 8799` + 两条 `can't find session`，**`[hook]` 行 0 条** |
| 运行输出 | `⚠ 等待会话就绪超时（60s 未收到 SessionStart），继续派发` |

即：**hook 事件投到了常驻 server（8787），被测的隔离 server 一条都没收到。** 这与本任务约束写明的理由（「常驻 server 跑的是它启动时的代码，测不到当前工作树」）正相反 —— 隔离模式对 **server 与项目级 MCP 生效**（`.mcp.json` 的 `AWF_BASE=http://127.0.0.1:8799` 实测在位），对**会话的 hook 链不生效**。后果：会话就绪门形同虚设，「60s 未收到 SessionStart → 硬派发」在隔离模式下**必然发生**（而非 issue 009 记的「约 1/2 偶发」）。

## 三、`dynamic-planning-run`：✘ 两次同样失败，压根没跑起来

**现场（tmux 会话启动后的完整可见输出，两次运行一字不差）**：

```
 ▐▛███▛█   Claude Code v2.1.247
▝▜██████▀  Opus 4.8 (1M context) · API Usage Billing
  ▝▝ ▝▝    ~/…/sandbox/regression/dynamic-planning-run
⏺ Unknown command: /ai-workflow-code:w-dev
⏺ Args from unknown skill: T1
  在项目根创建 src/counter.js，导出自增计数器 makeCounter()，返回 { inc(), value() }。
```

**归因链（第一手）**：

1. 沙箱会话**没有加载 provider 插件** → 派发用的 `/ai-workflow-code:w-dev` 不存在 → prompt 被丢弃（`Unknown command` + `Args from unknown skill`）；
2. 项目里连 `src/` 都没建 → 会话空闲（`❯` 空输入框）、state 里 `T1` 永远 `active`；
3. case 等待超时后遍历项目产物 → `ENOENT: … sandbox/regression/dynamic-planning-run/src` → `case 执行未抛错 ✘` → **0/1**。

**排除「产品回归」**：产品侧链路**根本没有被执行**（prompt 未进入 AI）。这也不是本轮的改动面造成的 —— 是**隔离装载环境**的问题。

**旁证（指向同一处）**：
- 该沙箱的 `hook-gateway.log` **为空**（对比 `single` 有一条）→ 该会话连 hook 都没注册；
- `~/.claude/plugins/known_marketplaces.json` 的 `ai-workflow-dev` 条目 `lastUpdated` 停在 **17:52:07**（第一次运行），第二次运行**没有刷新**；
- `~/.claude/plugins/installed_plugins.json` 里 `ai-workflow-{core,code}@ai-workflow-dev` 的 project 条目 `installPath` 指向 `~/.claude/plugins/cache/ai-workflow-dev/ai-workflow-{core,code}/2.0.0`，**这两个目录在磁盘上不存在**。

即：`isolatedPluginDir()` 每次重建临时 marketplace 副本、`stopIsolatedServer()` 用完即删，但 Claude Code 侧的 marketplace/插件注册状态不随之刷新 → 会话解析到的插件既不是副本、也落不到 cache。

## 四、验收点判定

| 验收点 | 判定 |
|---|---|
| 全量 `--case all` 有一次在案 | ✅（204/204，2026-09-12） |
| 定向 case `single` 全绿 + 证据落盘 | ✅（6/6，`evidence-single.json`） |
| 定向 case `dynamic-planning-run` 全绿 + 证据落盘 | ❌（0/1，两次同样失败） |
| 覆盖矩阵同步 | ✅ 本轮已同步（`real-run-coverage-gaps.md`：新增缺口 #20 + 定向两 case 实测段） |
| verdict 声明覆盖边界 | 见下 |

**覆盖边界声明（本轮**不能**声明改动面已覆盖）**：
- 全量历史证据（204/204）仍成立，但它证明的是「已注册 case 覆盖的链路在真机通过」，**不覆盖**本轮改动面；
- 改动面三条腿的实际覆盖：`dynamic-planning/service.cjs`（人工批准路径）——**零覆盖**（case 未跑起来）；`gateway.cjs` ——**半覆盖**（代码确实在真机执行并写出留痕、`?p` 也确实带上了，但事件落在 8787 而非被测 server）；`server.cjs` 的 400 留痕 ——**覆盖为 0**（未触发拒绝分支，且覆盖矩阵 #13 本就登记为真机无 case）。

## 五、本轮新发现

### F1（重）· 隔离模式不覆盖会话的插件 / hook 链

`--port` 隔离目前只覆盖 **server** 与**项目级 `.mcp.json`**；**会话侧**（插件命令 + hooks）来自 Claude Code 的插件解析，harness 的 `isolatedPluginDir()` 只改了 marketplace 指针与临时副本内的 `hooks.json`，管不到会话实际加载的那份。两个后果都在本轮实测到：
- （a）hook 投到常驻 8787（§二），使「隔离 = 测当前工作树」在 hook 这条腿上不成立，并让会话就绪门退化为 60s 硬派发；
- （b）**定向 case 分两次命令跑时，第二次起插件完全不加载**（§三）—— 而「分两次命令跑两条定向 case」**正是本轮 acceptance 指定的跑法**。

这条缺口同时意味着：**任何依赖会话内插件的真机 case，在 `--port` 模式下都可能失效**；而 `--port` 又是本任务约束强制要求的模式。

## 六、结论

→ **verdict: changes_requested**。失败全在**隔离装载环境**（测试侧/环境侧），产品编排链路本轮未被执行，不改产品代码亦可修。

修复要求（按优先度）：

1. **让 `--port` 隔离覆盖会话的插件与 hook 链**（本轮 blocker）。候选修法：
   （a）harness 改走**项目内注入** —— 直接把隔离端口/命令写进沙箱项目 `.claude/settings.json` 的 `hooks` 段与命令解析路径，不再依赖 marketplace 重指（`single` 里 hooks 能跑、却跑到 8787，说明「副本 hooks.json」这条路径实际没被采用）；
   （b）把 gateway 与插件命令的端口解析改为 **env 覆盖优先**（现为 argv 优先，见 `plugin/core/hooks/gateway.cjs:34`），harness 在 tmux 会话 env 注入隔离端口；
   （c）`stopIsolatedServer()` 的「用完即删」与 Claude Code 的 marketplace/插件注册表状态对齐（`known_marketplaces.json` / `installed_plugins.json` 的失效条目），使**连续两次 `--port` 运行**互不影响。
2. **修完必须重跑本轮两条定向 case**（`single` + `dynamic-planning-run`，各跑一遍、且**分两次命令**跑）并复验：隔离 server 的 `server.log` 出现 `[hook]` 行、`hook-gateway.log` 里的端口为 8799。
3. **顺带**（不阻塞）：`single` 在隔离模式下必然走 60s 降级路径 —— 修好（1）后该告警应消失；若仍出现，则 issue 009 的「偶发」需要重新归因。
