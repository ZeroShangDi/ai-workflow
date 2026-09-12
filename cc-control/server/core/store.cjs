'use strict';
/**
 * store.cjs — store 模块骨架（承接 store-core 持久化核心）
 *
 * 在 store-core（单写锁 + 原子写 + readJsonSync）之上，提供按数据族分型的
 * 写/读 API 与进程内串行化队列，供后续「各持久化收口 store」任务（logger/usage/
 * decision/meta/snapshot 归位，W1-021/022/023/024）与每 run 布局（W1-018+）接线。
 *
 * 数据族 → 原语映射：
 *   - state / usage / meta（单文档 JSON）  → JsonFileStore（原子读写 + 可选跨进程锁）
 *   - logger(main.log/agents) / decision(.jsonl)（追加流） → AppendFileStore（按行/JSONL 追加）
 *   - snapshot（.awf/versions 版本快照）   → SnapshotStore（时间戳命名原子写）
 *
 * 并发：
 *   - 进程内：每文件一条串行化队列（createWriteQueue），异步写保证 FIFO、互不交错；
 *   - 跨进程：需要共享写（如 state.lock）时传 lockPath → 写/改走 store-core.withFileLock。
 *
 * 本模块是骨架：不搬移现有 run-logger/decision-store 的业务逻辑（由各自 归位 任务决定
 * 目录/命名并在此接线）；migrate 读入口接入在 W1-019（旧布局兼容读）。
 */

const path = require('node:path');
const storeCore = require('./store-core.cjs');

// ── 进程内串行化队列 ──

/**
 * 进程内 FIFO 串行队列：enqueue(fn) 依序执行，返回 fn 结果的 promise；
 * 任一步抛错会拒绝该次 promise，但不影响后续任务执行。
 * 每个文件/store 各自持有一条队列，保证同目标写入不交错。
 */
function createWriteQueue() {
  let tail = Promise.resolve();
  function enqueue(fn) {
    const run = tail.then(() => fn());
    // 吞掉前序失败，保证链不断（该次结果已由 run 反映）
    tail = run.catch(() => {});
    return run;
  }
  return { enqueue };
}

// ── JsonFileStore：单文档 JSON（原子读改写 + 可选跨进程锁）──

/**
 * @param {{ filePath: string, lockPath?: string }} cfg
 *   lockPath 提供时（如 state）写/改走跨进程锁；否则仅进程内队列 + 原子写。
 * 返回同步（*Sync，Node 单线程即天然串行 + 跨进程锁）+ 异步队列（read/write/update）API。
 */
function createJsonFileStore({ filePath, lockPath }) {
  const queue = createWriteQueue();

  function readSync() {
    return storeCore.readJsonSync(filePath);
  }

  function writeSync(obj) {
    const doWrite = () => {
      if (lockPath) return storeCore.withFileLock(lockPath, () => storeCore.writeJsonAtomicSync(filePath, obj));
      storeCore.writeJsonAtomicSync(filePath, obj);
      return undefined;
    };
    return doWrite();
  }

  /**
   * mutator(state) → 改后落盘。state=null 表示缺失/非法。返回约定：
   *   - false              → 不写盘
   *   - 普通对象            → 整份替换写盘（state 为 null 时用此表达『创建』）
   *   - 其他真值(true/…)    → 就地写已 mutate 的 state（须非 null）
   */
  function updateSync(mutator) {
    const doRun = () => {
      const cur = storeCore.readJsonSync(filePath); // null = 缺失/非法
      const r = mutator(cur);
      if (r === false) return false;
      const toWrite = r && typeof r === 'object' && !Array.isArray(r) ? r : cur;
      if (toWrite === null || typeof toWrite !== 'object') {
        throw new Error(`store: 无可用写对象（${filePath}）`);
      }
      storeCore.writeJsonAtomicSync(filePath, toWrite);
      return r;
    };
    if (lockPath) return storeCore.withFileLock(lockPath, doRun);
    return doRun();
  }

  return {
    filePath,
    readSync,
    writeSync,
    updateSync,
    async read() {
      return queue.enqueue(() => readSync());
    },
    async write(obj) {
      return queue.enqueue(() => writeSync(obj));
    },
    /**
     * 异步改：进程内队列串行；支持 async mutator（await 后落盘）。返回约定同 updateSync：
     * false=不写、普通对象=整份替换（缺失创建）、其他真值=就地写已 mutate state。
     * 需跨进程「读改写全程互斥」的共享写目标（如 state）请用同步 updateSync。
     * @param {Function} mutator async|sync
     */
    async update(mutator) {
      return queue.enqueue(async () => {
        const cur = storeCore.readJsonSync(filePath); // null = 缺失/非法
        const r = await mutator(cur);
        if (r === false) return false;
        const toWrite = r && typeof r === 'object' && !Array.isArray(r) ? r : cur;
        if (toWrite === null || typeof toWrite !== 'object') {
          throw new Error(`store: 无可用写对象（${filePath}）`);
        }
        storeCore.writeJsonAtomicSync(filePath, toWrite);
        return r;
      });
    },
  };
}

// ── AppendFileStore：追加流（main.log 文本行 / decision .jsonl）──

/**
 * @param {{ filePath: string, json?: boolean, ensureDir?: boolean }} cfg
 *   json=true → 每行写入前 JSON.stringify(record)（jsonl）；否则按文本行/任意字符串。
 * 返回 appendSync/append（进程内串行）、readAllSync/readAll。
 */
function createAppendFileStore({ filePath, json = false, ensureDir = true }) {
  const fs = require('node:fs');
  const queue = createWriteQueue();

  function doEnsure() {
    if (ensureDir) fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  function appendRawSync(rawText) {
    doEnsure();
    fs.appendFileSync(filePath, rawText, 'utf8');
  }

  function appendSync(record) {
    doEnsure();
    const line = json ? JSON.stringify(record) : (typeof record === 'string' ? record : JSON.stringify(record));
    fs.appendFileSync(filePath, `${line}\n`, 'utf8');
  }

  function readAllSync() {
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      return [];
    }
    const lines = raw.split('\n').filter(Boolean);
    if (!json) return lines;
    // json 模式容忍坏行（历史 jsonl 可能含半截行）：解析失败跳过
    const out = [];
    for (const line of lines) {
      try { out.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
    }
    return out;
  }

  return {
    filePath,
    appendSync,
    /** 原样追加（不加换行/不 JSON 化），供 main.log 分块文本/agent 转录全文写 */
    appendRawSync,
    readAllSync,
    async append(record) {
      return queue.enqueue(() => appendSync(record));
    },
    async appendRaw(rawText) {
      return queue.enqueue(() => appendRawSync(rawText));
    },
    async readAll() {
      return queue.enqueue(() => readAllSync());
    },
  };
}

// ── SnapshotStore：.awf/versions/<version>-<ts>.json 快照 ──

/**
 * @param {{ dir: string }} cfg 快照目录（如 ctx.awfDir/versions）
 */
function createSnapshotStore({ dir }) {
  const fs = require('node:fs');

  /** ts 归一为版本快照时间戳（YYYY-MM-DDTHH-mm-ss），与 run-id / backupState 命名一致 */
  function stamp(ts) {
    const d = ts instanceof Date ? ts : new Date(ts);
    if (Number.isNaN(d.getTime())) throw new Error(`store.snapshot: 非法时间戳（${String(ts)}）`);
    return d.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  }

  /**
   * 写一份快照：${version}-${ts}.json（原子写），返回文件路径。
   * @param {object} obj
   * @param {{ version?: string, ts?: Date|string }} [opts]
   */
  function snapshotSync(obj, { version = '0.0.0', ts = new Date() } = {}) {
    const file = path.join(dir, `${version}-${stamp(ts)}.json`);
    storeCore.writeJsonAtomicSync(file, obj);
    return file;
  }

  function listSync() {
    try {
      return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    } catch {
      return [];
    }
  }

  return { dir, snapshotSync, listSync };
}

// ── 按 run-context 装配的 store 层（现行单 run 布局）──

/**
 * 用 run-context 的路径装配常用 store。ctx 含 runDir（带 sid 的每 run 布局）时，
 * state/usage/meta 落到 .awf/runs/<sid>/ 下（W1-018 布局）；无 sid（单 run 现行布局）回落 .awf 根。
 * logger/decision 的目录/命名仍归各自模块决定（W1-021/022 归位时传入已定 filePath/dir 即可）。
 * @param {object} ctx - run-context buildRunContext 输出
 */
function createRunStores(ctx) {
  const perRun = Boolean(ctx.runDir);
  const statePath = perRun ? ctx.runStatePath : ctx.statePath;
  const lockDir = perRun ? path.dirname(statePath) : ctx.awfDir;
  return {
    state: createJsonFileStore({ filePath: statePath, lockPath: path.join(lockDir, 'state.lock') }),
    usage: createJsonFileStore({ filePath: perRun ? ctx.runUsagePath : ctx.contextUsagePath }),
    runConfig: createJsonFileStore({ filePath: ctx.runConfigPath }), // 项目级共享配额/开关
    meta: createJsonFileStore({ filePath: ctx.runMetaPath }),
    snapshots: createSnapshotStore({ dir: path.join(ctx.awfDir, 'versions') }),
    /** 追加流工厂：logger main/agents 或 decision jsonl 用（路径由调用方决定） */
    append: (filePath, { json = false } = {}) => createAppendFileStore({ filePath, json }),
    json: (filePath, { lockPath } = {}) => createJsonFileStore({ filePath, lockPath }),
  };
}

module.exports = {
  createWriteQueue,
  createJsonFileStore,
  createAppendFileStore,
  createSnapshotStore,
  createRunStores,
};
