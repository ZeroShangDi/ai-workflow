#!/usr/bin/env node
/**
 * 全真 E2E 评测（eval）— 真实 claude + tmux + 插件，消耗真实 token。
 *
 * 与 tests/ 下确定性测试不同：本脚本不参与 `npm test`（vitest include 只匹配 *.test.js）。
 * 仅在需要时手动运行，例如：npm run test:eval -- --only hello-sum
 * 换 CLI 实现：`--awf <path>`（缺省本仓库 cli/awf.cjs，即新树）
 *
 * 流程（每个用例）：
 *   1. 前置检查（claude / tmux / node）
 *   2. 建沙箱 sandbox/eval/<id>-<ts>/
 *   3. awf init（真实：检查依赖 + 注入插件 + 建 .awf/ + CLAUDE.md）
 *   4. 播种 state.json（等于 plan 的产物，用例自备，避免交互式 plan）
 *   5. awf run（真实：spawn server + tmux + claude，逐任务执行）
 *   6. 评分：state.json 任务 done + exec.result 非空 + 产物文件存在 + 校验命令退出码 0
 *   7. 沙箱与日志默认全部保留（含通过用例的 eval.log），便于复盘/排查；--clean 可自动清理成功用例
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { sessionEnvOf } from '../harness/session-env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// CLI 入口：缺省用**新树** cli/awf.cjs（server/cli/tests 都已是新树，旧树 src/ 待退役）；
// `--awf <path>` 可钉住别的工作副本 —— 与 fullflow-regression 同一约定。
const AWF_ARG_IDX = process.argv.indexOf('--awf');
const AWF = AWF_ARG_IDX !== -1
  ? path.resolve(process.argv[AWF_ARG_IDX + 1])
  : path.join(ROOT, 'cli', 'awf.cjs');
// 会话名与 ctx 同源（不在这里另拼 cc-<sid> —— 那是 run-context 的单一知情范围）
const requireCjs = createRequire(import.meta.url);
const runContext = requireCjs('../../server/shared/run-context.cjs');

const CASES_DIR = path.join(ROOT, 'tests', 'e2e', 'cases');
const SANDBOX_ROOT = path.join(ROOT, 'sandbox', 'e2e');

const RUN_TIMEOUT_MS = Number(process.env.AWF_EVAL_TIMEOUT_MS || 15 * 60 * 1000);
const TASK_ICONS = new Set(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏', '✓', '⚠']);
const TASK_PROGRESS_LOG_MS = 60 * 1000;

// ── 参数解析 ──

const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const clean = args.includes('--clean'); // --clean: 成功用例自动清理沙箱（默认保留沙箱与日志）
const onlyIdx = args.indexOf('--only');
const only = onlyIdx !== -1 ? args[onlyIdx + 1] : null;
const multiAgent = args.includes('--multi-agent');

// ── 前置检查 ──

function hasBin(name) {
  try { execFileSync('command', ['-v', name], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function preflight() {
  const missing = [
    ['claude', 'npm install -g @anthropic-ai/claude-code（并已完成 claude 登录）'],
    ['tmux', 'brew install tmux'],
    ['node', '需 node 在 PATH 上'],
  ].filter(([name]) => !hasBin(name));

  if (missing.length > 0) {
    console.error('✘ 前置依赖缺失，无法运行全真 eval：');
    for (const [name, hint] of missing) console.error(`  - ${name} → ${hint}`);
    process.exit(1);
  }
}

// ── 用例加载 ──

function loadCases() {
  const raw = [];
  for (const entry of fs.readdirSync(CASES_DIR)) {
    const caseDir = path.join(CASES_DIR, entry);
    if (!fs.statSync(caseDir).isDirectory()) continue;
    const caseFiles = fs.readdirSync(caseDir)
      .filter((name) => /^case(?:-[a-z0-9-]+)?\.json$/i.test(name))
      .map((name) => path.join(caseDir, name));
    for (const caseFile of caseFiles) {
      try {
        raw.push({ dir: caseDir, caseFile, ...JSON.parse(fs.readFileSync(caseFile, 'utf-8')) });
      } catch (err) {
        console.error(`✘ 解析 ${caseFile} 失败: ${err.message}`);
        process.exit(1);
      }
    }
  }
  // extends：从另一个 case 继承（seed 顶层合并 / config·files·expected 全量覆盖），供对照用例复用任务集
  const byId = new Map(raw.map((c) => [c.id, c]));
  const resolveCase = (c) => {
    if (!c.extends) return c;
    const parent = byId.get(c.extends);
    if (!parent) { console.error(`✘ case '${c.id}' extends 未找到: ${c.extends}`); process.exit(1); }
    const rp = resolveCase(parent);
    const resolved = {
      ...rp,
      ...c,
      seed: { ...rp.seed, ...(c.seed || {}) },
      files: c.files ?? rp.files,
      config: c.config ?? rp.config,
      expected: c.expected ?? rp.expected,
    };
    if (c.promptOverrides) {
      resolved.seed.tasks = (resolved.seed.tasks || []).map((task) => ({
        ...task,
        prompt: c.promptOverrides[task.id] ?? task.prompt,
      }));
    }
    return resolved;
  };
  return raw.map(resolveCase);
}

function selectCases(all) {
  if (only) {
    const found = all.filter((c) => c.id === only);
    if (found.length === 0) {
      console.error(`✘ 未找到用例: ${only}`);
      console.error(`  可用: ${all.map((c) => c.id).join(', ')}`);
      process.exit(1);
    }
    return found;
  }
  return all;
}

// ── 子进程执行 ──

function runCmd(cmd, argsArr, { cwd, timeoutMs = RUN_TIMEOUT_MS, logStream, teeOutput = false, onOutput } = {}) {
  return new Promise((resolve) => {
    const env = teeOutput
      ? { ...process.env, AWF_TASK_LIST_INTERACTIVE: '1' }
      : process.env;
    const proc = spawn(cmd, argsArr, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env });
    const forward = (stream) => (chunk) => {
      logStream?.write(chunk);
      onOutput?.(chunk, stream === process.stderr ? 'stderr' : 'stdout');
      if (teeOutput || !logStream) stream.write(chunk);
    };
    proc.stdout.on('data', forward(process.stdout));
    proc.stderr.on('data', forward(process.stderr));
    let timedOut = false;
    const kill = setTimeout(() => {
      timedOut = true;
      // 先 SIGTERM：run.js 注册了 SIGTERM 清理（tmux/session server），再兜底 SIGKILL
      proc.kill('SIGTERM');
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000).unref();
    }, timeoutMs);
    proc.on('close', (code) => { clearTimeout(kill); resolve({ code: code ?? -1, timedOut }); });
    proc.on('error', (err) => { clearTimeout(kill); logStream?.write(`spawn error: ${err.message}\n`); resolve({ code: -1, timedOut: false }); });
  });
}

/** 从 TTY 重绘输出中仅提取状态变化，避免 eval.log 被 spinner 帧与控制码淹没。 */
function createTaskEventRecorder(logStream) {
  const states = new Map();
  let pending = '';
  return (chunk) => {
    pending += String(chunk)
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\r/g, '');
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const raw of lines) {
      const line = raw.trim();
      const match = line.match(/^(.?)\s+\[([^\]]+)\]\s+(.+?)\s+((?:(?:\d+h )?(?:\d+m )?)\d+s)$/);
      if (!match || !TASK_ICONS.has(match[1])) continue;
      const [, icon, id, title, elapsed] = match;
      const status = icon === '✓' ? 'done' : icon === '⚠' ? 'blocked' : 'active';
      const elapsedMs = durationToMs(elapsed);
      const previous = states.get(id);
      const statusChanged = previous?.status !== status;
      const progressDue = status === 'active' && elapsedMs - (previous?.elapsedMs ?? 0) >= TASK_PROGRESS_LOG_MS;
      if (previous && !statusChanged && !progressDue) continue;
      states.set(id, { status, elapsedMs });
      const stableIcon = status === 'done' ? '✓' : status === 'blocked' ? '⚠' : '●';
      const ts = new Date().toISOString().slice(11, 19);
      logStream.write(`[${ts}] ${stableIcon} [${id}] ${title} · ${elapsed}\n`);
    }
  };
}

function durationToMs(text) {
  const units = [...text.matchAll(/(\d+)(h|m|s)/g)];
  return units.reduce((total, [, value, unit]) => total + Number(value) * ({ h: 3600000, m: 60000, s: 1000 }[unit]), 0);
}

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

/** 递归拼一个目录下所有文本文件的内容（dirContain 用；读不了的当二进制跳过） */
function collectDirText(dir) {
  let out = '';
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out += collectDirText(full);
    else {
      try { out += `${fs.readFileSync(full, 'utf-8')}\n`; } catch { /* 二进制 → 跳过 */ }
    }
  }
  return out;
}

// ── 评分 ──

function readState(sandbox) {
  try { return JSON.parse(fs.readFileSync(path.join(sandbox, '.awf', 'state.json'), 'utf-8')); }
  catch { return null; }
}

// ── 用例钩子（可选）：与 run **并发**的交互 ────────────────────────────────────
// 声明式 case.json 只能描述「跑完看结果」。有些能力的关键动作发生在 run **进行中**
// （如人工批准一次动态规划 proposal、暂停编排、注入干预），故用例目录可放 `hooks.mjs`：
//   export async function duringRun(ctx)  —— 在 `awf run` 起来之后、跑完之前调用
//   export async function afterRun(ctx)   —— 在 run 结束、评分之前调用（断言顺序类证据）
// 两者都可返回 { checks: [{ok,msg}] }，并入该用例的评分。
function evalServerPort() {
  const req = createRequire(import.meta.url);
  return req(path.join(ROOT, 'server', 'shared', 'runtime-config.cjs')).getServerPort(process.env);
}

/** 打本项目 server（`?p=<sandbox>` 路由），端口与 `awf run` 同源 */
function awfJson(method, pathname, projectRoot, body) {
  const payload = body === undefined ? null : JSON.stringify(body);
  const sep = pathname.includes('?') ? '&' : '?';
  const url = projectRoot ? `${pathname}${sep}p=${encodeURIComponent(projectRoot)}` : pathname;
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: evalServerPort(),
      path: url,
      method,
      headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* 非 JSON 响应 */ }
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on('error', (e) => resolve({ status: 0, json: null, raw: '', error: e.message }));
    req.setTimeout(10000, () => req.destroy(new Error('请求超时')));
    req.end(payload ?? undefined);
  });
}

async function loadCaseHook(c) {
  const hookPath = path.join(CASES_DIR, c.id, 'hooks.mjs');
  if (!fs.existsSync(hookPath)) return null;
  const mod = await import(pathToFileURL(hookPath).href);
  return mod && typeof mod === 'object' ? mod : null;
}

async function runHookPhase(hook, phase, ctx, timeoutMs) {
  const fn = hook?.[phase];
  if (typeof fn !== 'function') return [];
  try {
    const r = await Promise.race([
      fn(ctx),
      new Promise((resolve) => setTimeout(() => resolve({ checks: [{ ok: false, msg: `钩子 ${phase} 超时（${Math.round(timeoutMs / 1000)}s）` }] }), timeoutMs)),
    ]);
    return Array.isArray(r?.checks) ? r.checks : [];
  } catch (e) {
    return [{ ok: false, msg: `钩子 ${phase} 抛错: ${e?.message ?? e}` }];
  }
}

function scoreCase(sandbox, expected, logPath, observed = {}) {
  const checks = [];
  const fail = (msg) => checks.push({ ok: false, msg });
  const pass = (msg) => checks.push({ ok: true, msg });

  const state = readState(sandbox);
  if (!state) { fail('state.json 缺失或无法解析'); return checks; }

  if (expected.tasksDone !== false) {
    const tasks = state.tasks || [];
    const notDone = tasks.filter((t) => t.status !== 'done');
    if (notDone.length > 0) fail(`存在未完成任务: ${notDone.map((t) => t.id).join(', ')}`);
    else pass(`全部 ${tasks.length} 个任务 status=done`);

    const noResult = tasks.filter((t) => t.status === 'done' && !t.exec?.result);
    if (noResult.length > 0) fail(`done 但缺 exec.result: ${noResult.map((t) => t.id).join(', ')}`);
    else pass('done 任务均有 exec.result');
  }

  for (const f of expected.files || []) {
    if (fs.existsSync(path.join(sandbox, f))) pass(`产物存在: ${f}`);
    else fail(`产物缺失: ${f}`);
  }

  // 多 agent 并行证据：
  //   logContain — eval.log 里必须出现的文本。**注意 eval.log 不是原始 stdout**：它只收
  //     `createTaskEventRecorder` 过滤后的**任务状态行**（`[ts] <icon> [<id>] <标题> · <耗时>`），
  //     原始输出走 console。所以这里的字符串只能是任务状态行里出现过的（如 `[T1]`、`[R1-F1]`）——
  //     写 CLI 的其它文案（如旧 `logStep` 的整句）永远匹配不上。
  //   markerSpanMs — 各任务 marker 文件的 mtime 最大跨度上限（证明子任务几乎同时落盘，即真并行）
  if (logPath) {
    let logText = null;
    const getLog = () => { if (logText === null) { try { logText = fs.readFileSync(logPath, 'utf-8'); } catch { logText = ''; } } return logText; };
    for (const pat of expected.logContain || []) {
      if (getLog().includes(pat)) pass(`日志含批次派发标记: ${pat}`);
      else fail(`日志缺失批次派发标记: ${pat}`);
    }
  }
  // fileContain — 指定沙箱文件必须包含的字符串（如 .awf/logs/subagent-events.jsonl 含 SubagentStop）
  for (const fc of expected.fileContain || []) {
    let text = '';
    try { text = fs.readFileSync(path.join(sandbox, fc.file), 'utf-8'); } catch { /* 文件缺失 */ }
    for (const needle of fc.contains || []) {
      if (text.includes(needle)) pass(`文件 ${fc.file} 含: ${needle}`);
      else fail(`文件 ${fc.file} 缺: ${needle}`);
    }
  }
  if (typeof expected.markerSpanMs === 'number') {
    const times = (expected.markerFiles || [])
      .map((f) => path.join(sandbox, f))
      .filter((p) => fs.existsSync(p))
      .map((p) => fs.statSync(p).mtimeMs);
    if (times.length === (expected.markerFiles || []).length) {
      const span = Math.max(...times) - Math.min(...times);
      if (span <= expected.markerSpanMs) pass(`并行证据: ${times.length} 个 marker 写入时间跨度 ${Math.round(span)}ms ≤ ${expected.markerSpanMs}ms`);
      else fail(`疑似未并行: marker 写入时间跨度 ${Math.round(span)}ms > ${expected.markerSpanMs}ms`);
    } else {
      fail(`marker 缺失: ${expected.markerFiles.filter((f) => !fs.existsSync(path.join(sandbox, f))).join(', ')}`);
    }
  }

  // ── 链路存活断言（讨论稿 §三.5：把 regression 的脚本断言扩成声明字段）──
  // 这些字段让「编排机械对不对」也能用声明式 case 表达，从而把命令式 case 迁进来。

  // modeIdle：run 收尾后 mode 复位（pause / resume 类 case 不设此字段 —— 它们的期望不是 idle）
  if (expected.modeIdle === true) {
    if (state.mode === 'idle') pass('mode 已复位 idle');
    else fail(`mode 未复位：${state.mode}`);
  }

  // tasksSettled：所有任务都已结算（done 或 blocked），不留 pending/active
  // （比 tasksDone 宽：门禁被 blocked 也算「结算了」，那是有意义的终态而非卡住）
  if (expected.tasksSettled === true) {
    const stuck = (state.tasks || []).filter((t) => t.status === 'pending' || t.status === 'active');
    if (stuck.length === 0) pass(`全部 ${(state.tasks || []).length} 个任务已结算（done/blocked）`);
    else fail(`存在未结算任务: ${stuck.map((t) => `${t.id}(${t.status})`).join(', ')}`);
  }

  // gateVerdict：至少一个门禁任务（review/test）产出 exec.verdict.level —— 门禁闭环的输入
  if (expected.gateVerdict === true) {
    const gates = (state.tasks || []).filter((t) => t.kind === 'review' || t.kind === 'test');
    const withVerdict = gates.filter((t) => !!t.exec?.verdict?.level);
    if (withVerdict.length > 0) pass(`门禁产出 verdict.level（${withVerdict.map((t) => `${t.id}:${t.exec.verdict.level}`).join(', ')}）`);
    else fail(`门禁任务未产出 verdict.level（门禁任务 ${gates.length} 个）`);
  }

  // taskStatus：逐任务断言最终状态（如收尾协商若干轮仍不落账 → blocked，而不是永远 active）
  for (const [id, want] of Object.entries(expected.taskStatus || {})) {
    const t = (state.tasks || []).find((x) => x.id === id);
    if (t?.status === want) pass(`任务 ${id} 最终状态 = ${want}`);
    else fail(`任务 ${id} 最终状态应为 ${want}，实际 ${t?.status ?? '(任务缺失)'}`);
  }

  // dirContain：指定目录**及其子目录**下任意文件须含的字符串
  // （文件名带运行期戳时用，如 .awf/logs/<version>-<ts>/main.log、.awf/decisions/runs/<stamp>.jsonl）
  for (const dc of expected.dirContain || []) {
    let text = '';
    try { text = collectDirText(path.join(sandbox, dc.dir)); } catch { /* 目录不存在 → 空 */ }
    for (const needle of dc.contains || []) {
      if (text.includes(needle)) pass(`目录 ${dc.dir} 下有文件含: ${needle}`);
      else fail(`目录 ${dc.dir} 下无文件含: ${needle}`);
    }
  }

  // logStampPerRun：per-run 日志目录 <version>-<ts> 落盘（比「logs/ 目录存在」强 —— 那几乎恒真）
  if (expected.logStampPerRun === true) {
    const logsDir = path.join(sandbox, '.awf', 'logs');
    const version = state.version || '';
    let hit = false;
    try {
      hit = fs.readdirSync(logsDir, { withFileTypes: true })
        .some((e) => e.isDirectory() && e.name.startsWith(`${version}-`));
    } catch { /* 目录不存在 → 不命中 */ }
    if (hit) pass(`per-run 日志目录落盘（.awf/logs/${version}-*）`);
    else fail(`per-run 日志目录缺失（.awf/logs/${version}-*）`);
  }

  // sessionEnvPointsAt：run 会话的 CC_PROJECT/CC_WORKDIR 指向本项目
  // （派生会话 env 若串了别项目，hook 网关会把事件投到别人的槽 —— 真机踩过）
  // 用**跑的过程中**采到的样本，不是事后读（run 收尾会关会话）
  if (expected.sessionEnvPointsAt === true) {
    const env = observed.sessionEnv || {};
    const real = fs.realpathSync(sandbox);
    if (env.CC_PROJECT === real && env.CC_WORKDIR === real) pass('run 会话 env 指向本项目（CC_PROJECT / CC_WORKDIR）');
    else fail(`run 会话 env 未指向本项目（跑的过程中采样）：${JSON.stringify(env)}`);
  }

  return checks;
}

/** 跑的过程中周期采 run 会话的 env（会话在 run 收尾被关，事后读不到），stop() 取最后一次非空样本 */
function startSessionEnvSampler(projectRoot, { intervalMs = 1000 } = {}) {
  let last = {};
  const timer = setInterval(() => {
    const env = sessionEnvOf(runContext.projectSessionName(projectRoot));
    if (env.CC_SESSION) last = env;
  }, intervalMs);
  return { stop: () => { clearInterval(timer); return last; } };
}

async function runVerify(sandbox, verify) {
  if (!verify) return null;
  const [cmd, ...rest] = verify;
  const { code } = await runCmd(cmd, rest, { cwd: sandbox, timeoutMs: 60 * 1000 });
  return code;
}

function collectExecutionMetrics({ sandbox, seed, executionStartedAt, executionEndedAt }) {
  const metrics = {
    executionDurationMs: executionEndedAt - executionStartedAt,
    taskPromptChars: (seed.tasks || []).reduce((n, task) => n + (task.prompt?.length || 0), 0),
    modelCalls: 0,
    tokens: { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 },
    stages: {},
  };
  const eventsFile = path.join(sandbox, '.awf', 'logs', 'subagent-events.jsonl');
  if (!fs.existsSync(eventsFile)) return metrics;

  const events = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const transcriptPaths = new Set();
  const starts = new Map();
  const taskRuns = [];
  for (const event of events) {
    const body = event.body || {};
    if (body.transcript_path) transcriptPaths.add(body.transcript_path);
    if (body.agent_transcript_path) transcriptPaths.add(body.agent_transcript_path);
    if (event.event === 'SubagentStart') starts.set(body.agent_id, Date.parse(event.ts));
    if (event.event === 'SubagentStop') {
      const match = body.last_assistant_message?.match(/RESULT:\s*(\{[^\n]*\})/);
      let taskId = null;
      try { taskId = JSON.parse(match?.[1]).taskId; } catch { /* malformed/missing RESULT is already scored elsewhere */ }
      const startedAt = starts.get(body.agent_id);
      const stoppedAt = Date.parse(event.ts);
      if (taskId && Number.isFinite(startedAt) && Number.isFinite(stoppedAt)) taskRuns.push({ taskId, startedAt, stoppedAt });
    }
  }

  const uniqueUsage = new Map();
  for (const transcript of transcriptPaths) {
    if (!fs.existsSync(transcript)) continue;
    for (const line of fs.readFileSync(transcript, 'utf8').split('\n')) {
      let item;
      try { item = JSON.parse(line); } catch { continue; }
      const usage = item.message?.usage;
      const messageId = item.message?.id;
      if (!usage || !messageId) continue;
      // Claude transcript 会按 content block 重复写同一个 message.id，且每行重复携带 usage。
      // 同一 transcript/message 只计一次；流式增量取各字段最大值，避免低估最终 output。
      const key = `${transcript}\0${messageId}`;
      const previous = uniqueUsage.get(key) || {};
      uniqueUsage.set(key, {
        input: Math.max(previous.input || 0, usage.input_tokens || 0),
        cacheCreation: Math.max(previous.cacheCreation || 0, usage.cache_creation_input_tokens || 0),
        cacheRead: Math.max(previous.cacheRead || 0, usage.cache_read_input_tokens || 0),
        output: Math.max(previous.output || 0, usage.output_tokens || 0),
      });
    }
  }
  metrics.modelCalls = uniqueUsage.size;
  for (const usage of uniqueUsage.values()) {
    metrics.tokens.input += usage.input;
    metrics.tokens.cacheCreation += usage.cacheCreation;
    metrics.tokens.cacheRead += usage.cacheRead;
    metrics.tokens.output += usage.output;
  }
  metrics.tokens.contextInput = metrics.tokens.input + metrics.tokens.cacheCreation + metrics.tokens.cacheRead;

  const stageOf = (id) => id.startsWith('T') ? 'dev' : id.startsWith('R') ? 'review' : id.startsWith('X') ? 'test' : 'doc';
  for (const stage of ['dev', 'review', 'test', 'doc']) {
    const rows = taskRuns.filter((row) => stageOf(row.taskId) === stage);
    if (!rows.length) continue;
    metrics.stages[stage] = {
      tasks: rows.length,
      wallMs: Math.max(...rows.map((row) => row.stoppedAt)) - Math.min(...rows.map((row) => row.startedAt)),
      averageTaskMs: Math.round(rows.reduce((n, row) => n + row.stoppedAt - row.startedAt, 0) / rows.length),
    };
  }
  return metrics;
}

// ── 单用例执行 ──

async function runCase(c) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const sandbox = path.join(SANDBOX_ROOT, `${c.id}-${ts}`);
  fs.mkdirSync(sandbox, { recursive: true });

  // 默认 ESM 沙箱（JS 用例需要），可被 case.files 覆盖
  writeFile(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'awf-eval-sandbox', type: 'module' }, null, 2));
  for (const [rel, content] of Object.entries(c.files || {})) {
    writeFile(path.join(sandbox, rel), content);
  }

  const logPath = path.join(sandbox, 'eval.log');
  const log = fs.createWriteStream(logPath);
  log.write(`=== AWF Eval Log ===\ncase: ${c.id}\nstarted: ${new Date().toISOString()}\n\n`);
  const initLog = fs.createWriteStream(path.join(sandbox, 'init.log'));

  // 1. init
  const initRes = await runCmd(process.execPath, [AWF, 'init'], { cwd: sandbox, logStream: initLog });
  if (initRes.timedOut || initRes.code !== 0) {
    initLog.end();
    log.end();
    const msg = initRes.timedOut ? 'awf init 超时' : `awf init 失败（exit ${initRes.code}）`;
    return { id: c.id, name: c.name, ok: false, checks: [{ ok: false, msg }], sandbox, logPath };
  }

  // 2. 播种 state.json + 可选多 agent 配置
  writeFile(path.join(sandbox, '.awf', 'state.json'), JSON.stringify(c.seed, null, 2));
  if (c.config) {
    // run.agents > 1 → awf run 走多 agent 批次循环（runBatchLoop）
    writeFile(path.join(sandbox, '.awf', 'config.json'), JSON.stringify(c.config, null, 2));
  }

  // 3. run（用例钩子必须与 run **并发**：先起 run，再在它跑着时执行 duringRun）
  console.log(`\n▸ awf run · ${c.id}（实时 CLI 输出）\n`);
  const recordTaskEvent = createTaskEventRecorder(log);
  const executionStartedAt = Date.now();
  const runArgs = [AWF, 'run'];
  if (multiAgent) runArgs.push('--multi-agent');
  const hook = await loadCaseHook(c);
  const hookCtx = {
    sandbox,
    logPath,
    readState: () => readState(sandbox),
    get: (pathname) => awfJson('GET', pathname, sandbox),
    post: (pathname, body) => awfJson('POST', pathname, sandbox, body),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  const runPromise = runCmd(process.execPath, runArgs, {
    cwd: sandbox,
    teeOutput: true,
    onOutput: recordTaskEvent,
  });
  // 「run 会话 env 指向本项目」必须在**跑的过程中**采样：run 一收尾，CLI 就把会话关掉了，
  // 事后读 tmux 只会拿到空（这正是该事实只能用 duringRun 钩子/采样表达的原因）。
  const envSampler = c.expected?.sessionEnvPointsAt ? startSessionEnvSampler(sandbox) : null;
  const duringChecks = hook ? await runHookPhase(hook, 'duringRun', hookCtx, 8 * 60 * 1000) : [];
  const runRes = await runPromise;
  const observed = { sessionEnv: envSampler ? envSampler.stop() : null };
  const executionEndedAt = Date.now();
  initLog.end();
  log.end();
  if (runRes.timedOut || runRes.code !== 0) {
    const msg = runRes.timedOut ? 'awf run 超时' : `awf run 失败（exit ${runRes.code}）`;
    return { id: c.id, name: c.name, ok: false, checks: [{ ok: false, msg }, ...duringChecks], sandbox, logPath };
  }

  // 4. 评分（声明式断言 + 钩子断言）
  const checks = scoreCase(sandbox, c.expected || {}, logPath, observed);
  checks.push(...duringChecks);
  checks.push(...(hook ? await runHookPhase(hook, 'afterRun', hookCtx, 60 * 1000) : []));
  const verifyCode = await runVerify(sandbox, c.expected?.verify);
  if (verifyCode !== null) {
    checks.push(verifyCode === 0
      ? { ok: true, msg: `校验命令通过: ${c.expected.verify.join(' ')}` }
      : { ok: false, msg: `校验命令失败（exit ${verifyCode}）: ${c.expected.verify.join(' ')}` });
  }

  const ok = checks.every((ch) => ch.ok);
  const metrics = collectExecutionMetrics({ sandbox, seed: c.seed, executionStartedAt, executionEndedAt });
  const result = { id: c.id, name: c.name, ok, checks, metrics, sandbox, logPath };
  writeFile(path.join(sandbox, 'eval-result.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

// ── 汇总 ──

function printResult(r) {
  const icon = r.ok ? '✔' : '✘';
  console.log(`\n${icon} ${r.id} — ${r.name}`);
  for (const ch of r.checks) {
    console.log(`    ${ch.ok ? '  ✔' : '  ✘'} ${ch.msg}`);
  }
  if (r.metrics) {
    console.log(`    执行耗时: ${(r.metrics.executionDurationMs / 1000).toFixed(1)}s`);
    console.log(`    task prompt: ${r.metrics.taskPromptChars} chars`);
    console.log(`    模型调用: ${r.metrics.modelCalls}`);
    console.log(`    token: input=${r.metrics.tokens.input}, cacheRead=${r.metrics.tokens.cacheRead}, output=${r.metrics.tokens.output}`);
  }
  console.log(`    沙箱: ${r.sandbox}`);
  console.log(`    日志: ${r.logPath}`);
}

// ── main ──

async function main() {
  const all = loadCases();
  if (listOnly) {
    for (const c of all) console.log(`- ${c.id}\t${c.name}`);
    return;
  }

  preflight();

  const cases = selectCases(all);
  if (cases.length === 0) {
    console.error('没有可运行的用例（tests/e2e/cases/ 为空）');
    process.exit(1);
  }

  console.log(`⚠  全真 eval 将消耗真实 token，运行 ${cases.length} 个用例，每用例超时 ${RUN_TIMEOUT_MS / 1000}s\n`);

  const results = [];
  for (const c of cases) {
    const r = await runCase(c);
    results.push(r);
    printResult(r);
    if (clean && r.ok && r.sandbox && fs.existsSync(r.sandbox)) {
      // 默认保留沙箱与完整运行日志（eval.log），通过也保留，便于复盘/排查
      fs.rmSync(r.sandbox, { recursive: true, force: true });
    }
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`通过 ${passed}/${results.length}`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error('✘ eval 异常:', err);
  process.exit(1);
});
