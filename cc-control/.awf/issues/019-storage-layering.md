---
id: "019"
title: "存储分层：运行时 state.json 瘦身 77% + 历史数据进 DB"
status: open
labels: [architecture, server, storage, discussion]
assignee: null
milestone: null
priority: high
created: 2026-09-23
updated: 2026-09-23
deps: []
related: ["001", "018"]
---

# 存储分层：运行时 state.json 瘦身 + 历史数据进 DB

**一句话**：页面数据现在全躺在 `.awf/` 的文件里（`state.json` **531 KB 且被 git 跟踪**），目标是
「运行时留 state.json、历史进 DB」。这件事包含两个可独立推进的部分：**state.json 瘦身 77%**，
以及**日志（2665 个文件）/ 决策 / 复审 proposal / 版本快照的持久化**。

**两个核心目标（用户裁定）**：

1. 数据持久化，且**不把运行时数据放进代码库**（现状是无奈之举）
2. **web/server 启动后能清晰看到之前的各种记录**

**优先级**：high。不是修 bug，是存储分层的地基；但它挡着"跨机器续跑"和"看历史"两条路。

---

## 一、先纠正两个前提（都有实测）

### 1.1 WBS 不是膨胀源 —— 它只占 3%

```
state.json 总计 531 KB（字节）
  tasks                100%
    exec.result        249 KB   47%   ← 引擎里 0 处真读（只写 + 前端展示）
    exec.architecture  142 KB   27%   ← 只有门禁回环读，且只读自己那条任务
    exec.files          16 KB    3%   ← 门禁读（找报告路径）
    prompt              34 KB    6%   ← 派发要用，**必须留**
    acceptance          20 KB    4%   ← 门禁要用，**必须留**
  wbs                   16 KB    3%   ← 直觉上的"大头"，实际只有 3%
  plan                 1.7 KB
```

`exec` 里**调度 / 门禁真正在读的**只有四个字段：`verdict`(8 处) / `recheck`(3) /
`startedAt`(8) / `completedAt`(5)，合计约 **18 KB**；`exec.result` 在引擎里**一处真读都没有**
（唯一的 grep 命中是一条注释）。写入方在 MCP 落账与 `run/subagent.cjs`（SubagentStop 落账）。

→ **先搬 `result` + `architecture` + `files`，一次砍掉 77%（531 → ~124 KB）**。
先隔离 WBS 等于白干一轮。

### 1.2 `sid` 要分成两个 —— 现在被混用了

仓库里有两个都被叫 "sid" 的东西：

| | 谁生成 | 会变吗 | 能当绑定键吗 |
|---|---|---|---|
| **awf run sid** | `generateRunId()` = `版本-时间戳-随机`（`shared/run-id.cjs`）；落 `.awf/runs/<sid>/`、会话名 `cc-<sid>` | **不变** —— `awf run -r` / `--attach` 都走 `attachActiveRun()`，**挂接同一个活跃 run** | ✅ **绑定键用这个** |
| **Claude Code `session_id`** | CC 每个 hook payload 提供 | **会变**：`/clear`（上下文压缩）、`claude --resume`、重开会话 | ❌ 不能 |

**混用的后果（现状）**：

```
server.cjs:  if (body.session_id !== pcx.mainSessionId) { resetRunLogs(); resetRunMeta(); }
```

CC 的 `session_id` 一变就把 **run 的日志与 run 元数据重置** —— 即压缩一次（`/clear`）
就把这场 run 的现场抹掉。这是 issue 001 记的那条链的另一面（那边记的是 hook 串台），
同一条混用还导致：**"续跑"的前提（活跃 run 的记录还在）本身就不牢**。

→ **绑定键：`projectRoot` + `runSid`；任务再叠 `taskId`。**
CC 的 `session_id` 降级为附属字段（记"这段产出是哪个会话写的"），参与追溯，**不参与主键**。

**已有先例可复用**：`run-meta.json`（run 元数据文件，`observability/metrics.cjs`）就是
"有哪些 run"的位置 —— 而它正是被 `resetRunMeta()` 重置过的那个。run 元数据进 DB，
就是"换机器后知道有哪些 run 可续"的第一步。

---

## 二、存储边界：按**生命周期**切，不按文件切

| 数据 | 生命周期 | 归属 |
|------|---------|------|
| 调度字段：`status` / `deps` / `plannedFiles` / `constraints` / `prompt` / `acceptance` / `wbsRef` / `source` / `verdict` / `recheck` / `startedAt` / `completedAt` | 秒级反复读写，**离线也要能用** | **state.json**（瘦身后 ≈105 KB） |
| `exec.result` / `exec.architecture` / `exec.files` | 写一次，此后只读 | **DB** |
| `wbs` / `plan` 的静态部分 | 规划期写一次，运行期只读 | DB |
| 日志（`.awf/logs/`，**2665 个文件**） | 只增不改 | **DB（最该先做）** |
| 决策事件 / 复审 proposal / `versions/` 快照 | 事件流，只增不改 | DB |

**切入时机 = 落账点**：`awf_task_complete` / SubagentStop 落账 / run 收尾的 `backupState`。
数据在那里从"运行时"变成"历史" —— 就是写入 DB 的时机。

**访问面已经收口，这是关键前提**：所有文件访问只经两层，调用点约 35 处、分布在 ~10 个文件，
且只依赖函数签名：

```
server/shared/store-core.cjs   5 个原语   withFileLock / atomicWriteFileSync /
                                          writeJsonAtomicSync / readJsonSync / updateStateSync
server/shared/store.cjs        3 个工厂   createJsonFileStore / createAppendFileStore / createSnapshotStore
```

`store-core.cjs` 只有**一份手写源**（`server/adapters/dsh/...` 下那份是 gitignore 的构建产物）。
→ **把这两层实现成 DB 版，上层不用动；前端零改动**（页面只认 HTTP JSON）。

**唯一绕过 store 的地方**：`plugin/core/mcp/awf-state/server.cjs` 是**双模**的 ——
非 SERVER_MODE 下**直接读写 `state.json`** + 自己那把 `.awf/state.lock`（文件头注释写着
`Direct file I/O`），注释里还记着由此产生的 CAS 409 冲突。换 DB 必须一并处理，
正好能顺手消掉那个 bug。

---

## 三、动作顺序（建议）

1. **日志进 DB** —— 2665 个文件 → 一张表。最干净的一块：无版本化争议、纯 append、
   日志页立刻受益（正对核心目标 ②）
2. **`exec` 只读三件进 DB** —— `result` / `architecture` / `files`，顺带把 77% 的瘦身做掉；
   门禁回环需要读 `architecture` / `files`，要么留副本、要么改成查库
3. **决策 / 复审 proposal / 版本快照进 DB** —— 都是事件流，形状一致，一把搬
4. **最后**才讨论 state.json 本体是否也进库 —— 那时它已瘦到可以忽略

**为什么要讲顺序**：第 1 步风险最低且立刻可见；第 2 步是瘦身主项；第 3 步是批量同构；
第 4 步才触碰"状态要不要随代码库走"这个产品决策。

---

## 四、DB 选型岔路（取决于"跨机器续跑"的优先级）

| 选型 | 目标②（看历史） | 跨机器续跑 | 代价 |
|------|---------------|-----------|------|
| **SQLite** | ✅ 立刻能做 | ⚠️ DB 文件要跨机器共享，有风险 | **不动** `awf plan` 的离线路径 |
| **Postgres 等 server 型** | ✅ | ✅ 天然 | **`awf plan` 不再能纯离线跑**（现在它不需要 server） |

**推荐**：先 SQLite 做 §三 的 1–3 步，**完全不动 plan 的离线路径**；
等"续跑"真立项时再评估是否换 server 型。

**一个可以把目标重新表述的结论**：核心目标 ①② + "切换电脑续跑"三条合起来，说的是同一件事 ——

> **DB 是主体（所有项目的全部历史），state.json 退化成"这台机器上这场 run 的工作台"。**

续跑 = 在新机器上**从 DB 重建工作台**（取回未完成任务 + 依赖），而不是搬运 state.json 文件本身。
这样也就绕开了"文件怎么跨机器"这个死结（git 会冲突、手工同步会覆盖）。

---

## 五、本 issue 不覆盖 / 待定

| # | 待定 | 为什么现在定不了 |
|---|------|----------------|
| 1 | `awf plan` 的离线路径**允许不允许起 server** | 直接决定 §四 的选型 |
| 2 | state.json 最终**还入不入 git** | 若只剩 ~105 KB 调度字段，是否还值得版本化 —— 产品决策 |
| 3 | 保留策略（日志 / 版本快照留多久） | 需要先有量级数据 |
| 4 | CC `session_id` 与 awf run sid 的**混用要不要一并修** | 建议一并修（见 001），否则续跑前提不牢；但它是独立的一件事 |

---

## 六、关联

- **001**：CC session_id / hook 串台 —— 与 §1.2 是同一处混用的两条后果
- **018**：页面数据源与 404 端点现状 —— §二 的"访问面收口"结论建立在它记录的实际链路上
- `.awf/logs/`（2665 文件）是 §三 第 1 步的对象，也是当前最脏的一处存储形态
