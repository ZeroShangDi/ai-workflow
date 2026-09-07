'use strict';
/**
 * mock.cjs — mock adapter 测试夹具（7 端口全量）
 *
 * 供单元/集成测试注入替代真实 cc 端口；每个方法调用都被记录进 ports 的 calls，
 * 便于断言调用形态（与 ports.cjs 契约对齐）。默认返回安全 canned 值，可按需覆盖。
 *
 * createMockAdapters() → { ports, calls, reset }
 *   ports.host.hasSession() → true；ports.hook.hook() → 1；oneshot.run → {ok:true,text:''}
 */

function createMockAdapters() {
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, ...args]); return undefined; };

  const host = {
    sessionName: 'mock-cc',
    hasSession: (...a) => { calls.push(['host.hasSession', ...a]); return true; },
    sendText: rec('host.sendText'),
    sendEnter: rec('host.sendEnter'),
    sendCtrlC: rec('host.sendCtrlC'),
    capture: (...a) => { calls.push(['host.capture', ...a]); return 'pane'; },
  };

  const hook = {
    hook: (...a) => { calls.push(['hook.hook', ...a]); return 1; },
  };

  const oneshot = {
    run: async (...a) => { calls.push(['oneshot.run', ...a]); return { ok: true, text: '' }; },
  };

  const tooling = {
    install: async (...a) => { calls.push(['tooling.install', ...a]); return { ok: true }; },
    list: async () => { calls.push(['tooling.list']); return []; },
  };

  const interactive = {
    askChoice: async (...a) => { calls.push(['interactive.askChoice', ...a]); return { index: 0 }; },
    askInput: async (...a) => { calls.push(['interactive.askInput', ...a]); return { value: '' }; },
  };

  const probe = {
    inspect: async () => { calls.push(['probe.inspect']); return { ok: true, state: 'ready' }; },
  };

  const session = {
    start: async (...a) => { calls.push(['session.start', ...a]); return { ok: true }; },
    stop: async (...a) => { calls.push(['session.stop', ...a]); return { ok: true }; },
  };

  return {
    ports: { host, hook, oneshot, tooling, interactive, probe, session },
    calls,
    reset: () => { calls.length = 0; },
  };
}

module.exports = { createMockAdapters };
