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
