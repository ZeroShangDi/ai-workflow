import { vi } from 'vitest';

export function createMockTmux() {
  return {
    hasSession: vi.fn(() => true),
    sendText: vi.fn(),
    sendEnter: vi.fn(),
    sendCtrlC: vi.fn(),
    capture: vi.fn(() => 'mock pane content'),
  };
}
