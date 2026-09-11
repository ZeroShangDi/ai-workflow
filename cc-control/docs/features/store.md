# Store 持久化层 — 功能文档

> 对应 WBS：W1-010/011（store-core 持久化核心，T1-015）、W1-017（store 骨架 + 每 run 布局分流，T1-025）
> 源码：`src/lib/store-core.cjs` + `src/lib/store-core.js`（ESM 壳）+ `src/lib/store.cjs`

## 功能描述

v0.2.0 把「持久化」收敛为两层，消除 CLI / server / MCP 各自重复实现的 `state.lock + read-modify-write`：

| 层 | 文件 | 职责 |
|-----|------|------|
| **store-core** | `src/lib/store-core.cjs`（CJS 核心）+ `src/lib/store-core.js`（ESM 壳） | 跨进程单写序列化（锁文件）+ 原子写 + JSON 读 + `updateStateSync` 组合原语。全部同步 API |
| **store** | `src/lib/store.cjs` | 在 store-core 之上按**数据族**分型的读写 API + 进程内串行化队列 + 按 run-context 装配（`createRunStores`） |

**边界**：
- store / store-core **不绑业务字段**。task create/update/status/result/commit/complete 等业务语义由上层（`src/lib/state.js` / `awf-state` MCP / server）用 `updateStateSync` / `updateSync` 组合。
- **无中央 schema 模块**：state 的字段与枚举校验分散在各使用点（`awf-state` MCP 的工具 schema、`state.js` 的常量），store 层只负责读写与并发，不做结构校验。
- `store.cjs` 是**骨架**：不搬移 run-logger / decision-store 的业务逻辑，仅提供原语；各持久化族按自己的目录/命名调用它。

## 执行流程

### 写路径：锁 + 原子写

1. **跨进程互斥**（`withFileLock`，`store-core.cjs:37`）：`openSync(lockPath,'wx')` 原子建锁；`EEXIST` → 50ms 重试，超时 5s 抛 `state lock timeout`；`finally` 中 `unlinkSync` 释放。锁文件父目录缺失时自建。
2. **原子落盘**（`atomicWriteFileSync`，`store-core.cjs:60`）：同目录临时文件 `.${basename}.${pid}.tmp` 写入 → `renameSync` 覆盖；失败清理临时文件。读方永不看到半截 JSON。
3. **JSON 原子写**（`writeJsonAtomicSync`，`store-core.cjs:74`）：2 空格缩进。

### `updateStateSync`（`store-core.cjs:94`）

锁内 `read` → `mutator(state)` → 按返回值决定落盘：

- `mutator` 返回 **`false`** → 不写盘，返回 `false`
- 其他值（true / 对象 / undefined）→ 补 `lastUpdated` 后原子落盘，返回该值
- 读到的 state 缺失/非法 → 以 `{}` 起始（`readJsonSync(...) || {}`）

### `JsonFileStore.updateSync` 返回约定（`store.cjs:72`）

在 store-core 基础上，`createJsonFileStore` 的 `updateSync(mutator)` 语义为：

| mutator 返回 | 行为 |
|--------------|------|
| `false` | **不写盘**，返回 `false` |
| **普通对象**（非 `Array`） | 用该对象**整份替换**写盘（state 为 null 时以此表达「创建」） |
| **其他真值**（`true` / `undefined` 等） | **就地写已 mutate 的 state**（须非 null，否则抛 `store: 无可用写对象`） |

> 注意区分两处：store-core 的 `updateStateSync` 里 `false` 之外一律「就地写已 mutate 的 state」；而**整份替换**的语义只在 `JsonFileStore.updateSync` 提供（普通对象 = 替换 / 其他真值 = 就地改）。

### 进程内串行化（`createWriteQueue`，`store.cjs:32`）

每文件一条 FIFO 队列：异步 `write` / `update` / `append` 经 `enqueue` 依序执行；任一步失败只拒绝该次 promise，不断链、不影响后续。**同步 API 不经队列**（Node 单线程 + 跨进程锁已覆盖单写语义）。

### 每 run 布局与单 run 布局分流（`createRunStores`，`store.cjs:227`）

以 `ctx.runDir` 是否存在分流（`ctx` = `run-context.buildRunContext` 输出）：

| 数据 | 有 sid（每 run） | 无 sid（单 run 现行布局） |
|------|------------------|--------------------------|
| state | `.awf/runs/<sid>/state.json`（锁 `.awf/runs/<sid>/state.lock`） | `.awf/state.json`（锁 `.awf/state.lock`） |
| usage | `.awf/runs/<sid>/context/usage.json` | `.awf/context/usage.json` |
| meta | `.awf/runs/<sid>/meta/run-meta.json` | `.awf/logs/run-meta.json` |
| runConfig | `.awf/config.json`（项目级共享，不随 run 分片） | 同左 |
| snapshots | `.awf/versions/`（不随 run 分片） | 同左 |

`createRunStores` 另提供两个工厂：`append(filePath,{json})` 与 `json(filePath,{lockPath})`，供 logger / decision 按各自目录命名创建（路径由调用方决定）。

## 核心常量 / 配置

| 常量 | 值 | 说明 |
|------|-----|------|
| `DEFAULT_LOCK_TIMEOUT_MS` | `5000` | 锁获取默认超时（`store-core.cjs:22`） |
| `LOCK_RETRY_MS` | `50` | 锁重试间隔（`store-core.cjs:23`） |
| `syncSleep(ms)` | — | 同步 sleep（`Atomics.wait`），锁重试无需异步上下文（`store-core.cjs:26`） |

> 锁路径命名：`.awf/state.lock`（单 run）与 `.awf/runs/<sid>/state.lock`（每 run），CLI / server / MCP 共用，保证跨实现互斥。

## 函数清单

### `src/lib/store-core.cjs`

| 函数 | 说明 | 位置 |
|------|------|------|
| `withFileLock(lockPath, fn, {timeoutMs})` | 锁文件互斥执行；超时抛错；父目录自建；`finally` 释放 | L37 |
| `atomicWriteFileSync(filePath, data)` | 同目录临时文件 + rename 原子写；失败清理临时文件 | L60 |
| `writeJsonAtomicSync(filePath, obj)` | JSON 原子写（2 空格缩进） | L74 |
| `readJsonSync(filePath)` | 读 JSON；缺失/非法 → null | L79 |
| `updateStateSync({statePath, lockPath, mutator, timeoutMs})` | 锁内读→改→补 `lastUpdated`→原子写；`false` 不写盘 | L94 |

### `src/lib/store.cjs`

| 函数 | 说明 | 位置 |
|------|------|------|
| `createWriteQueue()` | 进程内 FIFO 串行队列 `{enqueue}` | L32 |
| `createJsonFileStore({filePath, lockPath?})` | 单文档 JSON store：`readSync`/`writeSync`/`updateSync`（同步）+ `read`/`write`/`update`（异步队列，支持 async mutator）。有 `lockPath` 时写/改走跨进程锁 | L50 |
| `createAppendFileStore({filePath, json?, ensureDir?})` | 追加流 store：`appendSync` / `appendRawSync`（原样追加）/ `readAllSync`（json 模式容忍坏行）+ 异步同名 API | L128 |
| `createSnapshotStore({dir})` | 版本快照 store：`snapshotSync(obj,{version,ts})` 写 `${version}-${stamp(ts)}.json`；`listSync()` 排序；非法时间戳抛错 | L187 |
| `createRunStores(ctx)` | 按 run-context 装配 state/usage/runConfig/meta/snapshots + `append`/`json` 工厂 | L227 |

## 接口 / 依赖

| 模块 | 用途 |
|------|------|
| `node:fs` / `node:path` | 读写/锁/临时文件/目录创建 |
| `./store-core.cjs` | store.cjs 的持久化原语（锁 + 原子写 + 读） |
| `createRequire`（`store-core.js`） | ESM 壳经 `createRequire` 共享 CJS 核心；cli/ESM 模块从此取命名导出 |

### 谁在用（消费方）

| 数据族 | 消费方 | 用法 |
|--------|--------|------|
| state | `src/lib/state.js` | 直接 require `store-core`（`withFileLock` / `readJsonSync` / `writeJsonAtomicSync`）|
| state（装配） | `src/server/project-context.cjs:48` | `createRunStores(storeCtx).state`；server `GET /awf/state` 用 `pcx.stores.state.readSync()` |
| state（per-sid） | `src/server/project-context.cjs:75` | `writeRunStateSid`：`storeCore.withFileLock(runStateLockFile) + writeJsonAtomicSync`（`?sid=` 显式路径） |
| run-logger | `src/server/run-logger.cjs:40` | `createAppendFileStore({filePath: main.log})`，`appendRawSync` 写 header |
| decision-store | `src/server/decision-store.cjs:91,96` | `createAppendFileStore({filePath, json:true})` 追加/读 jsonl |
| run-meta | `src/lib/run-metrics.cjs:28` | `createJsonFileStore({filePath: run-meta.json})`（原子写，无跨进程锁——单写者 server） |
| handoff 文本 | `src/server/interact.cjs:65` | `storeCore.atomicWriteFileSync(...)` |

## 验收标准

- [ ] `withFileLock` 持锁期间二次获取超时抛错；`fn` 抛错仍释放锁；锁文件父目录自建
- [ ] `atomicWriteFileSync` 失败清理临时文件，无 `.tmp` 残留
- [ ] `JsonFileStore.updateSync` 三态语义（false 不写 / 普通对象整份替换 / 其他真值就地写）正确
- [ ] `AppendFileStore` json 模式 `readAllSync` 容忍坏行；`appendRawSync` 原样追加不加换行
- [ ] `SnapshotStore` 命名 `${version}-${YYYY-MM-DDTHH-mm-ss}.json`，非法时间戳抛错，`listSync` 排序
- [ ] `createRunStores` 有 `runDir` 时 state/usage/meta 落 `.awf/runs/<sid>/`，无 sid 回落 `.awf` 根
- [ ] 进程内异步写经队列 FIFO 不交错；单步失败不断链
