'use strict';
/**
 * mock.cjs — mock adapter 测试夹具（7 端口全量）
 *
 * 供单元/集成测试注入替代真实 cc 端口；每个方法调用都被记录进 ports 的 calls，
 * 便于断言调用形态（与 ports.cjs 契约对齐）。默认返回安全 canned 值，可按需覆盖。
 *
 * createMockAdapters() → { ports, calls, reset }
 *   ports.host.hasSession() → true；ports.hook.hook() → 1；oneshot.runOneShot → {ok:true,text:''}
 *
 * 契约对齐：这是**测试替身**，不是第二份实现 —— 目的是让上层（cli/server）在不启动真 cc / tmux
 * 的前提下跑通接线。所以方法集必须与 ports.cjs 的 PORT_CONTRACT 一一对齐（对齐由
 * tests/unit/ports-contract.test.js 断言守着）：若 mock 比契约多/少方法，「测试绿」就证明不了契约成立。
 * 7 端口全部齐备（含 T-P1-03 收口进来的 session），生产侧 `createCcAdapters` 同样返回这 7 个。
 *
 * @returns {{ ports: object, calls: Array, reset: Function }}
 *   ports  7 端口（host/hook/oneshot/tooling/interactive/probe/session）的 mock 实现
 *   calls  调用记录数组，元素形如 `[方法名, ...实参]`，供断言「谁被以什么参数调了」
 *   reset  清空 calls（用例间复用同一夹具时调用）
 */

function createMockAdapters() {
  // 调用记录表；rec(name) 生成一个「记一笔再返回 undefined」的桩函数（用于无返回值的写操作）
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, ...args]); return undefined; };

  // host：有会话、能抓 pane；无返回值的 send* 走 rec 记录。
  // sendPrompt 是能力方法（文本+节奏+回车，T-P1-02）：替身只记一次调用，不模拟分两次发。
  const host = {
    sessionName: 'mock-cc',
    hasSession: (...a) => { calls.push(['host.hasSession', ...a]); return true; },
    sendText: rec('host.sendText'),
    sendPrompt: rec('host.sendPrompt'),
    sendEnter: rec('host.sendEnter'),
    sendCtrlC: rec('host.sendCtrlC'),
    capture: (...a) => { calls.push(['host.capture', ...a]); return 'pane'; },
  };

  // hook：返回值对齐真实适配器语义 —— hook() 回「本次翻译出并 emit 的事件条数」
  const hook = {
    hook: (...a) => { calls.push(['hook.hook', ...a]); return 1; },
  };

  // 方法集必须与 ports.cjs 的 PORT_CONTRACT 逐一对齐（T1-116：契约是「端口对象上真实存在的方法」，
  // 夹具若自说自话，测试绿也证明不了契约成立）。ports-contract.test.js 有一条断言守着这点。
  // oneshot：三个方法的返回形状对齐 cc/oneshot.cjs（runOneShot → {ok,text}；spawnClaudeP → {ok,stdout,stderr,code}）
  const oneshot = {
    runOneShot: async (...a) => { calls.push(['oneshot.runOneShot', ...a]); return { ok: true, text: '' }; },
    spawnClaudeP: async (...a) => { calls.push(['oneshot.spawnClaudeP', ...a]); return { ok: true, stdout: '', stderr: '', code: 0 }; },
    claudePArgs: (...a) => { calls.push(['oneshot.claudePArgs', ...a]); return ['-p', String(a[0] ?? '')]; },
  };

  // tooling：build* 返回「将要执行的命令行字符串」而非真跑（与真实实现一致：install/uninstall 才是执行面）
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
    // 夹具对齐 cc 形态：交互式对话要占住调用方终端，不能由服务端代触发（见 cc/interactive.cjs）
    detached: false,
  };

  // probe：返回一次侦查快照；state 'ready' 是 mock 缺省（真实值来自 server /status）
  const probe = {
    inspect: async () => { calls.push(['probe.inspect']); return { ok: true, state: 'ready' }; },
  };

  // session：T-P1-03 起已收口为 factory，方法集与 cc/session.cjs 一致
  const session = {
    sessionName: 'mock-cc',
    exists: (...a) => { calls.push(['session.exists', ...a]); return true; },
    cwd: (...a) => { calls.push(['session.cwd', ...a]); return '/mock'; },
    start: async (...a) => { calls.push(['session.start', ...a]); return { ok: true }; },
    kill: (...a) => { calls.push(['session.kill', ...a]); },
    nudge: (...a) => { calls.push(['session.nudge', ...a]); },
    attach: (...a) => { calls.push(['session.attach', ...a]); },
  };

  return {
    // reset 是闭包（清空同一个 calls 数组），不要用 calls = [] 重建 —— 那样会丢掉外部已持有的引用
    ports: { host, hook, oneshot, tooling, interactive, probe, session },
    calls,
    reset: () => { calls.length = 0; },
  };
}

module.exports = { createMockAdapters };
