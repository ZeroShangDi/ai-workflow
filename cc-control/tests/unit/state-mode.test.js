import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setWorkflowMode } from '../../src/lib/state.js';

describe('setWorkflowMode', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-mode-'));
    fs.mkdirSync(path.join(root, '.awf'));
    fs.writeFileSync(path.join(root, '.awf', 'state.json'), JSON.stringify({ mode: 'plan', tasks: [{ id: 'T1', status: 'done' }] }));
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('只更新最新 state 的 mode，不覆盖其他字段', () => {
    expect(setWorkflowMode(root, 'run')).toBe(true);
    const state = JSON.parse(fs.readFileSync(path.join(root, '.awf', 'state.json'), 'utf-8'));
    expect(state.mode).toBe('run');
    expect(state.tasks).toEqual([{ id: 'T1', status: 'done' }]);
    expect(state.lastUpdated).toBeTruthy();
  });
});
