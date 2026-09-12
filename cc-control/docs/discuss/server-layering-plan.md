# Server 分层规划（v0.2.0 收口 · server 侧）

> 状态：目录定稿，开始落地（2026-09-12）
> 依据：`docs/discuss/architecture-v0.2.0.md` §2.1 进程边界图 + §2.3 模块职责 + 原始 WBS W3-003
> 目标：`server.cjs`（现 1599 行，顶到结构断言上限）拆为按能力分层；原 `src/server/` **暂不动**，新结构落在 `cc-control/server/`（与 `web/` 平级）。

## 一、目录定稿

```
server/                               常驻控制平面（与 web 平级）
├── server.cjs                        装配 + 生命周期（唯一入口）
│
├── bootstrap/                        进程生命周期
│   └── index.js                      启动 / 端口 / boot 上下文 / 空闲回收 / 优雅关闭
│
├── api/                              对外 HTTP 面
│   ├── index.js                      路由注册表（server.cjs 只碰这一层）
│   ├── session.js                    /send /cmd /intervene /status
│   ├── hook.js                       /hook
│   ├── state.js                      /awf/state /run/state/*
│   ├── run.js                        /run/submit /run/status /run/events
│   ├── decisions.js                  /awf/decisions*
│   ├── replanning.js                 /awf/replanning*
│   └── web.js                        页面 / assets / metrics / diagnostics
│
├── run/                              能力：编排（一个闭环）
│   ├── index.js                      唯一出口
│   ├── host.js                       宿主（编排权）
│   ├── driver.js                     阶段链
│   ├── scheduler.js                  滑动窗口（多 agent 分配）
│   ├── transport.js                  多 agent 派发
│   ├── channel.js                    收尾协商
│   ├── gate-fix.js                   门禁闭环
│   ├── subagent.js                   子 agent 观测与落账
│   └── logger.js                     per-run 日志
│
├── session/                          地基：会话状态机
│   ├── index.js                      ready/busy/paused/deciding + 注入
│   ├── slot.js                       per-run 槽
│   └── pause.js                      pause 闩锁
│
├── context/                          横切：上下文压缩与接力
│   └── index.js                      占用实测 / 快照 / /clear 注入 / handoff
│
├── decision/                         能力：决策门阀
│   ├── index.js
│   ├── gate.js                       拦截与状态
│   ├── core.js                       结果解析与校验
│   ├── store.js                      追加式落盘
│   └── instruction.js                决策模式指令
│
├── replanning/                       能力：动态任务规划（原名 dynamic-planning）
│   ├── index.js
│   ├── config.js                     执行模式与扩展
│   ├── planner.js                    局部规划 / 影响闭包 / 副作用
│   ├── service.js                    proposal / 锁 / 重放
│   ├── store.js                      proposal 与事件
│   └── decision-port.js              到 decision 的适配边界
│
├── observability/                    横切：日志 / 指标 / 诊断 / 事件
│   ├── index.js
│   ├── metrics.js
│   ├── diagnosis.js
│   ├── events.js                     事件总线 + WS 推送
│   └── server-log.js                 server 自身日志
│
├── projects/                         地基：多项目 / 多 run 上下文
│   ├── context.js                    每 projectRoot 的上下文容器
│   └── registry.js                   注册表 + session 名派生
│
├── adapters/                         ★多 CLI 适配层（每个 CLI 一个子目录）
│   ├── ports.js                      统一端口契约：7 端口名册 + status + 加载自检（唯一门）
│   ├── cc/                           Claude Code 适配器（当前唯一真实现）
│   │   ├── index.js
│   │   ├── host.js                   会话启动 + tmux 原语
│   │   ├── hook.js                   hook → 领域事件
│   │   ├── extract.js                RESULT / NEEDS_INPUT / transcript 提取
│   │   ├── oneshot.js                claude -p
│   │   ├── probe.js                  会话侦查
│   │   ├── tooling.js                插件安装 / 市场运维
│   │   ├── interactive.js            交互对话
│   │   ├── session.js                not-landed（待落）
│   │   ├── settings.js               会话 settings 生成（CC 特有）
│   │   └── shapes.js                 非端口形状工具
│   ├── codex/                        接缝占位（未实现）
│   ├── gemini/                       接缝占位（未实现）
│   ├── pi/                           接缝占位（未实现）
│   ├── dash/                         接缝占位（未实现）
│   └── mock.js                       测试替身（不进生产门）
│
├── static.js                         静态托管原语
├── interact.js                       交互原语
├── ws.js                             WebSocket 传输
└── public/                           前端构建产物（不入库）
```

## 二、依赖方向（只许向下，对应文档 §1 R1）

```
server.cjs → api → run / decision / replanning   （能力层，各自只经 index 暴露）
                 ↓
              session / projects                  （地基）
                 ↓
              context / observability             （横切，只能被依赖）
              adapters                            （最外圈：能力经 ports 用 cc）
```

跨能力只保留一条：`replanning → decision`（经 `decision-port`，方向固定），其余能力互不 import。

## 三、与 `src/server/` 的关系

- 新结构落在 `cc-control/server/`，与 `web/` 平级。
- **原 `src/server/` 本阶段不动**（不删、不改），作为过渡对照；待新结构接线完成、真机回归通过后，再整体退役 `src/server/`。
- 代码搬迁按能力逐个进行：每个能力 = 「搬迁 + 重命名归位 + 出口收口（index）+ `check:arch` 方向校验」一次到位，**不允许「新建挂空、两边并存」**（当年 `app.cjs`/`api.cjs` 的教训，见 `.awf/issues/002`）。

## 四、落地顺序（每步可独立验证）

1. 目录骨架 + 本文件落盘（本轮）。
2. `adapters/`：先把 `ports.js` 契约 + `cc/` 各端口从 `src/adapters/` 与 `src/server/{host,hook-adapter,run-settings}.cjs` 收口进来。
3. `projects/` + `session/`（地基，先立，能力层依赖它）。
4. `run/`（编排闭环，最大的一块）。
5. `decision/` + `replanning/`。
6. `api/`（路由面，依赖上面全部）。
7. `bootstrap/` + `server.cjs` 收尾（此时 server.cjs 应 ≤150 行）。
8. 真机回归 + 退役 `src/server/`。

每步验收：`npm run lint` + `npm test` + `node scripts/check-architecture.mjs`（方向不得新增豁免）；收尾步加 `--case all`。

---

## 五、实现进度（2026-09-12）

**方式**（用户裁定）：server 是**纯程序** —— 对外反馈固定，只需认清它的**入口（HTTP 路由）与出口（tmux / 落盘 / 日志 / 决策存储）**，
不连接 cli，用 **mock** 测。因此不是"复制"或"切换"，而是**重新实现 server 本身**；
实现过程中做该做的抽象/封装/边界处理，不要求逐字兼容旧实现。

### 已完成

| 层 | 内容 |
|---|---|
| `projects/` | `context.cjs`（纯上下文：身份+路径+**出口**）、`registry.cjs`（runtime 缓存与寻址）、`runtime.cjs`（**每项目能力装配**） |
| `session/` | `index.cjs`（`Session`：会话态收敛为一个对象）、`executor.cjs`（单 agent 执行器）、`channel.cjs`（会话通道 + 注入原语） |
| `decision/` | `core` / `gate` / `instruction` / `store`（自 src 迁）+ `handler.cjs`（**决策流程编排**） |
| `observability/` | `index.cjs`（指标/诊断/通知/子 agent 观测）、`subagent.cjs`（子 agent 落账）、`run-logger.cjs` |
| `run/` | `host` / `driver` / `scheduler` / `transport` / `channel` / `gate-fix` |
| `replanning/` | 整卷迁入并改名（原 `dynamic-planning`） |
| `adapters/` | `ports.cjs`（唯一门）+ `cc/`（host/hook/settings/oneshot/tooling/interactive/probe/shapes/tmux）+ `mock.cjs` + `codex|gemini|pi|dash`（接缝） |
| `api/` | `index.cjs`（32 条路由的分发） |
| `bootstrap/` | `index.cjs`（启动/端口/空闲回收/优雅关闭） |
| 根 | `server.cjs`（装配根）、`config.cjs`（常量单源）、`static.cjs` / `interact.cjs` / `ws.cjs` |
| 测试 | `mock/`（tmux/logger/stores 替身）+ `tests/unit/server-layering.test.js`（7）+ `tests/unit/server-api-routes.test.js`（30，逐路由） |

### 核心抽象（本次的架构价值）

**拆开上帝对象**：原 `pcx` 有 34 个字段，混了「身份 / 路径 / 出口 / **运行态**」四类。现在：
- `ctx` 只装前三类 —— `state` `decisionPending` `waiters` `runHost` `taskChannel` `metricsCache` `agents` **都不在它上面**（测试直接断言）；
- 运行态各归其位：会话态 → `Session`、宿主 → `runtime.runHost`、观测 → `observability`。

这条是"哪里该抽象、哪里改封装"的落点：**先让状态有归属，模块才切得开**。

### 验证

- 逐路由对照测试 **30/30 通过**，全部失败项**均为测试自身**（未发现 server 缺陷）；
- HTTP 面真起真打：`/status`、`/hook`、`/send`、`/run/submit`、`/run/state/*`、决策与规划端等均按预期响应；
- 全量 `npm test` **960 passed**（唯一失败是 `T4-001` 处于 blocked 的**已知状态信号**，非本工作引入）；
- **零破坏**：新 `server/` 是独立目录，未改 `src/`。

### 未完成

1. 新 `server/` 与产品**未接线**（`cli` / 插件 MCP 仍指 `src/server`）—— 按用户裁定"只实现 server 部分"，接线是另一件事。

（原列的「`run/` 迁入未重写」「WS 未测」「`lib/` 未提顶层」三项已分别由：§六 的隔离修订、下述 WS 测试、以及"lib 归 cli 不做顶层"的裁定关闭。）

### 上下文压缩归位（2026-09-12 补）

原 `run/channel.cjs`（原 task-channel）**混了两件不同的事**：任务前**上下文压缩检查** + 收尾协商。
两者只是恰好共用 `send`（都要往会话注入），不该因此同处一个模块。已按能力拆开：

| 能力 | 归属 | 内容 |
|---|---|---|
| 上下文压缩与接力（横切） | **`server/context/compaction.cjs`** | 跳过前 N 任务 / 低于阈值不打扰 / `/clear` + 注入快照 / 快照不可读保守跳过 |
| 收尾协商（编排） | `server/run/channel.cjs` | 结算等待 → 追问 → 标 blocked |
| 两段的装配 | `server/session/channel.cjs` | 建 `send` 原语，合成 `{ maybeCompact, settleTask }` 供执行器用 |

`tests/unit/server-context.test.js`（6 条）覆盖压缩的三条分支与两条保守路径。

**至此 `server/` 的每个能力目录都有实现**：`run / decision / replanning / context / observability / session / projects / adapters / api / bootstrap` + 地基 `core/`。

### WS 实时推送（2026-09-12 补测）

`tests/unit/server-ws.test.js`（4 条）—— 用 Node 内置 `WebSocket` 当客户端，起真 http server + `upgrade` 处理：

| 用例 | 验到的 |
|---|---|
| 连接并收帧 | 握手成功 → 服务端 `ensureRunHost` + `subscribe` → `host.publish` → 客户端收到 `{type,payload}` 文本帧 |
| 多帧顺序 | 连续 publish 三条，到达顺序与事件环 seq 一致 |
| 非 `/run/events` 的 upgrade | 被拒（连接不打开）—— `handleUpgrade` 的路径守卫 |
| 关闭后退订 | 客户端 close → 服务端退订，再次 publish 不抛错（不写已关 socket） |


---

## 六、server 与 cli 的隔离（2026-09-12 修订）

**用户裁定**：`server` 与 `cli` 隔离、不共享代码；两边不产生代码耦合；cli 要用某能力时，server **通过接口暴露**，cli 直接调。
**核心实现在 server**。因此 `lib/` 归 **cli 之下**，**server 不依赖 lib**。

### 做了什么

原先新 `server/` 的 16 个模块、21 处引用都指向 `src/lib/*`。全部**内化**：

| 原 lib 模块 | 内化到 | 说明 |
|---|---|---|
| `store-core.cjs` / `store.cjs` | `server/core/` | 锁 + 原子写、按族分型 store |
| `state.js` | `server/core/state.js` | state 读写；删掉未使用的 `ui/log` 依赖 |
| `run-context.cjs` / `run-id.cjs` / `runtime-config.cjs` / `config-loader.cjs` | `server/core/` | 装配器与运行期常量 |
| `pause.js` | `server/core/pause.js` | **去掉对 `session/client.js` 的依赖**，自带 `sleep` |
| `plugin-bridge.js` | `server/core/prompts.js` | **去掉对 `paths.js` 的依赖**，自己从包根定位 `plugin/` |
| `task-graph.cjs` | `server/replanning/graph.cjs` | 它是**动态任务规划的内核**（图校验 + 原子变更） |
| `extract.cjs` | `server/adapters/cc/extract.cjs` | cc 的 RESULT/NEEDS_INPUT 提取 |
| `events.cjs` | `server/observability/events.cjs` | 事件类型定义 |
| `run-metrics.cjs` / `run-diagnosis.cjs` | `server/observability/{metrics,diagnosis}.cjs` | 指标与诊断 |
| `server-idle.cjs` | `server/bootstrap/idle.cjs` | 空闲回收 |
| `decision-config.cjs` | `server/decision/config.cjs` | 决策开关 |
| `gate-loop.cjs` | `server/run/gate-loop.cjs` | 门禁目标 |
| `run-config.js` | `server/run/config.js` | run 配置 |
| `ui/log.js` | 删除依赖 | 终端 UI 属 cli；server 改用 `console` |

**结果**：`grep 'src/lib' server/` → **零**（仅剩注释里的历史提及）。

### 由此确立的边界

- `server/` 是一个**自包含的纯程序**：有自己的地基（`server/core/`）、能力分层、`adapters/`；
- `lib/` 与 `cli/` 是另一侧，两边通过**接口**（HTTP）而非代码耦合；
- 这也意味着 `lib/state.js` 里那些「CLI 直连文件改 state」的路径，将来要改成经 server 接口 —— 那是 cli 侧的改造，等 server 做完自然清楚该怎么做（用户语）。

### 验证

- 两个 server 测试套件 **37/37 通过**（分层 7 + 逐路由 30）；
- 全量 `npm test` **960 passed**（唯一失败仍是 T4-001 的已知状态信号）；
- HTTP 面真起真打：`/status`、`/awf/state`、`/hook`、`/run/submit`（202）均正常。


