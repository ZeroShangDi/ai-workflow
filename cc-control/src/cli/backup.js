import path from 'path';
import fs from 'fs';
import { loadState } from './state.js';

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
