'use strict';
/**
 * store-core.cjs — state 持久化核心（CJS 共享）：单写序列化 + 原子写
 *
 * 收敛 CLI(lib/state.js)、server.cjs、awf-state MCP 各自重复实现的
 * 「state.lock + read-modify-write + writeFileSync」三份同款代码，落到单一核心：
 *   - 单写序列化：跨进程互斥经锁文件（.awf/state.lock，openSync 'wx' + 超时重试）。
 *     锁路径名与现有实现一致，保证迁移期间 CLI/MCP/server 相互排斥不回归。
 *   - 原子写：同目录临时文件 + renameSync 覆盖（读方不会看到半截 JSON）；
 *     失败清理临时文件。
 *   - lastUpdated 由核心统一补写。
 *
 * 全部为同步 API（与现有调用点一致；Node 单线程 + 锁文件已覆盖单写语义）。
 * 业务操作（task create/update/status/result/commit/complete…）由上层（server/MCP/CLI）
 * 用 updateStateSync 组合，T1-011/012/013 接线时复用；本模块不绑业务字段。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 锁默认超时（与现有实现一致 5s） */
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 50;

/** 同步 sleep（锁重试用，避免依赖异步上下文） */
function syncSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 锁文件互斥执行（openSync 'wx' 原子建锁，超时抛错）。与 CLI/MCP/server 现有
 * state.lock 实现同构，可安全替换它们而不破坏跨实现互斥。
 * @param {string} lockPath
 * @param {Function} fn
 * @param {{ timeoutMs?: number }} [opts]
 */
function withFileLock(lockPath, fn, { timeoutMs = DEFAULT_LOCK_TIMEOUT_MS } = {}) {
  // 首次写入时 .awf 可能尚不存在，锁文件父目录先建好
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.closeSync(fd);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() > deadline) throw new Error(`state lock timeout: ${lockPath}`);
      syncSleep(LOCK_RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(lockPath); } catch { /* 锁文件可能已被清理 */ }
  }
}

/** 原子写文件：同目录临时文件写入后 rename 覆盖；失败清理临时文件 */
function atomicWriteFileSync(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* 尽力清理 */ }
    throw err;
  }
}

/** JSON 原子写（2 空格缩进，与现有 state.json 格式一致） */
function writeJsonAtomicSync(filePath, obj) {
  atomicWriteFileSync(filePath, JSON.stringify(obj, null, 2));
}

/** 读 JSON；缺失/非法 → null */
function readJsonSync(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 锁内读→改→原子写。mutator(state) 返回：
 *   - 显式 false → 不写盘，updateStateSync 返回 false（如任务状态未变、未找到）
 *   - 其他值（true/对象/undefined）→ 视为要写，补 lastUpdated 后原子落盘并返回该值
 * 传 newState？不：mutator 直接就地改传入对象即可。
 * @param {{ statePath: string, lockPath: string, mutator: Function, timeoutMs?: number }} spec
 */
function updateStateSync({ statePath, lockPath, mutator, timeoutMs }) {
  return withFileLock(lockPath, () => {
    const state = readJsonSync(statePath) || {};
    const result = mutator(state);
    if (result === false) return false;
    state.lastUpdated = new Date().toISOString();
    writeJsonAtomicSync(statePath, state);
    return result;
  }, { timeoutMs });
}

module.exports = {
  DEFAULT_LOCK_TIMEOUT_MS,
  syncSleep,
  withFileLock,
  atomicWriteFileSync,
  writeJsonAtomicSync,
  readJsonSync,
  updateStateSync,
};
