'use strict';
/**
 * ports.cjs — adapters 端口契约（7 端口名册 + 非端口工具 + 平台解析）
 *
 * **目标（纪律 R-cc）**：cc（Claude Code）的一切接入经 adapter 端口收敛，外部源码零 `claude` / `tmux` 命令字面。
 *
 * **7 端口已全部收口**（T-P1-03 起 `session` 由 `not-landed` 转正）：`tmux` 字面只在
 * `server/adapters/cc/{host,session}.cjs`（session 经 `scripts/bootstrap.sh` 起会话）；
 * `claude` 字面在 `cc/{tooling,oneshot,interactive}.cjs` 与 `scripts/bootstrap.sh` 自身
 * （脚本是被 adapter 调用的资产，不是上层源码）。
 *
 * ## 这个目录为什么长这样（六边形架构 / Ports & Adapters）
 * `server/adapters/` 是**多 CLI 适配层**：每个 CLI 一个子目录（`cc/` 是当前唯一真实实现；
 * `codex/` `gemini/` `pi/` `dash/` 为占位空目录）。上层（cli / server / 领域逻辑）只依赖
 * 「端口」这一层抽象，不依赖任何具体 CLI；换 CLI 或新增 CLI = 新写一个子目录 + 回这里接线，
 * 上层零改动。`cc/` 目录内部按能力面切文件（见下方名册），一个文件一个端口。
 *
 * **本文件是外部进入 `adapters/` 的唯一门**：外部源码只许 `require('.../adapters/ports.cjs')`
 * 取句柄，不许直连 `cc/xxx.cjs`。破坏这条，端口就退化成硬编码，换 CLI 要满仓库改（这条纪律叫 R-cc）。
 * 注意边界是**整个 adapters 目录**而非「只在 7 端口名册里的才准出」——`shapes` / `extract` 不在名册但同样经这门出。
 *
 * ## 按项目解析平台（T-P1-01 / C01）
 * `resolveProjectAdapters(projectRoot, opts)` 是「这个项目用哪个 CLI」的唯一判定点：读
 * `<projectRoot>/.awf/config.json` 的 `runtime.adapter`（env `CC_ADAPTER` 可覆盖），缺省 `cc`。
 * 未落地的平台（当前 `dsh`）**显式抛错**，不静默回落到 cc（U6「明确失败」）；运行中不热切换。
 *
 * ## 契约形状
 * 每端口 = `{ name, status, role, methods[] }`：
 *   - `name`                 端口名 = `PORT_NAMES` / `createCcAdapters()` 返回对象上的键
 *   - `role`                 一句话职责（给人看的，不参与运行时判断）
 *   - `methods`              端口对象上**真实存在**的方法清单（含参数签名的文字形式）——消费者照此编码
 *   - `status: 'factory'`    已收口，由 `createCcAdapters()` 统一绑定（T1-116 起 oneshot/tooling 也纳入）
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

// 各端口具体实现（cc 子目录）。这里只「取来实现」，组装/绑定统一走下方 createCcAdapters / PORT_IMPLS，
// 外部源码不要照抄这些路径去直连 —— 那是绕过唯一门。
const oneshot = require('./cc/oneshot.cjs');
const tooling = require('./cc/tooling.cjs');
const shapes = require('./cc/shapes.cjs');
const extract = require('./cc/extract.cjs');
const settings = require('./cc/settings.cjs');
const profile = require('./cc/profile.cjs');
const { createHost } = require('./cc/host.cjs');
const { createHookAdapter } = require('./cc/hook.cjs');
const { launchInteractiveClaude } = require('./cc/interactive.cjs');
const { createProbe } = require('./cc/probe.cjs');
const { createSessionPort } = require('./cc/session.cjs');
const { checkPrerequisites: ccCheckPrerequisites } = require('./cc/checks.cjs');
const { readJsonFile } = require('../shared/config-loader.cjs'); // .awf/config.json 的读取形状（路径 + 容错语义）
const { configFilePath } = require('../shared/project-paths.cjs'); // .awf 布局单源
const { createDshAdapters, checkPrerequisites: dshCheckPrerequisites } = require('./dsh/index.cjs'); // DSH 平台工厂（AWF 侧；状态见 ADAPTER_PLATFORMS）

/**
 * 7 端口契约。`methods` 写的是**端口对象上真实存在的方法**（不是愿望清单）——
 * T1-116 修正了此前的一批失真声明：`oneshot.run` / `tooling.list` / `interactive.askChoice`
 * / `interactive.askInput` 都不存在（choice/ask 的 live 处理在 `server/interact.cjs`，不属适配器面）。
 * 契约是给消费者照着写的（T1-117 生产改走端口），声明不存在的方法等于把人带沟里。
 */
const PORT_CONTRACT = [
  {
    // 实现：cc/host.cjs —— createHost（工厂；会话名参数化，支持 cc-<sid>）
    name: 'host',
    status: 'factory',
    role: 'tmux 会话原语 + 派发节奏（会话名参数化 cc-<sid>）',
    methods: ['sessionName', 'hasSession()', 'sendText(text)', 'sendPrompt(text)', 'sendEnter()', 'sendCtrlC()', 'capture()'],
  },
  {
    // 实现：cc/hook.cjs —— createHookAdapter（工厂；需注入 emit 事件总线）
    name: 'hook',
    status: 'factory',
    role: 'hook payload → 领域事件',
    methods: ['hook(payload, ctx)'],
  },
  {
    // 实现：cc/oneshot.cjs —— 模块直出对象（非工厂，无需注入）
    name: 'oneshot',
    status: 'factory',
    role: '无状态 LLM 调用（claude -p）',
    methods: ['runOneShot({ prompt, cwd, timeoutMs })', 'spawnClaudeP({ prompt, … })', 'claudePArgs(prompt, opts)'],
  },
  {
    // 实现：cc/tooling.cjs —— 模块直出对象（非工厂，无需注入）
    name: 'tooling',
    status: 'factory',
    role: 'plugin 安装 / 市场运维（claude plugin …）',
    methods: [
      'install(opts)', 'uninstall(opts)', 'claudeAvailable({ execSync })',
      'buildMarketplaceAdd(dir)', 'buildInstall(spec)', 'buildUninstall(spec)',
    ],
  },
  {
    // 实现：cc/interactive.cjs —— 模块导出名是 launchInteractiveClaude，
    // 端口面改叫 launchDialog（见 PORT_IMPLS 里的包装）
    name: 'interactive',
    status: 'factory',
    role: 'plan 交互对话（terminal 直开 cc）',
    methods: ['launchDialog(opts)'],
  },
  {
    // 实现：cc/probe.cjs —— createProbe（工厂；需注入 host + status）
    name: 'probe',
    status: 'factory',
    role: 'w-monitor 外部会话侦查',
    methods: ['inspect()'],
  },
  {
    // 实现：cc/session.cjs —— createSessionPort（T-P1-03 收口：原先 live 走 cli/lib/session.cjs 的 tmux 直连）
    name: 'session',
    status: 'factory',
    role: '会话启动 / 复用探测 / 停止 / 接入观看',
    methods: ['sessionName', 'exists()', 'cwd()', 'start({ projectRoot, env })', 'kill()', 'nudge()', 'attach({ stdio })'],
  },
];

/**
 * 非端口工具 —— 明确**不在** 7 端口名册内，并给出裁决理由（T1-116）。
 *
 * `shapes.cjs`：回写**形状**构造（Stop block / permissionDecision deny）。
 *   裁决：**不是端口**。端口 = 可替换的平台能力面（带会话/进程/外部依赖，换实现要动接线）；
 *   shapes 是纯数据形状函数（无副作用、无可替换性诉求），且已由领域代码直接消费
 *   （server.cjs / decision-gate.cjs）。塞进名册只会让「7 端口」这个口径失真，
 *   而口径一旦失真，「哪些能力面还没收口」就再也数不清了。
 */
const NON_PORT_TOOLS = [
  { name: 'shapes', file: 'adapters/cc/shapes.cjs', reason: '回写形状构造，纯数据函数、无可替换性诉求，不构成能力面' },
  { name: 'extract', file: 'adapters/cc/extract.cjs', reason: '输出解析（subagent RESULT / transcript 渲染），与 shapes 一读一写对称：纯函数、无可替换性诉求' },
  { name: 'settings', file: 'adapters/cc/settings.cjs', reason: '平台格式 settings 产物构造（statusLine 等），纯数据构造、无会话/进程依赖' },
  { name: 'profile', file: 'adapters/cc/profile.cjs', reason: '项目配置注入（.claude/settings.json + 项目 .mcp.json），形状全由平台决定、不调外部命令' },
];

/**
 * 契约自检：未收口的端口必须写明原因与责任任务 —— 不允许沉默的未实现（T1-116）。
 * 模块加载即执行（见下方 `assertPortContract()` 调用）；单测也用负面用例直接调它
 * （tests/unit/ports-contract.test.js：传入缺 note/responsible 的契约应抛错）。
 *
 * @param {Array<object>} contract 待校验的契约（默认即 PORT_CONTRACT；单测传自造契约）
 * @returns {true} 全部合规（factory 直接放行；not-landed 必须有 note + responsible）
 * @throws {Error} 存在 not-landed 端口缺 note 或 responsible 时
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

// 端口名数组（名册口径的运行时形态；单测/冒烟用它断言端口齐备）
const PORT_NAMES = PORT_CONTRACT.map((p) => p.name);

/**
 * 各平台**必须**提供的最小方法面（T-P1-05 契约自检的可执行断言项；T-P2-4 收窄）。
 *
 * 与 `PORT_CONTRACT.methods` 的差别：那份是「端口上真实存在什么」（能力面全量），
 * 这份是「**任何**平台都必须有、上层真的会调什么」（消费面）。
 *
 * **T-P2-4 收窄**：原先把 cc 的机制方法（`spawnClaudeP` / `claudePArgs` / `claudeAvailable` /
 * `buildMarketplaceAdd|Install|Uninstall` / `nudge`）也列进来了 —— 那些名字直指 cc 的机制
 * （spawn `claude -p`、`claude plugin …` 命令行、tmux 回车）。新平台没有对应机制并不是缺陷，
 * 把它们当必填等于「用 cc 的实现形状去要求别的平台」。收窄后：**平台无关的能力**必填，
 * 机制方法由各平台自行决定（DSH 侧对 cc 机制方法给**显式 unsupported**，不静默返回假值）。
 */
const REQUIRED_PORT_METHODS = {
  host: ['hasSession', 'sendText', 'sendPrompt', 'sendCtrlC', 'capture'],
  hook: ['hook'],
  oneshot: ['runOneShot'],
  tooling: ['install', 'uninstall'],
  interactive: ['launchDialog'],
  probe: ['inspect'],
  session: ['exists', 'cwd', 'start', 'kill', 'attach'],
};

/**
 * 必填方法自检：每个必填方法都必须在对应端口的契约里声明过（T-P1-05）。
 * @param {object} required 必填映射（缺省 REQUIRED_PORT_METHODS）
 * @param {Array} contract 端口契约（缺省 PORT_CONTRACT）
 * @returns {true}
 * @throws {Error} 必填方法未在契约里声明 / 引用了不存在的端口
 */
function assertRequiredMethods(required = REQUIRED_PORT_METHODS, contract = PORT_CONTRACT) {
  const byName = new Map(contract.map((p) => [p.name, p]));
  for (const [portName, methods] of Object.entries(required)) {
    const port = byName.get(portName);
    if (!port) throw new Error(`ports: 必填方法引用了不存在的端口 ${portName}`);
    const declared = new Set(port.methods.map((m) => m.replace(/\(.*$/, '').trim()));
    for (const m of methods) {
      if (!declared.has(m)) throw new Error(`ports: 必填方法 ${portName}.${m} 未在 PORT_CONTRACT.methods 里声明`);
    }
  }
  return true;
}

assertRequiredMethods();

/**
 * 端口实现句柄 —— **生产侧进入 adapters 的唯一门**（T1-117）。
 *
 * 目的：`cli/` / `server/` 各层不再 `require('./xxx.cjs')` 具体实现文件，
 * 一律从这里取。这样「适配器有哪些能力面」只有一个出口，换实现、加端口都只动这里；
 * 此前逐个直连实现文件，契约层形同虚设（`ports.cjs` 零生产引用，F3）。
 *
 * `interactive` 在本仓库是「包装」而非同名模块导出（模块导出 `launchInteractiveClaude`，
 * 端口面叫 `launchDialog`）；`probe` 需 host 注入，故是工厂。
 * `shapes` / `extract` **不在 7 端口名册**（见 NON_PORT_TOOLS），但同样经这道门出 ——
 * 界线是「adapters 边界」，不是「只在名册里的才准出」。
 */
const PORT_IMPLS = {
  host: createHost,
  hook: createHookAdapter,
  oneshot,
  tooling,
  interactive: { launchDialog: (opts) => launchInteractiveClaude(opts) },
  probe: createProbe,
  shapes,
  extract,
  settings,
  profile,
};

/**
 * 绑定 cc adapter 端口。**七个端口全部在这里绑**（T1-116 起含 oneshot/tooling；
 * T-P1-03 起 `session` 也收口进来）—— 此前只有 4 个在工厂内、生产逐个直接 require 实现文件，
 * 契约层因此形同虚设（`.awf/reports/architecture-discipline-audit.md` F3 / `ports.cjs` 零生产引用）。
 *
 * @param {{ sessionName?: string, bus?: { emit: Function }, execFileSync?: Function, status?: Function,
 *           bootstrapScriptPath?: string }} opts
 *   sessionName          会话名（多 run 传 cc-<sid>，缺省 'cc'）；host 与 session 端口共用
 *   bus                  事件总线，取 bus.emit 注入 hook 适配器（缺省空 emit，事件丢弃但不报错）
 *   execFileSync         注入给 host / session 的 exec（测试用；生产走系统 tmux）
 *   status               注入给 probe 的状态查询函数（生产经 server /status）
 *   bootstrapScriptPath  起会话的脚本路径（session.start 必需；装配期由 run-context 注入）
 * @returns host/hook/oneshot/tooling/interactive/probe/session 七个端口句柄
 */
function createCcAdapters({ sessionName = 'cc', bus, execFileSync, status, bootstrapScriptPath } = {}) {
  // 无总线时给空 emit：hook 事件被丢弃但调用方不会因缺依赖报错（测试/早启场景友好）
  const emit = bus?.emit || (() => 0);
  const host = createHost({ sessionName, execFileSync });
  return {
    host,
    // hook 适配器需要 emit；oneshot/tooling 已是可用对象，原样透出
    hook: createHookAdapter({ emit }),
    oneshot: PORT_IMPLS.oneshot,
    tooling: PORT_IMPLS.tooling,
    interactive: PORT_IMPLS.interactive,
    // probe 依赖 host（侦查本会话）与 status（查 server /status），故最后组装
    probe: createProbe({ host, status }),
    // 会话生命周期（T-P1-03）：与 host 共用会话名与 exec 注入
    session: createSessionPort({ sessionName, bootstrapScriptPath, execFileSync }),
  };
}

/**
 * 平台注册表（T-P1-01 / C01）—— 「有哪些平台、各自落没落地」的唯一登记。
 *
 * 结构 `{ <平台名>: { status, role, tools, create, note?, responsible? } }`：
 *   - `status: 'factory'`    有生产实现，`create(opts)` 返回该平台的 7 个已绑定端口句柄
 *   - `status: 'not-landed'` 尚未落地 —— **必须**带 `note` + `responsible`（同端口契约的纪律）
 *
 * 刻意**不用 `name:` 字段**（平台名是对象键）：`scripts/check-capability.mjs` 用
 * `name: '...'` 正则从本文件抓端口名册，多一批非端口名字会让那份对账失真。
 */
const ADAPTER_DEFAULT = 'cc';
const ADAPTER_ENV = 'CC_ADAPTER';

/** cc 平台的非端口工具（形状/资产构造），随平台解析一并给出 */
const CC_TOOLS = { shapes, extract, settings, profile };

/**
 * DSH 平台没有 cc 那套项目资产工具（`.claude/settings.json`、`.mcp.json` 形状）。
 * 给**显式抛错**而不是 `undefined`：前者一眼看出「这层没有」，后者是 `undefined is not a function`。
 * DSH 的接入装配走 profile patch 层，归 CLI（T-P2-02）。
 */
function dshUnsupportedAsset(name) {
  return () => {
    throw new Error(`adapters.dsh.tools.${name}: DSH 没有 cc 形状的项目资产工具（接入装配走 profile patch，归 CLI / T-P2-02）`);
  };
}
const DSH_TOOLS = {
  // DSH 的「装配」= 装进用户级 profile（全局一次，多项目共享；U5/U12）。
  // 注意参数形状与 cc 的 `profile.installProfile(projectRoot)` **不同**：DSH 是
  // `installProfile({ dshHome, profile, webPort })` —— CLI 按平台分支调用（见 cli/commands/plugin.cjs）。
  profile: require('./dsh/install.cjs'),
  // cc 形状的项目资产在这里**显式抛错**：DSH 没有 `.claude/settings.json` / `.mcp.json` 这套
  settings: { generateRunSettings: dshUnsupportedAsset('settings.generateRunSettings') },
  shapes: null,   // 形状构造属 cc 机制（Stop block / permissionDecision）
  extract: null,
};

const ADAPTER_PLATFORMS = {
  cc: {
    status: 'factory',
    role: 'Claude Code（tmux 会话 + hooks 回调）',
    tools: CC_TOOLS,
    impls: PORT_IMPLS,
    checks: ccCheckPrerequisites,
    create: (opts) => createCcAdapters(opts),
  },
  dsh: {
    status: 'factory',
    role: 'DeepSeek Harness（插件 host 半侧 + 会话控制器）',
    // DSH 的「非端口工具」与 cc 不同：cc 的 settings/profile 是 .claude 形状，DSH 侧不存在对等物
    // （接入装配走 profile patch，归 CLI）。这里给**显式抛错**的实现，避免上层误当成 cc 资产用。
    tools: DSH_TOOLS,
    // DSH 的 probe 端口自带 bridge（不需要调用方注入 host/status），故 impls 为空：
    // 运行时（server/runtime/index.cjs）在缺 impls.probe 时回落到 ports.probe。
    impls: {},
    checks: dshCheckPrerequisites,
    create: createDshAdapters,
    note: 'AWF 侧适配器（7 端口）+ 指令通道 + DSH 插件 host 半侧（dsh-plugin/）：'
      + '会话创建/提交回执/回合结束/任务落账/快照/停止/规划入口/一次性调用均已在隔离探针真实跑通（P2-5a~P2-5f）',
    responsible: null,
  },
};

const ADAPTER_NAMES = Object.keys(ADAPTER_PLATFORMS);

/**
 * 平台注册表自检：未落地的平台必须写明原因与责任任务（与 assertPortContract 同一纪律）。
 * @param {object} platforms 待校验注册表（缺省真实注册表；单测传自造表）
 * @returns {true} 合规
 * @throws {Error} not-landed 平台缺 note 或 responsible
 */
function assertAdapterRegistry(platforms = ADAPTER_PLATFORMS) {
  for (const [name, p] of Object.entries(platforms)) {
    if (p.status === 'factory') {
      if (typeof p.create !== 'function') throw new Error(`adapters: 平台 ${name} 标为 factory 但没有 create()`);
      continue;
    }
    if (!p.note || !p.responsible) {
      throw new Error(`adapters: 平台 ${name} 状态为 ${p.status}，必须带 note + responsible（不允许沉默的未收口）`);
    }
  }
  return true;
}

assertAdapterRegistry();

/**
 * 解析本项目使用的平台名（不装配实现，纯判定）。优先级：env `CC_ADAPTER` > `.awf/config.json`
 * 的 `runtime.adapter` > 缺省 `cc`。未知平台名**立即抛错**（不静默回落）。
 *
 * @param {string} projectRoot 项目根（.awf 宿主）
 * @param {{ env?: object }} [opts] env 缺省 process.env
 * @returns {string} 平台名（当前 `cc` 或 `dsh`）
 * @throws {Error} 平台名不在注册表里
 */
function resolveAdapterName(projectRoot, { env = process.env } = {}) {
  const raw = env[ADAPTER_ENV]
    ?? readJsonFile(configFilePath(projectRoot), { optional: true })?.runtime?.adapter
    ?? ADAPTER_DEFAULT;
  const name = String(raw).trim();
  if (!Object.prototype.hasOwnProperty.call(ADAPTER_PLATFORMS, name)) {
    throw new Error(
      `adapters: 未知平台 "${name}"（可选：${ADAPTER_NAMES.join(' | ')}）——`
      + ` 检查 .awf/config.json 的 runtime.adapter 或环境变量 ${ADAPTER_ENV}`,
    );
  }
  return name;
}

/**
 * 按项目解析并绑定平台适配器 —— 「这个项目用哪个 CLI」的唯一入口（T-P1-01 / C01）。
 *
 * @param {string} projectRoot 项目根（.awf 宿主）
 * @param {object} [opts] 透传给平台 `create(opts)` 的装配选项（sessionName / bus / execFileSync / status …）
 * @returns {{ name: string, ports: object, tools: object, impls: object, checks: Function|null }}
 *   name   平台名；ports 7 个已绑定端口句柄；tools 该平台的非端口工具；
 *   impls  平台原始实现（需自注入依赖的调用方经此取）；checks 前置依赖检查（C02，缺省 null）
 * @throws {Error} 平台未落地（带责任 task id）或装配失败
 */
function resolveProjectAdapters(projectRoot, opts = {}) {
  const name = resolveAdapterName(projectRoot, opts);
  const platform = ADAPTER_PLATFORMS[name];
  if (platform.status !== 'factory') {
    throw new Error(`adapters: 平台 "${name}" 尚未落地（责任 ${platform.responsible}）：${platform.note}`);
  }
  return { name, ports: platform.create(opts), tools: platform.tools, impls: platform.impls, checks: platform.checks };
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

/**
 * 导出分两类：
 *   1. 契约元数据 + 工厂 —— PORT_CONTRACT/PORT_NAMES/NON_PORT_TOOLS/PORT_IMPLS/assertPortContract
 *      + 平台解析（ADAPTER_PLATFORMS/assertAdapterRegistry/resolveAdapterName/resolveProjectAdapters）；
 *      供审计、单测与 `createCcAdapters` 组装；createHost/createHookAdapter 是工厂原样透出。
 *   2. 单端口句柄 —— `host` / `hook` / `oneshot` / `tooling` / `interactive` / `probe` / `shapes` / `extract`，
 *      这是生产源码唯一的取用入口（T1-117）。注意 `host`/`hook` 同时以上面两种形态出现：
 *      `createHost`/`createHookAdapter` 是「能造多个实例的工厂」，`host`/`hook` 是「默认句柄」，
 *      二者是同一个函数引用，只是命名区分用法。
 * **按项目的平台解析走 `resolveProjectAdapters()`**（T-P1-01）；上面这批 cc 单端口句柄只供
 * 「平台无关的纯工具/默认 cc」场景，新代码优先用解析结果。
 * `shapes` / `extract` 一并从这门出，尽管它们不在 7 端口名册（裁决见 NON_PORT_TOOLS）。
 */
module.exports = {
  // 契约元数据 + 工厂 + 平台解析
  PORT_CONTRACT, PORT_NAMES, NON_PORT_TOOLS, PORT_IMPLS, assertPortContract,
  REQUIRED_PORT_METHODS, assertRequiredMethods,
  createCcAdapters, createHost, createHookAdapter,
  ADAPTER_PLATFORMS, ADAPTER_NAMES, ADAPTER_ENV, ADAPTER_DEFAULT,
  assertAdapterRegistry, resolveAdapterName, resolveProjectAdapters,
  // 单端口句柄
  host: createHost,
  hook: createHookAdapter,
  oneshot,
  tooling,
  interactive,
  probe,
  shapes,
  extract,
  settings,
  profile,
};
