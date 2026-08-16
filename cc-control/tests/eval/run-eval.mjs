#!/usr/bin/env node
/**
 * 全真 E2E 评测（eval）— 真实 claude + tmux + 插件，消耗真实 token。
 *
 * 与 tests/ 下确定性测试不同：本脚本不参与 `npm test`（vitest include 只匹配 *.test.js）。
 * 仅在需要时手动运行，例如：npm run eval -- --only hello-sum
 *
 * 流程（每个用例）：
 *   1. 前置检查（claude / tmux / node）
 *   2. 建沙箱 sandbox/eval/<id>-<ts>/
 *   3. awf init（真实：检查依赖 + 注入插件 + 建 .awf/ + CLAUDE.md）
 *   4. 播种 state.json（等于 plan 的产物，用例自备，避免交互式 plan）
 *   5. awf run（真实：spawn server + tmux + claude，逐任务执行）
 *   6. 评分：state.json 任务 done + exec.result 非空 + 产物文件存在 + 校验命令退出码 0
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const AWF = path.join(ROOT, 'src', 'awf.js');
const CASES_DIR = path.join(ROOT, 'tests', 'eval', 'cases');
const SANDBOX_ROOT = path.join(ROOT, 'sandbox', 'eval');

const RUN_TIMEOUT_MS = Number(process.env.AWF_EVAL_TIMEOUT_MS || 15 * 60 * 1000);

// ── 参数解析 ──

const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const keep = args.includes('--keep');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx !== -1 ? args[onlyIdx + 1] : null;

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
  const cases = [];
  for (const entry of fs.readdirSync(CASES_DIR)) {
    const caseDir = path.join(CASES_DIR, entry);
    const caseFile = path.join(caseDir, 'case.json');
    if (!fs.existsSync(caseFile)) continue;
    try {
      cases.push({ dir: caseDir, ...JSON.parse(fs.readFileSync(caseFile, 'utf-8')) });
    } catch (err) {
      console.error(`✘ 解析 ${caseFile} 失败: ${err.message}`);
      process.exit(1);
    }
  }
  return cases;
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

function runCmd(cmd, argsArr, { cwd, timeoutMs = RUN_TIMEOUT_MS, logStream } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, argsArr, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    if (logStream) {
      proc.stdout.on('data', (c) => logStream.write(c));
      proc.stderr.on('data', (c) => logStream.write(c));
    } else {
      proc.stdout.on('data', (c) => process.stdout.write(c));
      proc.stderr.on('data', (c) => process.stderr.write(c));
    }
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

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// ── 评分 ──

function readState(sandbox) {
  try { return JSON.parse(fs.readFileSync(path.join(sandbox, '.awf', 'state.json'), 'utf-8')); }
  catch { return null; }
}

function scoreCase(sandbox, expected) {
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

  return checks;
}

async function runVerify(sandbox, verify) {
  if (!verify) return null;
  const [cmd, ...rest] = verify;
  const { code } = await runCmd(cmd, rest, { cwd: sandbox, timeoutMs: 60 * 1000 });
  return code;
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

  // 1. init
  const initRes = await runCmd(process.execPath, [AWF, 'init'], { cwd: sandbox, logStream: log });
  if (initRes.timedOut || initRes.code !== 0) {
    log.end();
    const msg = initRes.timedOut ? 'awf init 超时' : `awf init 失败（exit ${initRes.code}）`;
    return { id: c.id, name: c.name, ok: false, checks: [{ ok: false, msg }], sandbox, logPath };
  }

  // 2. 播种 state.json
  writeFile(path.join(sandbox, '.awf', 'state.json'), JSON.stringify(c.seed, null, 2));

  // 3. run
  const runRes = await runCmd(process.execPath, [AWF, 'run'], { cwd: sandbox, logStream: log });
  log.end();
  if (runRes.timedOut || runRes.code !== 0) {
    const msg = runRes.timedOut ? 'awf run 超时' : `awf run 失败（exit ${runRes.code}）`;
    return { id: c.id, name: c.name, ok: false, checks: [{ ok: false, msg }], sandbox, logPath };
  }

  // 4. 评分
  const checks = scoreCase(sandbox, c.expected || {});
  const verifyCode = await runVerify(sandbox, c.expected?.verify);
  if (verifyCode !== null) {
    checks.push(verifyCode === 0
      ? { ok: true, msg: `校验命令通过: ${c.expected.verify.join(' ')}` }
      : { ok: false, msg: `校验命令失败（exit ${verifyCode}）: ${c.expected.verify.join(' ')}` });
  }

  const ok = checks.every((ch) => ch.ok);
  return { id: c.id, name: c.name, ok, checks, sandbox, logPath };
}

// ── 汇总 ──

function printResult(r) {
  const icon = r.ok ? '✔' : '✘';
  console.log(`\n${icon} ${r.id} — ${r.name}`);
  for (const ch of r.checks) {
    console.log(`    ${ch.ok ? '  ✔' : '  ✘'} ${ch.msg}`);
  }
  if (!r.ok) console.log(`    日志: ${r.logPath}`);
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
    console.error('没有可运行的用例（tests/eval/cases/ 为空）');
    process.exit(1);
  }

  console.log(`⚠  全真 eval 将消耗真实 token，运行 ${cases.length} 个用例，每用例超时 ${RUN_TIMEOUT_MS / 1000}s\n`);

  const results = [];
  for (const c of cases) {
    const r = await runCase(c);
    results.push(r);
    printResult(r);
    if (!keep && r.sandbox && fs.existsSync(r.sandbox)) {
      // 保留日志目录供失败排查；成功用例默认清理沙箱
      if (r.ok) fs.rmSync(r.sandbox, { recursive: true, force: true });
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
