'use strict';
/**
 * ports.cjs — adapters 端口契约（定稿 7 端口 + 文档）
 *
 * cc（Claude Code）的一切接入经 adapter 端口收敛，外部源码零 claude 命令字面（纪律 R-cc）。
 * 契约：每端口 = { name, role, methods[] }；cc 实现按端口逐步落地（W1-043..052），
 * 本文件给出接口 + 方法签名；host/hook 已有最小实现（T1-040）。
 *
 * 端口名册（7）：
 *   host         tmux 会话原语（会话名参数化 cc-<sid>）：hasSession/sendText/sendEnter/sendCtrlC/capture
 *   hook         hook payload → 领域事件：hook(payload, ctx) → events
 *   oneshot      无状态 LLM 调用（claude -p）：run(prompt, opts) → { ok, text }
 *   tooling      plugin 安装/市场运维：install(opts) / list()
 *   interactive  plan 交互对话经端口：askChoice(q, options) / askInput(q)
 *   probe        w-monitor 外部会话侦查：inspect() → 会话/健康状态
 *   session      claude 会话启动/收口（host.cc）：start({projectRoot, sid}) / stop()
 *
 * mock 夹具见 mock.cjs（createMockAdapters），供单元/集成注入替代真实 cc。
 */

const { createHost } = require('../server/host.cjs');
const { createHookAdapter } = require('../server/hook-adapter.cjs');
const { launchInteractiveClaude } = require('./interactive.cjs');
const { createProbe } = require('./probe.cjs');

/** 7 端口契约（接口 + 文档，实现状态标记 impl） */
const PORT_CONTRACT = [
  { name: 'host', impl: true, role: 'tmux 会话原语（cc-<sid>）', methods: ['sessionName', 'hasSession', 'sendText', 'sendEnter', 'sendCtrlC', 'capture'] },
  { name: 'hook', impl: true, role: 'hook payload → 领域事件', methods: ['hook(payload, ctx)'] },
  { name: 'oneshot', impl: false, role: '无状态 LLM 调用（claude -p）', methods: ['run(prompt, opts)'] },
  { name: 'tooling', impl: false, role: 'plugin 安装/市场运维', methods: ['install(opts)', 'list()'] },
  { name: 'interactive', impl: true, role: 'plan 交互对话 + 人机 Q（terminal 直开 cc 交付收口）', methods: ['launchDialog(opts)', 'askChoice(question, options)', 'askInput(question)'] },
  { name: 'probe', impl: true, role: 'w-monitor 外部会话侦查', methods: ['inspect()'] },
  { name: 'session', impl: false, role: 'claude 会话启动/收口', methods: ['start(opts)', 'stop()'] },
];

const PORT_NAMES = PORT_CONTRACT.map((p) => p.name);

/**
 * 绑定已实现端口（host/hook/interactive/probe）的 cc adapter；未实现端口（oneshot/tooling/session）
 * 由对应 W1 任务落地，测试期用 mock.cjs 全量夹具。
 * @param {{ sessionName?: string, bus?: { emit: Function }, execFileSync?: Function, status?: Function }} opts
 */
function createCcAdapters({ sessionName = 'cc', bus, execFileSync, status } = {}) {
  const emit = bus?.emit || (() => 0);
  const host = createHost({ sessionName, execFileSync });
  return {
    host,
    hook: createHookAdapter({ emit }),
    interactive: { launchDialog: (opts) => launchInteractiveClaude(opts) },
    probe: createProbe({ host, status }),
  };
}

module.exports = { PORT_CONTRACT, PORT_NAMES, createCcAdapters, createHost, createHookAdapter };
