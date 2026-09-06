import { loadState } from './state.js';
import { sleep } from './session/client.js';

export const PAUSE_POLL_MS = 1000;

/** 工作流是否被外部控制器暂停。 */
export function isWorkflowPaused(projectRoot) {
  return loadState(projectRoot)?.mode === 'pause';
}

/**
 * pause 闩锁：暂停期间不返回；mode 恢复为 run（或其他非 pause 值）后自动放行。
 * 不缓存 state，确保 MCP/其他进程对 state.json 的修改能被及时观察。
 */
export async function waitWhilePaused(projectRoot, pollMs = PAUSE_POLL_MS) {
  let waited = false;
  while (isWorkflowPaused(projectRoot)) {
    waited = true;
    await sleep(pollMs);
  }
  return waited;
}
