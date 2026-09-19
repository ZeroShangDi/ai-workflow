#!/usr/bin/env node
'use strict';
/**
 * roundtrip.cjs — AWF ↔ DSH 插件「指令通道」的**真实链路**验证（P2-5a）
 *
 * 验的是真东西：真 AWF server（进程内，隔离临时项目）+ 真 DSH 进程（隔离 DSH_HOME）
 * + 真 WS 下行 + 真 HTTP 回传。**不派模型**（省额度）：只跑不需要会话的指令与错误路径。
 *
 * 用法：
 *   bash scripts/probe/dsh/guard.sh snapshot
 *   bash scripts/probe/dsh/install-fixture.sh
 *   node scripts/probe/dsh/roundtrip.cjs                 # 不派模型（快、省额度）
 *   node scripts/probe/dsh/roundtrip.cjs --prompt "只回复两个字：收到"
 *                                                        # 额外真派一轮模型，验「回合结束 → session.ready」
 *   node scripts/probe/dsh/roundtrip.cjs --task          # 真落账（模型调 awf_task_complete）
 *   node scripts/probe/dsh/roundtrip.cjs --bash          # U16 取证：workspace-write 下普通 bash 要不要批准
 *   node scripts/probe/dsh/roundtrip.cjs --plan          # 规划入口（C07）：建规划会话 + 注入指令
 *   node scripts/probe/dsh/roundtrip.cjs --oneshot       # 一次性调用（C23）：不建会话的 llm 调用
 *   node scripts/probe/dsh/roundtrip.cjs --runtime       # 走 runtime/适配器层（项目配置解析 → dsh 工厂 → 插件）
 *   node scripts/probe/dsh/roundtrip.cjs --run           # 真跑一次 run 宿主：建会话 → 提交 → 派发 → 落账
 *   node scripts/probe/dsh/roundtrip.cjs --two-projects  # 双项目隔离验收（单后台、各自会话与项目 MCP）
 *   node scripts/probe/dsh/roundtrip.cjs --subagent      # 子 Agent：真派出来 + RESULT 真落账 + 停 run 时真打断（U11/C14/T-P3-01）
 *   node scripts/probe/dsh/roundtrip.cjs --attach         # `awf attach`（独立 CLI 进程）拿到网页会话地址（C24/C31）
 *   node scripts/probe/dsh/roundtrip.cjs --batch          # 多 agent：宿主 batch 调度 → DSH 派子 Agent → RESULT 落账（T-P3-01）
 *   node scripts/probe/dsh/roundtrip.cjs --decision       # 回合末门阀：模型输出 <AWF_DECISION_REQUIRED> → 指令发回 → 结论落盘（T-P3-02）
 *   node scripts/probe/dsh/roundtrip.cjs --cli-plan       # `awf plan`（独立 CLI 进程）经 server 代触发规划入口（C07）
 *   bash scripts/probe/dsh/guard.sh check     # 必须 IDENTICAL
 *
 * 退出码：0 = 通道真实可用；1 = 失败（打印现场）；2 = 用法/环境错误。
 */

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const zlib = require('node:zlib');

const REPO = path.resolve(__dirname, '..', '..', '..');
const DSH_HOME = process.env.AWF_DSH_PROBE_HOME || '/tmp/awf-dsh-probe';
const PROFILE = process.env.AWF_PROBE_PROFILE || 'awf-probe';
const DSH_PORT = Number(process.env.AWF_PROBE_WEB_PORT || 39081);
const CONNECT_TIMEOUT_MS = Number(process.env.AWF_ROUNDTRIP_TIMEOUT_MS || 60000);
const RESULT_TIMEOUT_MS = 15000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 跑一个 CLI 子进程并收集输出（`awf attach` 是**独立进程**，CLI 里没有 bridge —— 必须这么测） */

/**
 * 读隔离 DSH 里某项目会话的**首条用户消息**（用来核对「平台到底收到了什么」）。
 * DSH 的会话日志是 zstd **多帧**追加的（`session.v3.jsonl.zstd`）：逐帧解压再拼。
 * @param {string} dshHome
 * @param {string} cwd 项目根（会话 header 里的 cwd）
 * @returns {string|null} 首条 user/message 文本；找不到 → null
 */
function readFirstUserMessage(dshHome, cwd) {
  const sessionsDir = path.join(dshHome, 'sessions');
  if (!fs.existsSync(sessionsDir)) return null;
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  for (const dir of fs.readdirSync(sessionsDir)) {
    const root = path.join(sessionsDir, dir);
    if (!fs.statSync(root).isDirectory()) continue;
    for (const sid of fs.readdirSync(root)) {
      const file = path.join(root, sid, 'session.v3.jsonl.zstd');
      if (!fs.existsSync(file)) continue;
      const buf = fs.readFileSync(file);
      const offs = [];
      let i = 0;
      while ((i = buf.indexOf(magic, i)) !== -1) { offs.push(i); i += 4; }
      let text = '';
      offs.forEach((start, k) => {
        const end = k + 1 < offs.length ? offs[k + 1] : buf.length;
        try { text += zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8'); } catch { /* 半截帧 */ }
      });
      let header = null;
      let first = null;
      for (const line of text.trim().split('\n')) {
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.type === 'session') header = e;
        if (!first && e.type === 'user/message' && e.data?.source?.kind === 'user') first = e.data?.content?.[0]?.text ?? null;
      }
      if (header && first && header.cwd && fs.realpathSync.native(header.cwd) === fs.realpathSync.native(cwd)) return first;
    }
  }
  return null;
}

function runCli(args, { cwd, env }) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(REPO, 'cli', 'awf.cjs'), ...args], { cwd, env });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

/** `--prompt <text>`：额外真派一轮模型（默认不派，省额度）；`--task`：跑「挂 MCP + 真落账」那一段 */
function parseArgs(argv) {
  const i = argv.indexOf('--prompt');
  const taskIdx = argv.indexOf('--task');
  const bashIdx = argv.indexOf('--bash');
  const planIdx = argv.indexOf('--plan');
  const oneshotIdx = argv.indexOf('--oneshot');
  const runtimeIdx = argv.indexOf('--runtime');
  const runIdx = argv.indexOf('--run');
  const twoIdx = argv.indexOf('--two-projects');
  const subIdx = argv.indexOf('--subagent');
  const attachIdx = argv.indexOf('--attach');
  const batchIdx = argv.indexOf('--batch');
  const decisionIdx = argv.indexOf('--decision');
  const cliPlanIdx = argv.indexOf('--cli-plan');
  const prompt = i === -1 ? null : (argv[i + 1] ?? '');
  return { prompt, task: taskIdx !== -1, bash: bashIdx !== -1, plan: planIdx !== -1, oneshot: oneshotIdx !== -1, runtime: runtimeIdx !== -1, run: runIdx !== -1, twoProjects: twoIdx !== -1, subagent: subIdx !== -1, attach: attachIdx !== -1, batch: batchIdx !== -1, decision: decisionIdx !== -1, cliPlan: cliPlanIdx !== -1 };
}
const stamp = () => new Date().toISOString();

function fail(msg, extra) {
  console.error(`[roundtrip] ✗ ${msg}`);
  if (extra !== undefined) console.error(JSON.stringify(extra, null, 2));
  process.exitCode = 1;
}

async function main() {
  if (DSH_HOME === path.join(os.homedir(), '.dsh')) {
    console.error('[roundtrip] 拒绝：DSH_HOME 指向真实 home。用隔离目录。');
    return 2;
  }

  // ── ① 隔离临时项目 + 进程内 AWF server ──
  const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-roundtrip-'));
  fs.mkdirSync(path.join(tmpProject, '.awf'), { recursive: true });
  fs.writeFileSync(path.join(tmpProject, '.awf', 'state.json'),
    JSON.stringify({
      mode: 'idle',
      version: '0.2.0',
      currentState: 'IDLE',
      milestones: [],
      plan: { summary: 'P2-5d 真实链路夹具' },
      tasks: [{
        id: 'T1',
        title: '把这一条标记完成',
        kind: 'dev',
        // run 模式下宿主派发的就是这条 prompt —— 必须自足（不是靠 harness 另外再发一句话）
        prompt: '请调用工具 awf_task_complete，把任务 T1 标记为 done（result 写 "run-smoke"），然后只回复 DONE。',
        status: 'pending',
        deps: [],
        wbsRef: null,
        acceptance: 'x',
      }, {
        id: 'T2',
        title: '子 Agent 用 RESULT 协议落这一条',
        kind: 'dev',
        prompt: '（--subagent 模式：这一条由宿主派出的子 Agent 用 RESULT 协议结算）',
        status: 'pending',
        deps: [],
        wbsRef: null,
        acceptance: 'x',
      }],
    }));

  process.env.CC_PROJECT = tmpProject;
  // 端口不能用 0：runtime-config 的校验要求 1–65535，且 server 内部链接也读它。
  // 先占一个空闲端口再释放（避免撞上用户正在跑的 8787）。
  const freePort = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
  process.env.CC_PORT = String(freePort);
  const server = require(path.join(REPO, 'server', 'server.cjs'));
  const channelMod = require(path.join(REPO, 'server', 'web', 'bridge-channel.cjs'));

  const { port } = await server.start(freePort);
  const awfBase = `http://127.0.0.1:${port}`;
  console.log(`[roundtrip] AWF server 起于 ${awfBase}（项目 ${tmpProject}）`);

  // ── ② 起隔离 DSH（带 AWF 地址）──
  // 缺省经 **环境变量** AWF_DSH_BASE 告诉插件地址（实验方便）；
  // `AWF_PROBE_BASE_VIA=config` 则改成写进 **profile 配置**（生产安装形态：`awf init` 写的
  // `config.awfBase`），并**不再**传环境变量 —— 用来证伪「真实安装路径其实连不上」。
  const viaConfig = process.env.AWF_PROBE_BASE_VIA === 'config';
  {
    // 先清掉上一次 config 模式留下的注入行：插件是 `config.awfBase || AWF_DSH_BASE`，
    // **配置优先于环境变量** —— 残留的旧端口会让本次运行连到上次的端口上（实测踩到：
    // 日志里地址是上一次的端口，本次 AWF_DSH_BASE 被无视，插件一直连不上）。
    const patchPath = path.join(DSH_HOME, 'profiles', PROFILE, 'cordis.patch.yml');
    // 过滤掉上一次留下的注入行（含历史安装可能写过的 awfRepo —— 该配置项已从托管块删除，
    // 这里的过滤只是把旧现场清干净，避免配置优先于环境变量造成「连到上次的端口」）
    const lines = fs.readFileSync(patchPath, 'utf8').split('\n')
      .filter((l) => !l.includes('awfBase:') && !l.includes('awfRepo:'));
    if (viaConfig) {
      const idx = lines.findIndex((l) => l.includes('webPort:'));
      if (idx === -1) {
        console.error('[roundtrip] ✗ AWF_PROBE_BASE_VIA=config 但 profile patch 里找不到 awf-dsh 的 webPort 行');
        return 2;
      }
      // 生产安装形态：配置项只从 profile 配置读，不传环境变量
      lines.splice(idx, 0, `        awfBase: '${awfBase}'`);
      console.log(`[roundtrip] 地址改由 profile 配置提供（awfBase=${awfBase}），不传环境变量`);
    } else if (lines.length !== fs.readFileSync(patchPath, 'utf8').split('\n').length) {
      console.log('[roundtrip] 已清掉 profile 里上一次的 awfBase/awfRepo（本次走环境变量）');
    }
    fs.writeFileSync(patchPath, lines.join('\n'));
  }
  const dshLog = [];
  const childEnv = { ...process.env, DSH_HOME };
  if (viaConfig) delete childEnv.AWF_DSH_BASE;
  else childEnv.AWF_DSH_BASE = awfBase;
  /** 起一个隔离 DSH 子进程（重启重连场景要起两次，故抽成函数） */
  const spawnDsh = () => {
    const c = spawn('dsh', ['--profile', PROFILE, '--port', String(DSH_PORT), '--no-open'], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    c.stdout.setEncoding('utf8');
    c.stderr.setEncoding('utf8');
    c.stdout.on('data', (d) => dshLog.push(d));
    c.stderr.on('data', (d) => dshLog.push(d));
    return c;
  };
  let child = spawnDsh();
  console.log(`[roundtrip] DSH 起于 :${DSH_PORT}（DSH_HOME=${DSH_HOME}，AWF_DSH_BASE=${awfBase}）`);

  const evidence = { startedAt: stamp(), awfBase, dshPort: DSH_PORT, steps: {} };
  try {
    // ── ③ 等插件连上 AWF 的 WS ──
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    while (Date.now() < deadline && !channelMod.channel().connected()) await sleep(300);
    if (!channelMod.channel().connected()) {
      fail('插件未在超时内连上 AWF 指令通道', { dshLogTail: dshLog.join('').slice(-1500) });
      return;
    }
    evidence.steps.connected = { at: stamp(), facts: channelMod.channel().lastFacts() };
    console.log(`[roundtrip] ✓ 插件已连上（platform=${evidence.steps.connected.facts.platform}）`);

    // ── ③b 重启 DSH → 插件必须重连，且通道真的恢复可用（V09 基础场景；
    //     真机踩过的坑：旧 socket 的 close 迟到把新连接误判为断开 → 之后所有指令都回 ws closed）──
    if (process.env.AWF_ROUNDTRIP_RECONNECT === '1') {
      console.log('[roundtrip] 重启隔离 DSH，验重连…');
      child.kill('SIGTERM');
      const downDeadline = Date.now() + 15000;
      while (Date.now() < downDeadline && channelMod.channel().connected()) await sleep(200);
      const sawDown = !channelMod.channel().connected();
      child = spawnDsh();
      const upDeadline = Date.now() + CONNECT_TIMEOUT_MS;
      while (Date.now() < upDeadline && !channelMod.channel().connected()) await sleep(300);
      const backUp = channelMod.channel().connected();
      evidence.steps.reconnect = { sawDown, backUp };
      if (!backUp) {
        fail('DSH 重启后插件没重连（通道没恢复）', { sawDown, dshLogTail: dshLog.join('').slice(-1200) });
        return;
      }
      // 重连 ≠ 可用：立刻发一条真指令，必须照常受理（这正是「迟到 close」会打掉的那一步）
      const after = await channelMod.channel().request('session.facts', { projectRoot: tmpProject },
        { projectRoot: tmpProject, resultTimeoutMs: RESULT_TIMEOUT_MS });
      evidence.steps['session.facts(重连后)'] = after;
      if (after.delivery !== 'accepted' || after.ok !== true) {
        fail('重连后指令仍不可用（通道判定被迟到事件打掉）', after);
        return;
      }
      console.log(`[roundtrip] ✓ 重启后已重连，且通道真的可用（sawDown=${sawDown}）`);
    }

    // ── ④ 真发一条指令：session.facts（不需要模型）──
    const facts = await channelMod.channel().request('session.facts', { projectRoot: tmpProject },
      { projectRoot: tmpProject, resultTimeoutMs: RESULT_TIMEOUT_MS });
    evidence.steps['session.facts(建会话前)'] = facts;
    if (facts.delivery !== 'accepted' || facts.ok !== true) {
      fail('session.facts 未拿到「已交给平台 + 成功」的结论', facts);
      return;
    }
    console.log(`[roundtrip] ✓ session.facts 回执：${JSON.stringify(facts.result)}`);

    // ── ⑤ 未实现的 op 必须显式失败（错误路径也是链路的一部分）──
    const notImpl = await channelMod.channel().request('session.facts', { projectRoot: tmpProject, bogus: 1 },
      { projectRoot: tmpProject, resultTimeoutMs: RESULT_TIMEOUT_MS });
    evidence.steps['session.facts(未知参数仍成功，参数校验在平台侧)'] = notImpl;
    if (notImpl.delivery !== 'accepted') {
      fail('带未知参数的 facts 没拿到「已交给平台」的结论', notImpl);
      return;
    }
    const unimplemented = await channelMod.channel().request('plugin.install', { scope: 'profile' },
      { projectRoot: tmpProject, resultTimeoutMs: RESULT_TIMEOUT_MS });
    evidence.steps['plugin.install(未实现)'] = unimplemented;
    // 只断言「已交给平台 + 明确失败 + 有原因」——具体原因是「未实现」还是「不属这一层」由 op 自己说清
    if (unimplemented.delivery !== 'accepted' || unimplemented.ok !== false || !unimplemented.error) {
      fail('未实现 op 没有给出「已交给平台 + 明确失败」的结论（不许冒充成功）', unimplemented);
      return;
    }
    console.log(`[roundtrip] ✓ 未实现 op 明确失败：${unimplemented.error}`);

    // ── ⑥ 真建会话（不派模型）→ facts 必须翻转 ──
    const created = await channelMod.channel().request('session.create', { projectRoot: tmpProject },
      { projectRoot: tmpProject, resultTimeoutMs: 30000 });
    evidence.steps['session.create'] = created;
    if (created.delivery !== 'accepted' || created.ok !== true || !created.result?.sessionId) {
      fail('session.create 未成功（详见 result/error）', created);
      return;
    }
    console.log(`[roundtrip] ✓ 会话已创建：${created.result.sessionId}（preset=${created.result.agentPreset}）`);
    // 工作区登记：DSH 网页按工作区分组会话，没登记就落到「未分组」（真机踩到）
    const ws = created.result.workspace;
    evidence.steps['session.create.workspace'] = ws;
    if (ws?.ok !== true) {
      fail('会话没有登记到工作区（网页里会显示「未分组」）', ws);
      return;
    }
    console.log(`[roundtrip] ✓ 已挂到工作区：${ws.title ?? '(无标题)'}（${ws.created ? '新建' : '已存在'} id=${ws.id ?? '?'}）`);

    const factsAfter = await channelMod.channel().request('session.facts', { projectRoot: tmpProject },
      { projectRoot: tmpProject, resultTimeoutMs: RESULT_TIMEOUT_MS });
    evidence.steps['session.facts(建会话后)'] = factsAfter;
    if (factsAfter.result?.sessionId !== created.result.sessionId || factsAfter.result?.sessionExists !== true) {
      fail('建会话后 facts 未反映该会话（平台事实与创建结果不一致）', factsAfter);
      return;
    }
    console.log(`[roundtrip] ✓ facts 已反映该会话（sessionExists=true, cwd=${factsAfter.result.cwd}）`);
    if (factsAfter.result?.url === undefined) {
      fail('facts 没带观看地址（CLI 的 `awf attach` 在 DSH 下就没有落点）', factsAfter.result);
      return;
    }

    // ── ⑥a `awf attach`：**独立 CLI 进程**（没有 bridge）→ 只能经 AWF server 的 /probe 拿地址 ──
    if (parseArgs(process.argv.slice(2)).attach) {
      fs.writeFileSync(path.join(tmpProject, '.awf', 'config.json'), JSON.stringify({ runtime: { adapter: 'dsh' } }));
      const attached = await runCli(['attach'], {
        cwd: tmpProject,
        env: { ...process.env, AWF_BROWSER: 'true' }, // 探针里不真弹浏览器
      });
      evidence.steps['awf attach'] = attached;
      const want = `session=${created.result.sessionId}`;
      if (attached.code !== 0 || !attached.out.includes(want)) {
        fail(`\`awf attach\` 没给出本项目会话的网页地址（期望含 ${want}）`, attached);
        return;
      }
      console.log(`[roundtrip] ✓ \`awf attach\`（独立进程）拿到会话地址：${attached.out}`);
    }

    // ── ⑥b 规划入口（C07）：新建规划会话 + 注入指令（**会派模型**）──
    if (parseArgs(process.argv.slice(2)).plan) {
      const plan = await channelMod.channel().request('plan.launch', {
        cwd: tmpProject,
        prompt: '这是 AWF 接入验证：请只回复 PLAN-OK，不要做别的。',
      }, { projectRoot: tmpProject, resultTimeoutMs: 60000 });
      evidence.steps['plan.launch'] = plan;
      if (plan.delivery !== 'accepted' || plan.ok !== true || plan.result?.accepted !== true || !plan.result?.url) {
        fail('plan.launch 未成功（应有 sessionId + accepted + 网页 URL）', plan);
        return;
      }
      console.log(`[roundtrip] ✓ 规划会话已建并注入指令：${plan.result.sessionId} url=${plan.result.url}`);
    }

    // ── ⑥c 一次性调用（C23）：不建会话的大模型调用（**会派模型**）──
    if (parseArgs(process.argv.slice(2)).oneshot) {
      const one = await channelMod.channel().request('llm.oneshot', { prompt: '只回复 OK', timeoutMs: 60000 },
        { resultTimeoutMs: 90000 });
      evidence.steps['llm.oneshot'] = one;
      if (one.delivery !== 'accepted' || one.ok !== true || typeof one.result?.text !== 'string' || one.result.text === '') {
        fail('llm.oneshot 未拿到文本（C23 需要真的一次性调用）', one);
        return;
      }
      console.log(`[roundtrip] ✓ 一次性调用返回文本：${JSON.stringify(one.result.text.slice(0, 60))}`);
    }

    // ── ⑥e（可选，**会派模型**）回合末门阀（决策）：DSH 没有 Stop hook 回灌通道，
    //    门阀指令必须由 AWF **再发一条 prompt** 回去 —— 这里验的就是这条真实回路 ──
    if (parseArgs(process.argv.slice(2)).decision) {
      fs.writeFileSync(path.join(tmpProject, '.awf', 'config.json'), JSON.stringify({
        runtime: { adapter: 'dsh' },
        run: { decision: { enabled: true, mode: 'auto' } },
      }));
      const { createProjectRuntime } = require(path.join(REPO, 'server', 'runtime', 'index.cjs'));
      const rt = createProjectRuntime({ projectRoot: tmpProject, adapterDeps: { bridge: channelMod.channel() } });
      try {
        await rt.ctx.adapters.ports.session.start({ projectRoot: tmpProject });
        const asks = [
          '不要调用任何工具。请把这一行原样作为你的**最后一段**输出（前后不要加别的字）：'
          + '<AWF_DECISION_REQUIRED>要不要现在就动手？</AWF_DECISION_REQUIRED>',
        ];
        const seen = [];
        const off = channelMod.channel().onEvent((e) => seen.push(e?.type));
        for (const text of asks) {
          await rt.ctx.adapters.ports.host.sendPrompt(text);
          await sleep(1000);
        }
        // 门阀登场 → AWF 把决策指令发回会话 → 模型再跑一轮 → 结论落盘
        const deadline = Date.now() + Number(process.env.AWF_ROUNDTRIP_TURN_TIMEOUT_MS || 240000);
        const runsDir = path.join(tmpProject, '.awf', 'decisions', 'runs');
        let records = [];
        while (Date.now() < deadline) {
          await sleep(2000);
          records = fs.existsSync(runsDir)
            ? fs.readdirSync(runsDir).flatMap((f) => {
              const raw = fs.readFileSync(path.join(runsDir, f), 'utf8').trim();
              return raw ? raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
            })
            : [];
          if (records.some((r) => r.event === 'decision_completed')) break;
        }
        off();
        evidence.steps['decision.events'] = seen;
        evidence.steps['decision.records'] = records.map((r) => ({ event: r.event, id: r.decision_id ?? r.decisionId ?? null }));
        const done = records.find((r) => r.event === 'decision_completed');
        if (!done) {
          const snap = await channelMod.channel().request('session.snapshot', { projectRoot: tmpProject }, { projectRoot: tmpProject, resultTimeoutMs: 20000 });
          fail('回合末门阀没跑出结论（DSH 决策回路未通）', { events: seen, snapshot: snap.result?.text ?? null });
          return;
        }
        console.log(`[roundtrip] ✓ 回合末门阀跑通：决策结论已落盘（${done.decision_id ?? done.decisionId}），events=${JSON.stringify(seen)}`);
      } finally {
        rt.reset();
      }
    }

    // ── ⑥f（可选，**会派模型**）`awf plan`：独立 CLI 进程里没有 bridge，规划入口
    //    必须经常驻 server 的 `POST /interactive/plan` 触发 —— 这里验的就是这一条 ──
    if (parseArgs(process.argv.slice(2)).cliPlan) {
      fs.writeFileSync(path.join(tmpProject, '.awf', 'config.json'), JSON.stringify({ runtime: { adapter: 'dsh' } }));
      // 假 server 就绪等待：`awf plan` 会去戳本项目的 AWF server（探针进程内就是那个 server）
      const planned = await runCli(['plan', '验证 DSH 规划入口'], {
        cwd: tmpProject,
        env: { ...process.env, AWF_BROWSER: 'true' },
      });
      evidence.steps['awf plan'] = planned;
      if (planned.code !== 0 || !/规划会话已在网页/.test(planned.out) || !/\?session=/.test(planned.out)) {
        fail('`awf plan`（独立进程）没能经 server 触发规划入口', planned);
        return;
      }
      console.log(`[roundtrip] ✓ \`awf plan\`（独立进程）经 server 触发规划入口：${planned.out.split('\n')[0]}`);

      // 平台**到底收到了什么**：等日志落盘后读会话首条用户消息。
      // 这一步正是为了证伪「发过去的还是斜杠命令、模型不认识」（真机踩到过）。
      await sleep(6000);
      const sent = readFirstUserMessage(DSH_HOME, tmpProject);
      evidence.steps['plan.平台收到的首条消息'] = sent ? sent.slice(0, 200) : null;
      if (!sent) {
        console.log('[roundtrip] ⚠ 没读到会话首条消息（日志未落盘？）——跳过内容核对');
      } else if (sent.includes('/ai-workflow-code:w-plan')) {
        fail('平台上收到的还是斜杠命令字面量（模型无法执行）', { sent: sent.slice(0, 200) });
        return;
      } else if (!sent.includes('## 执行阶段')) {
        fail('平台上收到的不是展开后的规划指令', { sent: sent.slice(0, 300) });
        return;
      } else {
        console.log(`[roundtrip] ✓ 平台收到的是展开后的规划指令（${sent.length} 字，含需求原文：${sent.includes('验证 DSH 规划入口')}）`);
      }
    }

    // ── ⑦ 停止：cancel（keepInbox），且**不删会话**（spec §2：停项目不停后台/不删对话）──
    const stopped = await channelMod.channel().request('session.stop', { projectRoot: tmpProject },
      { projectRoot: tmpProject, resultTimeoutMs: RESULT_TIMEOUT_MS });
    evidence.steps['session.stop'] = stopped;
    if (stopped.delivery !== 'accepted' || stopped.ok !== true) {
      fail('session.stop 未成功', stopped);
      return;
    }
    const factsStopped = await channelMod.channel().request('session.facts', { projectRoot: tmpProject },
      { projectRoot: tmpProject, resultTimeoutMs: RESULT_TIMEOUT_MS });
    evidence.steps['session.facts(停止后)'] = factsStopped;
    if (factsStopped.result?.sessionExists !== true) {
      fail('停止后会话不应被删除（停止 ≠ 删除；spec §2 边界）', factsStopped);
      return;
    }
    console.log(`[roundtrip] ✓ 已停止且会话仍在（cancel keepInbox，未删会话）：${JSON.stringify(stopped.result)}`);

    // ── ⑧（可选，**会派模型**）真派一轮：验「平台受理回执」与「回合结束 → session.ready」是两件事 ──
    const { prompt: userPrompt, task: taskIdx, bash: bashIdx } = parseArgs(process.argv.slice(2));
    const prompt = taskIdx
      ? '请调用工具 awf_task_complete，把任务 T1 标记为 done（result 写 "P2-5d 真实链路"）。完成后只回复 DONE。'
      : bashIdx
        ? '请用 bash 工具运行 `pwd`，然后只回复命令输出。'
        : userPrompt;
    if (prompt) {
      const events = [];
      const off = channelMod.channel().onEvent((e) => events.push(e));
      const sent = await channelMod.channel().request('session.prompt', { projectRoot: tmpProject, text: prompt },
        { projectRoot: tmpProject, resultTimeoutMs: 30000 });
      evidence.steps['session.prompt'] = sent;
      if (sent.delivery !== 'accepted' || sent.ok !== true || sent.result?.accepted !== true) {
        off();
        fail('session.prompt 未拿到「平台受理」回执', sent);
        return;
      }
      console.log(`[roundtrip] ✓ 平台已受理（accepted=true）；等回合结束…`);

      const promptDeadline = Date.now() + Number(process.env.AWF_ROUNDTRIP_TURN_TIMEOUT_MS || 180000);
      let ready = false;
      let lastFacts = null;
      while (Date.now() < promptDeadline) {
        await sleep(1000);
        const f = await channelMod.channel().request('session.facts', { projectRoot: tmpProject },
          { projectRoot: tmpProject, resultTimeoutMs: RESULT_TIMEOUT_MS });
        lastFacts = f.result;
        if (f.result?.ready === true) { ready = true; break; }
      }
      off();
      evidence.steps['prompt.events'] = events.map((e) => e && e.type);
      evidence.steps['session.facts(回合结束后)'] = lastFacts;
      if (!ready) {
        fail('回合未在超时内结束（session.ready 未到）——「已受理」不能当「已完成」', { events, lastFacts });
        return;
      }
      console.log(`[roundtrip] ✓ 回合结束：events=${JSON.stringify(events.map((e) => e && e.type))}`);

      // 证据（C25 快照）：最后一条助手消息的文本
      const snap = await channelMod.channel().request('session.snapshot', { projectRoot: tmpProject },
        { projectRoot: tmpProject, resultTimeoutMs: RESULT_TIMEOUT_MS });
      evidence.steps['session.snapshot'] = snap.result ?? snap.error;
      console.log(`[roundtrip] ✓ 快照：${JSON.stringify(String(snap.result?.text ?? '').slice(0, 80))}${snap.result?.truncated ? '（截断）' : ''}`);

      // 证据（U16）：这一轮里平台有没有请求过批准（插件按「只记录+委派」上报）
      const approvals = events.filter((e) => e && e.type === 'approval.requested');
      evidence.steps['approval.requested'] = approvals;
      if (bashIdx) {
        console.log(approvals.length
          ? `[roundtrip] ⚠ 本轮出现 ${approvals.length} 次批准请求（U16 需要规则）：${JSON.stringify(approvals.map((a) => ({ tool: a.toolName, ours: a.ours })))}`
          : '[roundtrip] ✓ 本轮无批准请求（workspace-write 下的普通 bash 不需要批准）');
      }

      // 证据：这一轮里模型**可见的工具表**是否含 awf MCP 工具（F29/F30：header 折叠后才有值）
      const toolsSnap = await channelMod.channel().request('session.tools', { projectRoot: tmpProject },
        { projectRoot: tmpProject, resultTimeoutMs: RESULT_TIMEOUT_MS });
      evidence.steps['session.tools'] = toolsSnap.result ?? toolsSnap.error;
      if (toolsSnap.result?.mcp?.length) {
        console.log(`[roundtrip] ✓ MCP 工具已进可见工具表：${JSON.stringify(toolsSnap.result.mcp)}`);
      } else {
        console.log(`[roundtrip] ⚠ 未在工具表里看到 MCP 工具（count=${toolsSnap.result?.count ?? '?'}）`);
      }

      if (taskIdx) {
        // 真落账断言：MCP 工具写的是磁盘上的 state.json（AWF 的单一事实源）
        const st = JSON.parse(fs.readFileSync(path.join(tmpProject, '.awf', 'state.json'), 'utf8'));
        const t1 = (st.tasks || []).find((t) => t.id === 'T1');
        evidence.steps['state.json(T1)'] = { status: t1?.status ?? null, exec: t1?.exec ?? null };
        if (t1?.status !== 'done') {
          fail('任务 T1 未被模型经 AWF MCP 工具落账为 done（真实链路未通）', { t1, tools: sent.result?.tools });
          return;
        }
        console.log(`[roundtrip] ✓ 经 AWF MCP 工具真落账：T1.status=${t1.status}`);
      }
    }

    // ── ⑨（可选）走 **runtime / 适配器层**（CLI 与宿主实际用的那条路）──
    // 前面各步用的是原始 bridge；这一步验「项目配置 → resolveProjectAdapters → dsh 工厂 → bridge → 插件」整条。
    if (parseArgs(process.argv.slice(2)).runtime) {
      fs.mkdirSync(path.join(tmpProject, '.awf'), { recursive: true });
      fs.writeFileSync(path.join(tmpProject, '.awf', 'config.json'), JSON.stringify({ runtime: { adapter: 'dsh' } }));
      const { createProjectRuntime } = require(path.join(REPO, 'server', 'runtime', 'index.cjs'));
      // 与 AWF server 用的是**同一个** bridge 单例（插件连的是 server 的 WS）
      const rt = createProjectRuntime({
        projectRoot: tmpProject,
        adapterDeps: { bridge: channelMod.channel() },
      });
      try {
        const ports = rt.ctx.adapters.ports;
        evidence.steps['runtime.adapter'] = rt.ctx.adapter;
        if (rt.ctx.adapter !== 'dsh') { fail(`runtime 未按项目配置解析到 dsh（得到 ${rt.ctx.adapter}）`); return; }

        const started = await ports.session.start({ projectRoot: tmpProject });
        evidence.steps['runtime.session.start'] = started;
        if (!started?.sessionId) { fail('runtime 路径建会话失败', started); return; }

        const snap = await ports.probe.inspect();
        evidence.steps['runtime.probe.inspect'] = snap;
        if (snap.ok !== true || snap.session !== true) { fail('runtime 路径 probe.inspect 未看到会话', snap); return; }

        await ports.session.kill(); // 端口契约里停止叫 kill（= dsh 的 cancel + 子 Agent 打断，不删会话）
        console.log(`[roundtrip] ✓ runtime 路径全通：adapter=dsh → session.start(${started.sessionId}) → probe.inspect(state=${snap.state}) → kill`);
      } finally {
        rt.reset();
      }
    }

    // ── ⑩（可选，**会派模型**）真跑一次 run 宿主：建会话 → 提交 run → 宿主派发 → 任务落账 ──
    // 这是 spec §7 P2 出口的「单任务 run」：CLI 提交、宿主驱动、适配器派发、平台执行、state 落账。
    if (parseArgs(process.argv.slice(2)).run) {
      fs.writeFileSync(path.join(tmpProject, '.awf', 'config.json'), JSON.stringify({
        runtime: { adapter: 'dsh' },
        run: { agents: { max: 1, maxModules: 1, maxPerModule: 1, maxPerFeature: 1 }, decision: { enabled: false, mode: 'auto' } },
      }));
      const { createProjectRuntime } = require(path.join(REPO, 'server', 'runtime', 'index.cjs'));
      const rt = createProjectRuntime({ projectRoot: tmpProject, adapterDeps: { bridge: channelMod.channel() } });
      try {
        await rt.ctx.adapters.ports.session.start({ projectRoot: tmpProject });
        const host = await rt.ensureRunHost();
        if (!host) throw new Error(`run host 未就绪：${rt.runHostBootErr?.message ?? 'unknown'}`);
        const sub = host.submitRun({ mode: 'single' });
        evidence.steps['run.submit'] = sub;
        if (!sub?.ok) throw new Error(`提交 run 失败：${sub?.error}`);

        const deadline = Date.now() + Number(process.env.AWF_ROUNDTRIP_RUN_TIMEOUT_MS || 240000);
        let snap = null;
        while (Date.now() < deadline) {
          await sleep(2000);
          snap = host.snapshot(sub.runId);
          if (snap?.run?.status && !['running', 'queued'].includes(snap.run.status)) break;
        }
        evidence.steps['run.snapshot'] = snap?.run ?? snap;
        const st = JSON.parse(fs.readFileSync(path.join(tmpProject, '.awf', 'state.json'), 'utf8'));
        const t1 = (st.tasks || []).find((t) => t.id === 'T1');
        evidence.steps['run.state.json(T1)'] = { status: t1?.status ?? null, exec: t1?.exec ?? null };
        if (t1?.status !== 'done') {
          fail('run 宿主跑完后 T1 仍未 done（单任务 run 在 DSH 上未通）', { run: snap?.run, t1 });
          return;
        }
        console.log(`[roundtrip] ✓ run 宿主单任务跑通：run=${snap?.run?.status} T1=${t1.status}`
          + (snap?.run?.error ? `（run.error=${snap.run.error}）` : ''));
      } finally {
        rt.reset();
      }
    }

    // ── ⑩b（可选，**会派模型**）多 agent：宿主 batch 调度 + DSH 原生子 Agent + RESULT 落账 ──
    // 与 `--run` 的差别：派发提示词里含**平台工具措辞**（这里是 DSH 的 `subagent` 工具），
    // 且完成感知靠子 Agent 自己输出的 RESULT（不走 MCP 工具落账）—— 这才是 batch 的真实链路。
    if (parseArgs(process.argv.slice(2)).batch) {
      fs.writeFileSync(path.join(tmpProject, '.awf', 'config.json'), JSON.stringify({
        runtime: { adapter: 'dsh' },
        run: { agents: { max: 2, maxModules: 1, maxPerModule: 1, maxPerFeature: 1 }, decision: { enabled: false, mode: 'auto' } },
      }));
      const st0 = JSON.parse(fs.readFileSync(path.join(tmpProject, '.awf', 'state.json'), 'utf8'));
      st0.tasks = [{ ...st0.tasks[0], id: 'T1', status: 'pending', title: '把这一条做完（batch）' }];
      fs.writeFileSync(path.join(tmpProject, '.awf', 'state.json'), JSON.stringify(st0));
      const { createProjectRuntime } = require(path.join(REPO, 'server', 'runtime', 'index.cjs'));
      const rt = createProjectRuntime({ projectRoot: tmpProject, adapterDeps: { bridge: channelMod.channel() } });
      try {
        await rt.ctx.adapters.ports.session.start({ projectRoot: tmpProject });
        const host = await rt.ensureRunHost();
        if (!host) throw new Error(`run host 未就绪：${rt.runHostBootErr?.message ?? 'unknown'}`);
        const sub = host.submitRun({ mode: 'batch' });
        evidence.steps['batch.submit'] = sub;
        if (!sub?.ok) throw new Error(`提交 batch run 失败：${sub?.error}`);

        const deadline = Date.now() + Number(process.env.AWF_ROUNDTRIP_RUN_TIMEOUT_MS || 300000);
        let snap = null;
        while (Date.now() < deadline) {
          await sleep(2000);
          snap = host.snapshot(sub.runId);
          if (snap?.run?.status && !['running', 'queued'].includes(snap.run.status)) break;
        }
        evidence.steps['batch.snapshot'] = snap?.run ?? snap;
        const st = JSON.parse(fs.readFileSync(path.join(tmpProject, '.awf', 'state.json'), 'utf8'));
        const t1 = (st.tasks || []).find((t) => t.id === 'T1');
        evidence.steps['batch.state.json(T1)'] = { status: t1?.status ?? null, exec: t1?.exec ?? null };
        const eventsPath = path.join(tmpProject, '.awf', 'logs', 'subagent-events.jsonl');
        evidence.steps['batch.subagent-events'] = fs.existsSync(eventsPath)
          ? fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).event)
          : [];
        if (t1?.status !== 'done') {
          fail('batch run 跑完后 T1 仍未 done（DSH 多 agent 派发/落账未通）', {
            run: snap?.run, t1, events: evidence.steps['batch.subagent-events'],
          });
          return;
        }
        console.log(`[roundtrip] ✓ batch 多 agent 跑通：run=${snap?.run?.status} T1=${t1.status}`
          + `（子 Agent 事件 ${JSON.stringify(evidence.steps['batch.subagent-events'])}）`);
      } finally {
        rt.reset();
      }
    }

    // ── ⑪（可选，**会派模型**）双项目隔离验收（V01/V03）：单后台、两个项目各一套会话与 MCP ──
    if (parseArgs(process.argv.slice(2)).twoProjects) {
      const { createProjectRuntime } = require(path.join(REPO, 'server', 'runtime', 'index.cjs'));
      const mk = (name, version, taskId) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), `awf-two-${name}-`));
        fs.mkdirSync(path.join(root, '.awf'), { recursive: true });
        fs.writeFileSync(path.join(root, '.awf', 'config.json'), JSON.stringify({
          runtime: { adapter: 'dsh' },
          run: { agents: { max: 1 }, decision: { enabled: false, mode: 'auto' } },
        }));
        fs.writeFileSync(path.join(root, '.awf', 'state.json'), JSON.stringify({
          mode: 'idle', version, currentState: 'IDLE', milestones: [], plan: { summary: `proj-${name}` },
          tasks: [{ id: taskId, title: `任务 ${name}`, kind: 'dev', prompt: 'p', status: 'pending', deps: [] }],
        }));
        return root;
      };
      const rootA = mk('A', '0.2.0', 'T-A');
      const rootB = mk('B', '9.9.9', 'T-B');
      const rtA = createProjectRuntime({ projectRoot: rootA, adapterDeps: { bridge: channelMod.channel() } });
      const rtB = createProjectRuntime({ projectRoot: rootB, adapterDeps: { bridge: channelMod.channel() } });
      try {
        await rtA.ctx.adapters.ports.session.start({ projectRoot: rootA });
        await rtB.ctx.adapters.ports.session.start({ projectRoot: rootB });
        console.log(`[roundtrip] 两个项目各建会话：A=${rtA.ctx.adapter} B=${rtB.ctx.adapter}`);

        const ask = '请调用 awf_read_state（不带参数）读取本项目 state 摘要，然后把 version 与任务 id 用 "<version>|<第一个任务id>" 一行回复，不要做别的。';
        await rtA.ctx.adapters.ports.host.sendPrompt(ask);
        await rtB.ctx.adapters.ports.host.sendPrompt(ask);

        // 等两边的**助手消息**都出来（会话态一开始就是 ready，不能拿它当「跑完了」）
        const deadline = Date.now() + 180000;
        let snapA = null; let snapB = null;
        for (;;) {
          const a = (await channelMod.channel().request('session.snapshot', { projectRoot: rootA }, { projectRoot: rootA, resultTimeoutMs: 20000 })).result;
          const b = (await channelMod.channel().request('session.snapshot', { projectRoot: rootB }, { projectRoot: rootB, resultTimeoutMs: 20000 })).result;
          snapA = a; snapB = b;
          if (a?.text && b?.text) break;                       // 两边都产出了文本
          if (Date.now() >= deadline) break;                   // 超时 → 下面按失败处理
          await sleep(2000);
        }
        evidence.steps['two-projects.snapshotA'] = { text: snapA?.text ?? null, sessionStateA: rtA.session.state };
        evidence.steps['two-projects.snapshotB'] = { text: snapB?.text ?? null, sessionStateB: rtB.session.state };

        const okA = String(snapA?.text ?? '').includes('0.2.0') && String(snapA?.text ?? '').includes('T-A');
        const okB = String(snapB?.text ?? '').includes('9.9.9') && String(snapB?.text ?? '').includes('T-B');
        const crossed = /9\.9\.9|T-B/.test(String(snapA?.text ?? '')) || /0\.2\.0|T-A/.test(String(snapB?.text ?? ''));
        if (!okA || !okB || crossed) {
          fail('双项目未隔离（A/B 的 MCP 读到了错误项目，或互相串）', { A: snapA?.text, B: snapB?.text });
          return;
        }
        console.log(`[roundtrip] ✓ 双项目隔离：A→${JSON.stringify(String(snapA.text).trim().slice(0, 40))} B→${JSON.stringify(String(snapB.text).trim().slice(0, 40))}`);

        // 事件不串：停 A 之后 B 的会话仍在、A 的事件不影响 B 的会话态
        await rtA.ctx.adapters.ports.session.kill();
        const factsB = await channelMod.channel().request('session.facts', { projectRoot: rootB }, { projectRoot: rootB, resultTimeoutMs: 20000 });
        evidence.steps['two-projects.factsBAfterKillA'] = factsB.result;
        if (factsB.result?.sessionExists !== true) { fail('停 A 影响了 B（共享后台应各自独立）', factsB.result); return; }
        console.log('[roundtrip] ✓ 停 A 不影响 B（单后台、多项目各自独立）');
      } finally {
        rtA.reset(); rtB.reset();
        fs.rmSync(rootA, { recursive: true, force: true });
        fs.rmSync(rootB, { recursive: true, force: true });
      }
    }

    // ── ⑫（可选，**会派模型**）子 Agent：真的派出来 + 停 run 时真的被打断（U11/C14）──
    if (parseArgs(process.argv.slice(2)).subagent) {
      fs.writeFileSync(path.join(tmpProject, '.awf', 'config.json'), JSON.stringify({ runtime: { adapter: 'dsh' } }));
      const { createProjectRuntime } = require(path.join(REPO, 'server', 'runtime', 'index.cjs'));
      const rt = createProjectRuntime({ projectRoot: tmpProject, adapterDeps: { bridge: channelMod.channel() } });
      try {
        const ports = rt.ctx.adapters.ports;
        await ports.session.start({ projectRoot: tmpProject });
        // 子 Agent 必须按 awf-worker 的输出协议回一行 RESULT —— AWF 就是靠**末条文本**落账的（T-P3-01）
        const ask = '请用 subagent 工具派生**一个后台子 Agent**，交给它的任务是：'
          + '「用 bash 运行 `sleep 5`，然后你的最后一行必须输出：'
          + 'RESULT: {\"taskId\":\"T2\",\"status\":\"done\",\"result\":\"subagent-settle-smoke\"}」，'
          + '不要让它调用任何 MCP 工具，也不要自己执行这条命令。派发完成后你只回复 DISPATCHED。';
        await ports.host.sendPrompt(ask);

        // 等子会话出现（按 parentSessionId 找）
        const spawnDeadline = Date.now() + 120000;
        let kids = [];
        while (Date.now() < spawnDeadline) {
          const r = await channelMod.channel().request('session.children', { projectRoot: tmpProject }, { projectRoot: tmpProject, resultTimeoutMs: 20000 });
          kids = r.result?.children ?? [];
          if (kids.length > 0) break;
          await sleep(2000);
        }
        evidence.steps['subagent.children(派发后)'] = kids;
        if (kids.length === 0) {
          const snap = await channelMod.channel().request('session.snapshot', { projectRoot: tmpProject }, { projectRoot: tmpProject, resultTimeoutMs: 20000 });
          fail('子 Agent 未在超时内出现（平台侧没派出来）', { 主会话最后回复: snap.result?.text ?? null });
          return;
        }
        console.log(`[roundtrip] ✓ 子 Agent 已派发：${kids.length} 个（${kids[0]}）`);

        // ── 结果归属：子 Agent 的 RESULT 必须真落进本项目 state.json（不是「收到事件」就算）──
        const settleDeadline = Date.now() + 180000;
        let t2 = null;
        while (Date.now() < settleDeadline) {
          const st = JSON.parse(fs.readFileSync(path.join(tmpProject, '.awf', 'state.json'), 'utf8'));
          t2 = (st.tasks || []).find((t) => t.id === 'T2') ?? null;
          if (t2?.status === 'done') break;
          await sleep(2000);
        }
        evidence.steps['subagent.T2'] = t2;
        if (t2?.status !== 'done' || t2?.exec?.result !== 'subagent-settle-smoke') {
          fail('子 Agent 的 RESULT 没落进 state.json（末条文本没回传，或落账链没接上）', t2);
          return;
        }
        console.log(`[roundtrip] ✓ 子 Agent 结果已落账：T2.status=${t2.status} result=${t2.exec.result}`);

        // 两个生命周期事件都要留档（派发生效确认与补发判定都读它）
        const eventsPath = path.join(tmpProject, '.awf', 'logs', 'subagent-events.jsonl');
        const kinds = fs.existsSync(eventsPath)
          ? fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).event)
          : [];
        evidence.steps['subagent.events'] = kinds;
        if (!kinds.includes('SubagentStart') || !kinds.includes('SubagentStop')) {
          fail('subagent-events.jsonl 缺生命周期留档（派发生效确认/补发都靠它）', kinds);
          return;
        }
        console.log(`[roundtrip] ✓ 生命周期已留档：${JSON.stringify(kinds)}`);

        // ── 停 run 的打断：需要**还活着**的子 Agent。上一个已经跑完退场了，
        //    所以再派一个长跑的（sleep 60），确认它真在活动列表里，再停 run ──
        const ask2 = '请再用 subagent 工具派生**一个后台子 Agent**，让它执行 bash 命令 `sleep 60` 然后回复 LONG-DONE。'
          + '你自己不要执行这条命令；派发完成后只回复 DISPATCHED2。';
        await ports.host.sendPrompt(ask2);
        const aliveDeadline = Date.now() + 120000;
        let alive = [];
        while (Date.now() < aliveDeadline) {
          const r = await channelMod.channel().request('session.children', { projectRoot: tmpProject }, { projectRoot: tmpProject, resultTimeoutMs: 20000 });
          alive = (r.result?.children ?? []).filter((id) => id !== kids[0]);
          if (alive.length > 0) break;
          await sleep(2000);
        }
        evidence.steps['subagent.children(长跑子 Agent)'] = alive;
        if (alive.length === 0) {
          fail('第二个子 Agent 未在超时内出现（停 run 的打断无法验证）');
          return;
        }
        console.log(`[roundtrip] ✓ 长跑子 Agent 在活动列表里：${alive[0]}`);

        // 停 run：应先取名单 → cancel 主会话 → 逐个打断子 Agent
        const stopped = await ports.session.kill();
        evidence.steps['subagent.session.kill'] = stopped;
        if (!(stopped?.subagents ?? []).includes(alive[0])) {
          fail('session.stop 未逐个打断子 Agent（U11：取消父会话不会自动停子）', stopped);
          return;
        }
        console.log(`[roundtrip] ✓ 停 run 时逐个打断子 Agent：${JSON.stringify(stopped.subagents)}`);

        await sleep(3000);
        const after = await channelMod.channel().request('session.children', { projectRoot: tmpProject }, { projectRoot: tmpProject, resultTimeoutMs: 20000 });
        evidence.steps['subagent.children(停止后)'] = after.result;
        if ((after.result?.count ?? 0) > 0) {
          console.log(`[roundtrip] ⚠ 停止后仍有 ${after.result.count} 个子会话（平台侧未立即移除，需人工复核）`);
        } else {
          console.log('[roundtrip] ✓ 停止后子会话已不在活动列表');
        }
      } finally {
        rt.reset();
      }
    }

    evidence.ok = true;
    evidence.finishedAt = stamp();
    console.log('\n[roundtrip] 证据：');
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
    try { await server.stop(); } catch { /* 已停 */ }
    fs.rmSync(tmpProject, { recursive: true, force: true });
    console.log('[roundtrip] 现场已清理（DSH 已停、AWF 已停、临时项目已删）');
  }
  return process.exitCode || 0;
}

main()
  .then((code) => { if (typeof code === 'number' && code !== 0) process.exit(code); })
  .catch((err) => { console.error(`[roundtrip] 异常：${err.stack}`); process.exit(1); });
