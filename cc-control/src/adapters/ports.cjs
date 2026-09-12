'use strict';
/**
 * ports.cjs — adapters 端口契约（7 端口名册 + 非端口工具 + 未收口登记）
 *
 * **目标（纪律 R-cc）**：cc（Claude Code）的一切接入经 adapter 端口收敛，外部源码零 `claude` 命令字面。
 *
 * 现状**尚未达成**，别把上面那句读成既成事实（issue 004-4）：`session` 端口仍 `not-landed`（live 走
 * `scripts/bootstrap.sh`），命令字面仍在 adapters 之外 —— `claude` 在 `scripts/bootstrap.sh:11,42`，
 * `tmux` 在 `src/server/tmux.cjs`、`src/server/host.cjs`（审计 F5，责任 T1-113）。
 * 本文件记的是**目标形态 + 未收口的结构化登记**，不是「已经收口了」的完工声明。
 *
 * ## 契约形状
 * 每端口 = `{ name, status, role, methods[] }`：
 *   - `status: 'factory'`    由 `createCcAdapters()` 统一绑定（T1-116 起 oneshot/tooling 也纳入）
 *   - `status: 'not-landed'` 尚未收口 —— **必须**同时给出 `note` + `responsible`（责任 task id）
 *
 * 为什么把「未收口」做成结构而不是布尔标记：`impl: false` 是个沉默的洞 —— 没人知道为什么没做、
 * 谁欠着。`.awf/issues/002-integration-has-no-task.md` 记的正是这种「待接入 → 永不接入」。
 * 本文件在加载时自检：`not-landed` 缺 note/responsible 直接抛错，**不给沉默留位置**。
 *
 * ## 名册（7）
 *   host         tmux 会话原语（会话名参数化 cc-<sid>）
 *   hook         hook payload → 领域事件
 *   oneshot      无状态 LLM 调用（claude -p）
 *   tooling      plugin 安装 / 市场运维（claude plugin …）
 *   interactive  plan 交互对话（terminal 直开 cc）
 *   probe        w-monitor 外部会话侦查
 *   session      claude 会话启动 / 收口
 *
 * mock 夹具见 mock.cjs（createMockAdapters），供单元/集成注入替代真实 cc。
 */

const oneshot = require('./oneshot.cjs');
const tooling = require('./tooling.cjs');
const ccShapes = require('./cc-shapes.cjs');
const { createHost } = require('../server/host.cjs');
const { createHookAdapter } = require('../server/hook-adapter.cjs');
const { launchInteractiveClaude } = require('./interactive.cjs');
const { createProbe } = require('./probe.cjs');

/**
 * 7 端口契约。`methods` 写的是**端口对象上真实存在的方法**（不是愿望清单）——
 * T1-116 修正了此前的一批失真声明：`oneshot.run` / `tooling.list` / `interactive.askChoice`
 * / `interactive.askInput` 都不存在（choice/ask 的 live 处理在 `server/interact.cjs`，不属适配器面）。
 * 契约是给消费者照着写的（T1-117 生产改走端口），声明不存在的方法等于把人带沟里。
 */
const PORT_CONTRACT = [
  {
    name: 'host',
    status: 'factory',
    role: 'tmux 会话原语（会话名参数化 cc-<sid>）',
    methods: ['sessionName', 'hasSession()', 'sendText(text)', 'sendEnter()', 'sendCtrlC()', 'capture()'],
  },
  {
    name: 'hook',
    status: 'factory',
    role: 'hook payload → 领域事件',
    methods: ['hook(payload, ctx)'],
  },
  {
    name: 'oneshot',
    status: 'factory',
    role: '无状态 LLM 调用（claude -p）',
    methods: ['runOneShot({ prompt, cwd, timeoutMs })', 'spawnClaudeP({ prompt, … })', 'claudePArgs(prompt, opts)'],
  },
  {
    name: 'tooling',
    status: 'factory',
    role: 'plugin 安装 / 市场运维（claude plugin …）',
    methods: [
      'install(opts)', 'uninstall(opts)', 'claudeAvailable({ execSync })',
      'buildMarketplaceAdd(dir)', 'buildInstall(spec)', 'buildUninstall(spec)',
    ],
  },
  {
    name: 'interactive',
    status: 'factory',
    role: 'plan 交互对话（terminal 直开 cc）',
    methods: ['launchDialog(opts)'],
  },
  {
    name: 'probe',
    status: 'factory',
    role: 'w-monitor 外部会话侦查',
    methods: ['inspect()'],
  },
  {
    name: 'session',
    status: 'not-landed',
    role: 'claude 会话启动 / 收口',
    methods: ['start({ projectRoot, sid })', 'stop()'],
    note: 'live 走 cli/run.js → scripts/bootstrap.sh（shell 里拼 tmux + claude），适配器版从未接线',
    responsible: 'T1-113',
  },
];

/**
 * 非端口工具 —— 明确**不在** 7 端口名册内，并给出裁决理由（T1-116）。
 *
 * `cc-shapes.cjs`：cc 回写**形状**构造（Stop block / permissionDecision deny）。
 *   裁决：**不是端口**。端口 = 可替换的 cc 能力面（带会话/进程/外部依赖，换实现要动接线）；
 *   cc-shapes 是纯数据形状函数（无副作用、无可替换性诉求），且已由领域代码直接消费
 *   （server.cjs / decision-gate.cjs）。塞进名册只会让「7 端口」这个口径失真，
 *   而口径一旦失真，「哪些能力面还没收口」就再也数不清了。
 */
const NON_PORT_TOOLS = [
  { name: 'cc-shapes', file: 'src/adapters/cc-shapes.cjs', reason: 'cc 回写形状构造，纯数据函数、无可替换性诉求，不构成能力面' },
];

/**
 * 契约自检：未收口的端口必须写明原因与责任任务 —— 不允许沉默的未实现（T1-116）。
 * 模块加载即执行；单测也用负面用例直接调它。
 */
function assertPortContract(contract = PORT_CONTRACT) {
  for (const p of contract) {
    if (p.status === 'factory') continue;
    if (!p.note || !p.responsible) {
      throw new Error(`ports: 端口 ${p.name} 状态为 ${p.status}，必须带 note + responsible（不允许沉默的未收口）`);
    }
  }
  return true;
}

assertPortContract();

const PORT_NAMES = PORT_CONTRACT.map((p) => p.name);

/**
 * 端口实现句柄 —— **生产侧进入 adapters 的唯一门**（T1-117）。
 *
 * 目的：`src/cli` / `src/server` / `src/lib` 不再 `require('../adapters/xxx.cjs')` 具体实现文件，
 * 一律从这里取。这样「适配器有哪些能力面」只有一个出口，换实现、加端口都只动这里；
 * 此前逐个直连实现文件，契约层形同虚设（`ports.cjs` 零生产引用，F3）。
 *
 * `interactive` 在本仓库是「包装」而非同名模块导出（模块导出 `launchInteractiveClaude`，
 * 端口面叫 `launchDialog`）；`probe` 需 host 注入，故是工厂。
 * `ccShapes` **不在 7 端口名册**（见 NON_PORT_TOOLS），但同样经这道门出 —— 界线是「adapters 边界」，
 * 不是「只在名册里的才准出」。
 */
const PORT_IMPLS = {
  host: createHost,
  hook: createHookAdapter,
  oneshot,
  tooling,
  interactive: { launchDialog: (opts) => launchInteractiveClaude(opts) },
  probe: createProbe,
  ccShapes,
};

/**
 * 绑定 cc adapter 端口。**七个端口里，能绑的都在这里绑**（T1-116 起含 oneshot/tooling）——
 * 此前只有 4 个在工厂内，生产改为逐个直接 require 实现文件，契约层因此形同虚设
 * （`.awf/reports/architecture-discipline-audit.md` F3 / `ports.cjs` 零生产引用）。
 * `session` 未收口，故不在返回对象里；调用方经 `PORT_CONTRACT` 可查它的状态与责任人。
 *
 * @param {{ sessionName?: string, bus?: { emit: Function }, execFileSync?: Function, status?: Function }} opts
 */
function createCcAdapters({ sessionName = 'cc', bus, execFileSync, status } = {}) {
  const emit = bus?.emit || (() => 0);
  const host = createHost({ sessionName, execFileSync });
  return {
    host,
    hook: createHookAdapter({ emit }),
    oneshot: PORT_IMPLS.oneshot,
    tooling: PORT_IMPLS.tooling,
    interactive: PORT_IMPLS.interactive,
    probe: createProbe({ host, status }),
  };
}

/**
 * 单端口句柄（生产侧经这里取用，不再直连具体 adapter 文件 —— T1-117）。
 *
 * **必须下沉成顶层 const 再以简写导出**：ESM 侧（cli/*.js）要用具名导入，
 * 而 cjs-module-lexer 只认简写与「标识符: 标识符」，认不出 `{ tooling: PORT_IMPLS.tooling }`
 * 这类成员表达式，也认不出 `...spread`。写错形态的后果不是警告、是运行时报错
 * （2026-09-11 真机冒烟 `awf init` 直接挂掉才发现）。
 */
const probe = createProbe;                                  // 需 host 注入的工厂
const interactive = PORT_IMPLS.interactive;                 // 包装出的端口面（launchDialog）

module.exports = {
  // 契约元数据 + 工厂
  PORT_CONTRACT, PORT_NAMES, NON_PORT_TOOLS, PORT_IMPLS, assertPortContract,
  createCcAdapters, createHost, createHookAdapter,
  // 单端口句柄
  host: createHost,
  hook: createHookAdapter,
  oneshot,
  tooling,
  interactive,
  probe,
  ccShapes,
};
