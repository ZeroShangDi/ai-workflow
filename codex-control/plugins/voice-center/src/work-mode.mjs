import fs from 'node:fs';
import path from 'node:path';

const MODES = new Set(['control', 'market', 'none']);

export class WorkModeStore {
  constructor({ dataDir, filePath = null } = {}) {
    this.filePath = path.resolve(filePath || path.join(dataDir, 'work-mode.json'));
    this.mode = this.load();
  }

  load() {
    try {
      const value = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return MODES.has(value.mode) ? value.mode : 'none';
    } catch {
      return 'control';
    }
  }

  get() {
    return this.mode;
  }

  set(value) {
    if (!MODES.has(value)) throw new Error('work mode must be control, market, or none');
    this.mode = value;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.filePath, `${JSON.stringify({ mode: value }, null, 2)}\n`, { mode: 0o600 });
    return this.mode;
  }
}

export const WORK_MODES = Object.freeze([...MODES]);
