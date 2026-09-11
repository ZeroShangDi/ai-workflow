# 写类端点缺 `?p` 静默兜底 boot 项目：一条手工 curl 把在跑的 run 暂停了 4 小时

- 状态: fixed（2026-09-11，T1-110）
- 类型: awf 产品缺陷（多项目路由 / 写类端点缺省语义）
- 关联: W3-006（多 run sessionid 贯穿）、T1-110、`src/server/project-context.cjs`、`src/server/server.cjs`、`plugin/core/hooks/gateway.cjs`、`plugin/core/mcp/awf-session/server.cjs`、`plugin/core/mcp/awf-oneshot/server.cjs`

## 现象

2026-09-10，w-monitor 在处理异常时按 `w-monitor.md` 的「通用修复闭环」执行暂停编排：

```bash
curl -X POST http://localhost:8787/run/state/mode -d '{"mode":"pause"}'
```

**没带 `?p=`**。请求被接受，返回 200，cc-control 自身那条**正在跑**的 run 被置为 `mode=pause`。

后果不是报错，是**静默停摆**：`mode=pause` 是编排闩锁——宿主的派发路径（`sessionChannel.send` /
`batchTransportFor.send` / 单 agent executor）都会在 `waitWhilePaused` 上挂住，任务边界处不再派发新任务。
于是 run 停在原地 **4 小时**，直到有人发现并手工置回 `mode=run`。

排查时最费时间的不是修复，是**定位**：curl 返回 200，服务端没有任何异常输出，run 的日志里也没有错误，
只有「进度不再变化」这一条线索。

> 定位之所以这么难，还叠了一层观测缺失：server 进程的输出当时被 `spawn(..., stdio:'ignore')` 丢进黑洞，
> 宿主「卡在哪、等了多久」没有任何日志。该缺口已由 T1-112 补上（server 输出落 `.awf/logs/server.log`，
> 且 pause 闩锁的等待阶段行同时进项目运行日志与 server.log）。

## 根因

`src/server/project-context.cjs` 的 `resolveCtx`：

```js
const root = p || bodyProjectRoot || projectRoot || boot;
```

`boot` = 启动 server 的那个项目（`CC_PROJECT`）。所以**任何**不带 `?p` 的请求都会落到 boot 项目——
对单项目开发（server 与请求方同项目）「看起来完全正确」，对多项目则静默操作错对象。

写类端点在这个语义下尤其危险：读错项目只是看到错的数据，**写**错项目直接改变别人 run 的状态。

同类风险端点不止 `/run/state/mode`：`/intervene`、`/intervene/interrupt`、`/send`、`/cmd`、
`/choice`、`/ask`、`/respond`、`/context-ready`、`/hook`、`/oneshot`、`/awf/decisions/:id/override`、
`/run/state/{task/active,gate,backup,apply}`、`/run/submit` 全部同构。

### 为什么以前没暴露

- 单项目场景下 boot == 请求方项目，兜底「恰好正确」，掩盖了缺省语义的缺失。
- 设计上把「无 `?p`」当作**兼容存量调用**的手段（`ctxFor(boot)` 在 registry 构造时就预置），
  但没有任何机制区分「存量读」与「写」。
- 手工 curl 是个不在客户端代码里的调用方：CLI / hook 网关 / MCP 都各自带了 `?p`（或不带也不影响单项目），
  所以代码评审时看不到「一个不带 p 的写请求会怎样」。

## 修复

`src/server/server.cjs` 入口加收口：**非 GET/HEAD/OPTIONS 的请求必须显式带 `?p`**，否则 400，
且不解析、不写任何项目的 state。唯一豁免是 `/shutdown`（server 全局操作，不读不写项目 state）。

- 400 响应体写明：拒绝兜底到哪个 boot 项目、请显式带 `?p=<projectRoot>`、以及 hook/CLI/MCP 会自动带上。
- 读类端点**保留** boot 兜底（`GET /status` 是 CLI 的 server 发现与探活入口，改掉会破坏既有链路）。
- `project-context.cjs` 的 `resolveCtx` 注释同步标注：boot 兜底只对读类成立。

## 顺带照出的同类缺陷（一并修）

收口后跑测试，暴露出两个 MCP 的**写端点本来就没带 `?p`**（此前靠 boot 兜底「碰巧对」）：

| 模块 | 问题 | 修复 |
|---|---|---|
| `plugin/core/mcp/awf-session` | `sessionQuery()`（sid + p）只用在 `GET /status` 上；`/intervene`、`/intervene/interrupt`、`/choice`、`/ask`、`/context-ready` 五个写端点都没带 | 全部补 `+ sessionQuery()` |
| `plugin/core/mcp/awf-oneshot` | `/oneshot` 完全没带项目根 | 补 `?p=`（取 `AWF_PROJECT_ROOT \|\| CC_PROJECT`） |

这两个是真·多项目错写：多项目下 MCP 的写会落到 boot 项目的槽，而不是调用方 run 的槽。
`awf-state` 无此问题（读写都用了 `stateQuery()`）。

## 验证

- 新增 `tests/integration/write-requires-project.test.js`（9 例）：缺 `?p` 的 `/run/state/mode` → 400 且
  `state.json` **逐字节未变**；`/run/state/*` 四端点、`/intervene*`、八个会话注入端点缺 `?p` 全部 400；
  带 `?p` 正常且只写指定项目；读类端点仍可无 `?p`；`/shutdown` 豁免。
- 全量 `npm test`：**97 文件 / 821 例全绿**；`npm run lint` 通过。
- **hook 链路真机验证**（本任务硬约束）：在隔离 server（跑当前工作树）上跑 `single` / `pause` / `decision`
  三个真机 case —— 分别覆盖 SessionStart → 派发 → Stop、`/intervene`+`/intervene/interrupt`+闩锁、
  Stop 决策闸门；全绿，说明 `gateway.cjs` 的 `&p=`（bootstrap 注入 `CC_PROJECT`）链路未受影响。
- 测试侧同步改造：把 4 份重复的 `makeApi` 收敛为 `tests/helpers/http-api.js`，写请求自动补 `?p`；
  各用例显式传自己的项目根。

## 遗留 / 后续

- **读类端点仍可无 `?p`**：为了不破坏 CLI 的 server 发现（`GET /status`）与看板探活，本轮保留现状。
  若日后要显式化，建议返回里带上解析出的 `projectRoot`（`/status` 已有）并在前端标注，而不是改判定。
- **`bootstrap.sh` 未注入 `CC_PROJECT` 时**，`gateway.cjs` 的 `P_QS` 为空 → hook 会被 400 拒。
  正常 `awf run` 路径必然注入（`run.js` 的 `ensureSession` 显式传），故不影响 run；
  但**手工 `bash bootstrap.sh` 起的会话**其 hook 事件将不再落到任何项目（此前落 boot）。
  这是有意的：不猜项目。若确需支持，应在 bootstrap 侧显式要求 `CC_PROJECT`。
