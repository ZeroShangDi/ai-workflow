'use strict';
/**
 * mock.cjs — mock adapter 测试夹具（7 端口全量）
 *
 * 供单元/集成测试注入替代真实 cc 端口；每个方法调用都被记录进 ports 的 calls，
 * 便于断言调用形态（与 ports.cjs 契约对齐）。默认返回安全 canned 值，可按需覆盖。
 *
 * createMockAdapters() → { ports, calls, reset }
 *   ports.host.hasSession() → true；ports.hook.hook() → 1；oneshot.runOneShot → {ok:true,text:''}
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

  // 方法集必须与 ports.cjs 的 PORT_CONTRACT 逐一对齐（T1-116：契约是「端口对象上真实存在的方法」，
  // 夹具若自说自话，测试绿也证明不了契约成立）。ports-contract.test.js 有一条断言守着这点。
  const oneshot = {
    runOneShot: async (...a) => { calls.push(['oneshot.runOneShot', ...a]); return { ok: true, text: '' }; },
    spawnClaudeP: async (...a) => { calls.push(['oneshot.spawnClaudeP', ...a]); return { ok: true, stdout: '', stderr: '', code: 0 }; },
    claudePArgs: (...a) => { calls.push(['oneshot.claudePArgs', ...a]); return ['-p', String(a[0] ?? '')]; },
  };

  const tooling = {
    install: async (...a) => { calls.push(['tooling.install', ...a]); return { ok: true }; },
    uninstall: async (...a) => { calls.push(['tooling.uninstall', ...a]); return { ok: true }; },
    claudeAvailable: (...a) => { calls.push(['tooling.claudeAvailable', ...a]); return true; },
    buildMarketplaceAdd: (...a) => { calls.push(['tooling.buildMarketplaceAdd', ...a]); return 'claude plugin marketplace add'; },
    buildInstall: (...a) => { calls.push(['tooling.buildInstall', ...a]); return 'claude plugin install'; },
    buildUninstall: (...a) => { calls.push(['tooling.buildUninstall', ...a]); return 'claude plugin uninstall'; },
  };

  const interactive = {
    launchDialog: async (...a) => { calls.push(['interactive.launchDialog', ...a]); return { ok: true }; },
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
