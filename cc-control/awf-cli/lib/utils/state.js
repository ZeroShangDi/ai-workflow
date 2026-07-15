import path from 'path';
import fs from 'fs';
import { logger } from './logger.js';

const STATE_FILE = '.awf/state.json';

/**
 * 读取项目 state
 */
export function loadState(projectRoot) {
  const filePath = path.join(projectRoot, STATE_FILE);
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 写入项目 state
 */
export function saveState(projectRoot, state) {
  const filePath = path.join(projectRoot, STATE_FILE);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  state.lastUpdated = new Date().toISOString();
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
}

/**
 * 获取当前阶段
 */
export function getCurrentPhase(projectRoot) {
  const state = loadState(projectRoot);
  return state?.currentState || null;
}

/**
 * 获取下一个待执行任务（pending 且 deps 满足）
 */
export function getNextTask(state) {
  return findNextTask(state);
}

export function findNextTask(state) {
  const tasks = state?.plan?.tasks || [];
  return tasks.find((t) => {
    if (t.status !== 'pending') return false;
    if (!t.deps || t.deps.length === 0) return true;
    return t.deps.every((depId) => {
      const dep = tasks.find((dt) => dt.id === depId);
      return dep && dep.status === 'done';
    });
  }) || null;
}

/**
 * 检查里程碑是否全部完成
 */
export function isMilestoneDone(state) {
  const tasks = state?.plan?.tasks || [];
  return tasks.length > 0 && tasks.every((t) => t.status === 'done');
}
