import { vi } from 'vitest';

const mockExecSync = vi.hoisted(() => vi.fn());
const mockExec = vi.hoisted(() => vi.fn());
const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execSync: mockExecSync,
  exec: mockExec,
  spawn: mockSpawn,
}));

export { mockExecSync, mockExec, mockSpawn };
