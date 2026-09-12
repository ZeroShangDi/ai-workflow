'use strict';
/**
 * store.cjs — store 模块骨架（承接 store-core 持久化核心）
 *
 * 职责：在 store-core（单写锁 + 原子写 + readJsonSync）之上，提供按数据族分型的
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
 * 边界：本模块只回答「怎么落盘」，不回答「落到哪个文件」——filePath/dir 一律由调用方
 * （run-context / 各业务模块）决定并传入。也不搬移 run-logger/decision-store 的业务逻辑，
 * 那些由各自归位任务决定目录命名后再在此接线。
 *
 * 现状：migrate 读入口（旧布局兼容读）尚未接入（W1-019）。
 */

const path = require('node:path');
const storeCore = require('./store-core.cjs');

// ── 进程内串行化队列 ──

/**
 * 进程内 FIFO 串行队列：enqueue(fn) 依序执行，返回 fn 结果的 promise；
 * 任一步抛错会拒绝该次 promise，但不影响后续任务执行。
 * 每个文件/store 各自持有一条队列，保证同目标写入不交错。
 *
 * 实现要点：tail 永远指向「已结算且不会 reject」的 promise，下一个任务挂在它后面；
 * 而 enqueue 返回的是未兜错的 run，调用方仍能看到本次的真实结果/错误。
 * 注意这只解决「同进程内」的交错；跨进程互斥要靠 lockPath（见 createJsonFileStore）。
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
 * 单文档 JSON store 工厂。
 * @param {{ filePath: string, lockPath?: string }} cfg
 *   lockPath 提供时（如 state）写/改走跨进程锁；否则仅进程内队列 + 原子写。
 * 返回同步（*Sync，Node 单线程即天然串行 + 跨进程锁）+ 异步队列（read/write/update）API。
 *
 * 同步与异步的取舍：单进程内用同步版即可（无需排队）；多个 async 调用点并发写同一目标时
 * 用异步版，靠 queue 保证 FIFO。
 */
function createJsonFileStore({ filePath, lockPath }) {
  const queue = createWriteQueue();

  function readSync() {
    return storeCore.readJsonSync(filePath);
  }

  function writeSync(obj) {
    const doWrite = () => {
      // 有 cross-process 锁需求时，整份写也要进锁：否则与别人锁内的 read-modify-write 互相覆盖
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
   * 返回值原样透传给调用方（便于上层判断「这次到底改没改」）。
   * 无可用写对象时抛错——宁可报错也不把 null/非对象写进文件。
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
     *
     * 重要：本方法只做「进程内」串行，不持跨进程锁。需要跨进程「读改写全程互斥」的共享写目标
     * （如 state）请用同步 updateSync（它走 lockPath）。异步版里 await 期间别的进程可能改文件，
     * 因此拿到的是「读取时刻」的快照，落盘可能覆盖他人改动。
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
 * 追加流 store 工厂（main.log 文本行 / decision .jsonl）。
 * @param {{ filePath: string, json?: boolean, ensureDir?: boolean }} cfg
 *   json=true → 每行写入前 JSON.stringify(record)（jsonl）；否则按文本行/任意字符串。
 *   ensureDir=true（缺省）→ 追加前自动建父目录。
 * 返回 appendSync/append（进程内串行）、readAllSync/readAll。
 *
 * 与 JsonFileStore 的差别：追加流不做原子写（appendFileSync 本身对单行是原子的），
 * 也不持跨进程锁——多进程同时追加同一 log 可能交错，但不会丢行。
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
    // json 模式必须序列化；非 json 模式允许直接传字符串（否则兜底序列化）
    const line = json ? JSON.stringify(record) : (typeof record === 'string' ? record : JSON.stringify(record));
    fs.appendFileSync(filePath, `${line}\n`, 'utf8');
  }

  /** 读全部：文件缺失 → []；json 模式逐行解析并跳过坏行（见下） */
  function readAllSync() {
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      return []; // 文件还没建（从未追加过）→ 空，而不是报错
    }
    const lines = raw.split('\n').filter(Boolean);
    if (!json) return lines;
    // json 模式容忍坏行（历史 jsonl 可能含半截行）：解析失败跳过
    // 取「能解析的都返回」而非整份失败：单条坏记录不该让整个日志不可读
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
 * 版本快照 store 工厂。
 * @param {{ dir: string }} cfg 快照目录（如 ctx.awfDir/versions）
 */
function createSnapshotStore({ dir }) {
  const fs = require('node:fs');

  /** ts 归一为版本快照时间戳（YYYY-MM-DDTHH-mm-ss），与 run-id / backupState 命名一致 */
  function stamp(ts) {
    const d = ts instanceof Date ? ts : new Date(ts);
    if (Number.isNaN(d.getTime())) throw new Error(`store.snapshot: 非法时间戳（${String(ts)}）`);
    // slice(0,19) 截到「秒」：秒以下精度会让同一秒内的快照文件名不同，反而不利于幂等/去重
    return d.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  }

  /**
   * 写一份快照：${version}-${ts}.json（原子写），返回文件路径。
   * @param {object} obj 快照内容
   * @param {{ version?: string, ts?: Date|string }} [opts] 缺省 version='0.0.0'、ts=now
   * @returns {string} 快照文件绝对路径
   */
  function snapshotSync(obj, { version = '0.0.0', ts = new Date() } = {}) {
    const file = path.join(dir, `${version}-${stamp(ts)}.json`);
    storeCore.writeJsonAtomicSync(file, obj);
    return file;
  }

  /** 列出已有快照文件名（仅 .json，按名排序 —— 时间戳命名使排序 ≈ 时间序）；目录不存在 → [] */
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
 *
 * lockDir 的取向很关键：perRun 时锁放在 run 自己的 state.json 旁（各 run 互不阻塞），
 * 单 run 时锁放 .awf 根（与 CLI/MCP 的 .awf/state.lock 同名，保证跨实现互斥）。
 *
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
    /** 通用 JSON store 工厂：给未在此列名的单文档用（路径/锁全由调用方决定） */
    json: (filePath, { lockPath } = {}) => createJsonFileStore({ filePath, lockPath }),
  };
}

// 对外：三个数据族原语工厂 + 队列 + 按 run-context 装配的便捷层。
// 调用方优先用 createRunStores(ctx) 拿齐常用 store；特殊路径再用单个工厂。
module.exports = {
  createWriteQueue,
  createJsonFileStore,
  createAppendFileStore,
  createSnapshotStore,
  createRunStores,
};
