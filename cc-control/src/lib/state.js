import path from 'path';
import fs from 'fs';
import { logger } from './ui/log.js';

const STATE_FILE = '.awf/state.json';

// ── 基础读写 ──

/** 读取 .awf/state.json */
export function loadState(projectRoot) {
  const filePath = path.join(projectRoot, STATE_FILE);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/** 写入 .awf/state.json（自动补 lastUpdated） */
export function saveState(projectRoot, state) {
  const filePath = path.join(projectRoot, STATE_FILE);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  state.lastUpdated = new Date().toISOString();
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
}

// ── 任务查询 ──

/** 获取当前工作流阶段 */
export function getCurrentPhase(projectRoot) {
  const state = loadState(projectRoot);
  return state?.currentState || null;
}

/** 获取下一个待执行任务（pending 且 deps 已满足） */
export function getNextTask(state) {
  return findNextTask(state);
}

export function findNextTask(state) {
  const tasks = state?.plan?.tasks || state?.tasks || [];
  return tasks.find((t) => {
    if (t.status !== 'pending') return false;
    if (!t.deps || t.deps.length === 0) return true;
    return t.deps.every((depId) => {
      const dep = tasks.find((dt) => dt.id === depId);
      return dep && dep.status === 'done';
    });
  }) || null;
}

/** 检查是否所有任务均已完成 */
export function isMilestoneDone(state) {
  const tasks = state?.plan?.tasks || state?.tasks || [];
  return tasks.length > 0 && tasks.every((t) => t.status === 'done');
}

// ── 快照备份 ──

/**
 * 将当前 state.json 快照到 .awf/versions/<version>-<timestamp>.json
 * 仅在 run 所有 tasks 完成后调用
 */
export function backupState(projectRoot) {
  const state = loadState(projectRoot);
  if (!state) return;
  if (!state.version) return;

  const dir = path.join(projectRoot, '.awf', 'versions');
  fs.mkdirSync(dir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `${state.version}-${ts}.json`);
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}
