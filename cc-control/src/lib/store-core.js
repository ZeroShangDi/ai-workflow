import { createRequire } from 'node:module';

// store-core ESM 消费壳：CJS 核心经 createRequire 共享（与 run-metrics.js 同一约定）。
// cli/ESM 模块从这里取命名导出；server/MCP(CJS) 直接 require store-core.cjs，两端同一实现。
const require = createRequire(import.meta.url);
const core = require('./store-core.cjs');

export const {
  DEFAULT_LOCK_TIMEOUT_MS,
  syncSleep,
  withFileLock,
  atomicWriteFileSync,
  writeJsonAtomicSync,
  readJsonSync,
  updateStateSync,
} = core;

export default core;
