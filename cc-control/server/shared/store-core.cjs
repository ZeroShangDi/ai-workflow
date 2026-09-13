'use strict';
/**
 * store-core.cjs — state 持久化核心（CJS 共享）：单写序列化 + 原子写
 *
 * 职责：把「读 state.json → 改 → 写回」这件事做对。收敛 CLI(lib/state.js)、server.cjs、
 * awf-state MCP 各自重复实现的「state.lock + read-modify-write + writeFileSync」三份同款代码，
 * 落到单一核心：
 *   - 单写序列化：跨进程互斥经锁文件（.awf/state.lock，openSync 'wx' + 超时重试）。
 *     锁路径名与现有实现一致，保证迁移期间 CLI/MCP/server 相互排斥不回归。
 *   - 原子写：同目录临时文件 + renameSync 覆盖（读方不会看到半截 JSON）；
 *     失败清理临时文件。
 *   - lastUpdated 由核心统一补写。
 *
 * 边界（本模块刻意不做的事）：
 *   - 不绑任何业务字段（task/wbs/mode…）。业务语义（create/update/status/result/commit/complete）
 *     由上层（server/MCP/CLI）在 updateStateSync 的 mutator 里组合；T1-011/012/013 接线时复用，
 *     不要再各写一份。
 *   - 不校验写入内容的 schema、不做状态机判断——那是上层与 shared/task-graph.cjs 的职责。
 *   - 不决定目录布局，路径由调用方以 statePath/lockPath 传入。
 *
 * 为什么全部是同步 API：现有调用点全是同步（writeFileSync 一把梭），Node 单线程 + 同文件锁
 * 已覆盖单写语义，异步化没有收益、反而逼调用点改形态。唯一需要「等待」的是抢锁重试，
 * 用 Atomics.wait 同步阻塞实现。
 *
 * 已知坑（见各函数注释）：
 *   - 锁是纯文件锁，无 stale 回收：持锁进程被 kill 会残留 .awf/state.lock，后续写者只能等到超时抛错。
 *   - readJsonSync 吞掉所有读取/解析错误返回 null；updateStateSync 会把「读不到」当「空 state」，
 *     文件损坏或权限异常时可能被静默覆盖成 {}。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 锁默认超时（与现有实现一致 5s）：超过即认为抢锁失败，抛出而不是无限等 */
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
/** 抢锁失败后的重试间隔 50ms：够短以尽快拿到锁，又不至于把 CPU 烧在忙等上 */
const LOCK_RETRY_MS = 50;

/**
 * 同步 sleep（锁重试用，避免依赖异步上下文）。
 * 在共享内存上做 Atomics.wait：真正挂起线程，既不像 `while(Date.now()<end){}` 那样吃满 CPU，
 * 也不会让调用链被迫变成 async。
 * @param {number} ms 阻塞的毫秒数
 */
function syncSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 锁文件互斥执行：拿到锁才执行 fn，fn 结束（正常返回或抛错）后释放锁。
 * 语义：openSync 'wx' 原子建锁（文件已存在即 EEXIST，不会误覆盖别人持有的锁），
 * 抢不到就每 LOCK_RETRY_MS 重试，超过 timeoutMs 抛 `state lock timeout`。
 * 与 CLI/MCP/server 现有 state.lock 实现同构，可安全替换它们而不破坏跨实现互斥。
 *
 * @param {string} lockPath 锁文件路径（所有写者必须用同一名字才能互斥）
 * @param {Function} fn 临界区函数；其返回值即本函数返回值
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {*} fn 的返回值
 * @throws {Error} 超时未获锁；或 fn 自身抛出的错误（原样透传）
 *
 * 坑：纯文件锁，没有 stale 回收。持锁进程若被 kill -9，锁文件永久残留，
 * 后续写者只能等到超时抛错，需人工删除该锁文件。
 */
function withFileLock(lockPath, fn, { timeoutMs = DEFAULT_LOCK_TIMEOUT_MS } = {}) {
  // 首次写入时 .awf 可能尚不存在，锁文件父目录先建好
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.closeSync(fd); // 只要文件被创建即表示抢到锁，内容无关，立刻关 fd
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err; // EEXIST=别人持锁，重试；其他错误（如无权限）直接抛
      if (Date.now() > deadline) throw new Error(`state lock timeout: ${lockPath}`);
      syncSleep(LOCK_RETRY_MS);
    }
  }
  // 临界区必须放在 try/finally：fn 抛错也要释放锁，否则这把锁会卡死后续所有写者
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(lockPath); } catch { /* 释放是尽力而为：锁文件可能已被清理，失败无需上抛 */ }
  }
}

/**
 * 原子写文件：先写同目录临时文件，再 renameSync 覆盖目标。读方要么看到旧内容、要么看到
 * 新内容，绝不会读到写了一半的 JSON（同文件系统内 rename 是原子操作）。
 * @param {string} filePath 目标文件
 * @param {string|Buffer} data 待写内容
 * @throws 写入/改名失败时抛出原错误（并尽力删除残留的临时文件）
 */
function atomicWriteFileSync(filePath, data) {
  const dir = path.dirname(filePath);
  // 目标目录可能还不存在（首次写 .awf/...），先建好，否则 writeFileSync 会 ENOENT
  fs.mkdirSync(dir, { recursive: true });
  // 临时文件名带 pid：同目录多进程/多次调用写同一目标时不会撞名
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, data);
    // 临时文件与目标同目录 → rename 不跨文件系统，才能保证原子覆盖
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* 尽力清理 */ }
    throw err; // 清理归清理，原错误必须往上传，不能吞
  }
}

/** JSON 原子写（2 空格缩进：与现有 state.json 格式一致，人可读且 git diff 友好） */
function writeJsonAtomicSync(filePath, obj) {
  atomicWriteFileSync(filePath, JSON.stringify(obj, null, 2));
}

/**
 * 读 JSON；缺失/非法/不可读 → null。
 * 注意这是「全吞」：解析失败、文件不存在、甚至无权限（EACCES）都归为 null。
 * 对调用方而言「读不到」与「不存在」等价（见 updateStateSync 把它当空 state）；
 * 代价是文件损坏/权限异常不会被察觉。
 * @returns {object|null} 解析结果，任何异常路径都为 null
 */
function readJsonSync(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 锁内读→改→原子写：整个「读 + 改 + 写」在 withFileLock 临界区内完成，杜绝并发覆盖。
 * mutator(state) 就地修改传入的 state 对象，其返回值决定是否落盘：
 *   - 显式 false → 不写盘，updateStateSync 返回 false（如任务状态未变、未找到）
 *   - 其他值（true/对象/undefined）→ 视为要写，补 lastUpdated 后原子落盘并返回该值
 * 传 newState？不：mutator 直接就地改传入对象即可。
 *
 * 读不到（缺失/非法）时以 {} 为初始 state 交给 mutator —— 这里的「读不到即空」是上面
 * readJsonSync 全吞语义的直接后果，调用方若要区分「文件损坏」需自行判断。
 *
 * @param {{ statePath: string, lockPath: string, mutator: Function, timeoutMs?: number }} spec
 * @returns {*} mutator 的返回（false = 未写盘）
 */
function updateStateSync({ statePath, lockPath, mutator, timeoutMs }) {
  return withFileLock(lockPath, () => {
    const state = readJsonSync(statePath) || {};
    const result = mutator(state);
    if (result === false) return false;
    state.lastUpdated = new Date().toISOString(); // lastUpdated 由核心统一补写，调用方无需关心
    writeJsonAtomicSync(statePath, state);
    return result;
  }, { timeoutMs });
}

// 对外只暴露「锁 + 原子读写」这些与业务无关的原语；DEFAULT_LOCK_TIMEOUT_MS/syncSleep
// 供上层复用同一套超时/等待语义（如 store.cjs 的队列）。
module.exports = {
  DEFAULT_LOCK_TIMEOUT_MS,
  syncSleep,
  withFileLock,
  atomicWriteFileSync,
  writeJsonAtomicSync,
  readJsonSync,
  updateStateSync,
};
