#!/usr/bin/env node
'use strict';
/**
 * cli-install.cjs — 验「`awf plugin install` 在 DSH 项目上真的把插件装进 profile」（P2-6c）
 *
 * 真东西：真 `cli/awf.cjs` 子进程 + 真 `dsh --dump-config`（DSH 自己承认这行 patch 才算数）。
 * 只在**隔离 DSH_HOME** 上写（本文件的 DSH_HOME 由调用方给；缺省用探针 home）。
 *
 * 用法：
 *   bash scripts/probe/dsh/guard.sh snapshot
 *   node scripts/probe/dsh/cli-install.cjs          # 装 → dump-config 应含 awf-dsh-plugin → 卸 → dump 应不含
 *   node scripts/probe/dsh/cli-install.cjs --init   # V01：干净项目 `awf init` → 重复 init → --force（幂等/不覆盖）
 *   node scripts/probe/dsh/cli-install.cjs --pack   # V11：真 `npm pack` → 解包到新目录 → 用**包里的** CLI 装配 profile
 *   bash scripts/probe/dsh/guard.sh check           # 必须 IDENTICAL
 *
 * 退出码：0 = CLI 装配路径真实可用；1 = 失败（打印现场）。
 */

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const DSH_HOME = process.env.AWF_DSH_PROBE_HOME || '/tmp/awf-dsh-probe';
const PROFILE = process.env.AWF_PROBE_CLI_PROFILE || 'awf-cli';
const MODE = process.argv.includes('--init') ? 'init' : (process.argv.includes('--pack') ? 'pack' : 'plugin');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { code: r.status, out: `${r.stdout || ''}`, err: `${r.stderr || ''}` };
}

function fail(msg, extra) {
  console.error(`[cli-install] ✗ ${msg}`);
  if (extra !== undefined) console.error(typeof extra === 'string' ? extra : JSON.stringify(extra, null, 2));
  process.exitCode = 1;
}

/**
 * V11：发布包在**新目录**里能不能装（P4-02）。
 *
 * 为什么必须用真包：`files` 字段漏一个目录，开发机上一切正常（直接跑仓库里的 CLI），
 * 装出来的包却缺文件 —— `awf plugin install` 会报「插件源码不存在」，而使用者无从判断是
 * 自己装错了还是包坏了。这里用真 `npm pack` + 解包 + 用**包里的** CLI 装配 profile 来证伪。
 */
function runPackFlow(project, profileDir, env, evidence) {
  const awf = path.join(REPO, 'cli', 'awf.cjs');
  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-pack-'));
  try {
    // ① 真打包（离线；失败即环境问题，直接报）
    const packed = run('npm', ['pack', '--pack-destination', packDir], { cwd: REPO, env });
    evidence.steps['npm pack'] = { code: packed.code, out: packed.out.trim().split('\n').slice(-1)[0] };
    if (packed.code !== 0) { fail('npm pack 失败', evidence.steps['npm pack']); return false; }
    const tarball = packed.out.trim().split('\n').filter((l) => l.endsWith('.tgz')).pop();
    const tgz = path.join(packDir, tarball);
    if (!fs.existsSync(tgz)) { fail(`找不到打包产物：${tgz}`); return false; }

    // ② 解包到**新目录**（模拟使用者机器）
    const extractRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-unpack-'));
    const untar = run('tar', ['-xzf', tgz, '-C', extractRoot], {});
    if (untar.code !== 0) { fail('解包失败', untar.err); return false; }
    const pkgRoot = path.join(extractRoot, 'package');
    // 离线模拟 `npm i`：真使用者装包时 npm 会把 dependencies 放进 node_modules，
    // 而 `npm pack` 只产包体。不链接的话这里量到的是「没装依赖」，不是「包缺件」。
    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(pkgRoot, 'node_modules'), 'dir');

    // ③ 包里有 DSH 插件半侧（`files` 漏 dsh-plugin/ 就死在这一步）
    const mustHave = ['cli/awf.cjs', 'server/adapters/dsh/install.cjs', 'server/adapters/dsh/plugin/index.js', 'server/adapters/dsh/plugin/lib/ops.js'];
    const missing = mustHave.filter((rel) => !fs.existsSync(path.join(pkgRoot, rel)));
    evidence.steps['包内容'] = { checked: mustHave, missing };
    if (missing.length) { fail(`发布包缺件：${missing.join(', ')}（package.json 的 files 没带上）`, evidence.steps['包内容']); return false; }
    console.log(`[cli-install] ✓ 发布包含 DSH 插件半侧（${mustHave.length} 项抽查齐备）`);

    // ④ 包里的 CLI 在新目录里装配隔离 profile（不依赖开发机绝对路径）
    const packedCli = path.join(pkgRoot, 'cli', 'awf.cjs');
    fs.writeFileSync(path.join(project, '.awf', 'config.json'), JSON.stringify({ runtime: { adapter: 'dsh' } }));
    const install = run(process.execPath, [packedCli, 'plugin', 'install'], { cwd: project, env: { ...env, AWF_DSH_PROFILE: PROFILE } });
    evidence.steps['包内 CLI plugin install'] = { code: install.code, out: install.out.trim(), err: install.err.trim() };
    if (install.code !== 0 || !/已装配|已是装配态/.test(install.out)) {
      fail('包里的 CLI 没能装配 DSH profile（绝对路径依赖 / 缺件）', evidence.steps['包内 CLI plugin install']);
      return false;
    }
    const patchPath = path.join(profileDir, 'cordis.patch.yml');
    const copied = path.join(profileDir, 'node_modules', 'awf-dsh-plugin', 'lib', 'ops.js');
    if (!fs.existsSync(copied)) { fail('插件包没被拷进 profile', { copied }); return false; }
    // 装配产物必须落在隔离 DSH_HOME 里（不许写回开发机路径）
    if (!path.resolve(copied).startsWith(path.resolve(DSH_HOME))) { fail('装配写到了 DSH_HOME 之外', { copied }); return false; }
    console.log(`[cli-install] ✓ 包内 CLI 在新目录装配成功，插件落在隔离 home：${path.relative(DSH_HOME, copied)}`);

    // ⑤ 包里的源码不含开发机绝对路径
    const scan = ['server/adapters/dsh/plugin/index.js', 'server/adapters/dsh/plugin/lib/ops.js', 'server/adapters/dsh/install.cjs'];
    const dirty = scan.filter((rel) => fs.readFileSync(path.join(pkgRoot, rel), 'utf8').includes(REPO));
    evidence.steps['开发机绝对路径'] = { scanned: scan, dirty };
    if (dirty.length) { fail(`发布包里含开发机绝对路径：${dirty.join(', ')}`, evidence.steps['开发机绝对路径']); return false; }
    console.log('[cli-install] ✓ 包内源码不含开发机绝对路径');

    // ⑥ 卸载干净（用包里的 CLI）
    const uninstall = run(process.execPath, [packedCli, 'plugin', 'uninstall'], { cwd: project, env: { ...env, AWF_DSH_PROFILE: PROFILE } });
    if (uninstall.code !== 0 || fs.readFileSync(patchPath, 'utf8').includes('# >>> awf-dsh')) {
      fail('包里的 CLI 卸载不干净', { code: uninstall.code, out: uninstall.out.trim() });
      return false;
    }
    console.log('[cli-install] ✓ 包内 CLI 卸载干净（patch 复原）');
    fs.rmSync(extractRoot, { recursive: true, force: true });
    console.log(`[cli-install] 打包产物：${tgz}`);
    return true;
  } finally {
    fs.rmSync(packDir, { recursive: true, force: true });
  }
}

/**
 * V01 前半：「干净项目 `awf init`」+ 重复 init 幂等 + `--force` 补全不覆盖。
 * 与插件路径共用同一套隔离 profile；`awf init` 内部就含「装配 profile」，所以这里不再单独断言 dump-config
 * （那条由插件模式覆盖），只断言 **工作区骨架 + 幂等 + 备份不被覆盖**。
 */
function runInitFlow(project, profileDir, env, evidence) {
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  const awf = path.join(REPO, 'cli', 'awf.cjs');
  const awfDir = path.join(project, '.awf');
  const countMark = (text) => text.split('# >>> awf-dsh (managed by ai-workflow; do not edit) >>>').length - 1;
  const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12) : null);

  // ── ① 干净项目 init ──
  const first = run(process.execPath, [awf, 'init'], { cwd: project, env });
  evidence.steps['awf init(首次)'] = { code: first.code, out: first.out.trim(), err: first.err.trim() };
  if (first.code !== 0) { fail('`awf init` 在 DSH 项目上失败', evidence.steps['awf init(首次)']); return false; }
  if (!first.out.includes('✓ dsh')) { fail('DSH 项目的前置检查没有报 dsh（清单没按平台走）', first.out); return false; }
  if (!/已创建 \.awf\//.test(first.out)) { fail('首次 init 没创建 .awf/ 骨架', first.out); return false; }
  console.log('[cli-install] ✓ `awf init` 在 DSH 项目上跑通（前置检查 ✓ dsh / ✓ node + 建骨架）');

  const skeleton = ['.awf/state.json', '.awf/README.md', '.awf/config.json', '.awf/reports', '.awf/context/architecture.md'];
  const missing = skeleton.filter((p) => !fs.existsSync(path.join(project, p)));
  evidence.steps.skeleton = { checked: skeleton, missing };
  if (missing.length) { fail(`工作区骨架缺件：${missing.join(', ')}`, evidence.steps.skeleton); return false; }
  const seededCfg = JSON.parse(fs.readFileSync(path.join(awfDir, 'config.json'), 'utf8'));
  evidence.steps['播种 config.json'] = seededCfg;
  if (seededCfg.runtime?.adapter !== 'dsh') {
    fail(`init 没把解析到的平台记进 .awf/config.json（实得 adapter=${seededCfg.runtime?.adapter}）—— 之后不带 CC_ADAPTER 的命令会解析回 cc`, seededCfg);
    return false;
  }
  if (!first.out.includes('已记入 .awf/config.json')) { fail('init 没有回显「已记入 .awf/config.json」', first.out); return false; }
  console.log(`[cli-install] ✓ 骨架齐（${skeleton.length} 项）+ 平台已记入 .awf/config.json（adapter=dsh）`);

  const patch1 = fs.readFileSync(patchPath, 'utf8');
  if (countMark(patch1) !== 1) { fail(`init 后 awf-dsh 标记块出现 ${countMark(patch1)} 次（应为 1）`); return false; }
  const backup1 = sha(`${patchPath}.awf-backup`);
  evidence.steps['首次：标记块/备份'] = { marks: countMark(patch1), backup: backup1 };

  // ── ② 用户改动 + 重复 init：必须幂等 ──
  fs.writeFileSync(path.join(awfDir, 'README.md'), '# 用户改过的 README\n');
  fs.writeFileSync(path.join(awfDir, 'state.json'), JSON.stringify({ mode: 'idle', userTouched: true }));
  const state1 = sha(path.join(awfDir, 'state.json')); // 基准取在「用户改动之后」
  evidence.steps['用户改动后 state'] = state1;
  const second = run(process.execPath, [awf, 'init'], { cwd: project, env });
  evidence.steps['awf init(重复)'] = { code: second.code, out: second.out.trim() };
  if (second.code !== 0) { fail('重复 `awf init` 失败', evidence.steps['awf init(重复)']); return false; }
  if (!/\.awf\/ 已存在/.test(second.out)) { fail('重复 init 没有报「已存在」（幂等判据失效）', second.out); return false; }
  const patch2 = fs.readFileSync(patchPath, 'utf8');
  if (countMark(patch2) !== 1) { fail(`重复 init 后标记块变成 ${countMark(patch2)} 次（装配不幂等）`); return false; }
  if (sha(`${patchPath}.awf-backup`) !== backup1) { fail('重复 init 覆盖了 awf-backup（备份只该备一次）'); return false; }
  if (sha(path.join(awfDir, 'state.json')) !== state1) { fail('重复 init 覆盖了 state.json（幂等失效，用户状态被冲）'); return false; }
  if (!fs.readFileSync(path.join(awfDir, 'README.md'), 'utf8').includes('用户改过的')) { fail('重复 init 覆盖了用户 README'); return false; }
  // 去掉 CC_ADAPTER 也不能变回 cc（这才是「记进去了」的硬证据）
  const envNoAdapter = { ...env };
  delete envNoAdapter.CC_ADAPTER; // 空串不是「没给」——平台名会变成 ''
  const noEnv = run(process.execPath, [awf, 'init'], { cwd: project, env: envNoAdapter });
  evidence.steps['awf init(无 CC_ADAPTER)'] = { code: noEnv.code, out: noEnv.out.trim() };
  const stillDsh = JSON.parse(fs.readFileSync(path.join(awfDir, 'config.json'), 'utf8')).runtime?.adapter;
  if (noEnv.code !== 0 || stillDsh !== 'dsh') {
    fail(`不带 CC_ADAPTER 时项目解析不再是 dsh（实得 ${stillDsh}）`, evidence.steps['awf init(无 CC_ADAPTER)']);
    return false;
  }
  if (!noEnv.out.includes('已记录该平台')) { fail('无 env 的 init 没有报「已记录该平台」（幂等回执缺失）', noEnv.out); return false; }
  console.log('[cli-install] ✓ 重复 init 幂等（含不带 CC_ADAPTER 时仍是 dsh）：标记块仍 1 处、备份未覆盖、state.json 与用户 README 未被冲');

  // ── ③ --force：只补缺失，不动已有 ──
  fs.rmSync(path.join(awfDir, 'reports', 'lint'), { recursive: true, force: true });
  const forced = run(process.execPath, [awf, 'init', '--force'], { cwd: project, env });
  evidence.steps['awf init(--force)'] = { code: forced.code, out: forced.out.trim() };
  if (forced.code !== 0) { fail('`awf init --force` 失败', evidence.steps['awf init(--force)']); return false; }
  if (!fs.existsSync(path.join(awfDir, 'reports', 'lint'))) { fail('--force 没有补回缺失目录'); return false; }
  if (sha(path.join(awfDir, 'state.json')) !== state1) { fail('--force 覆盖了 state.json'); return false; }
  if (countMark(fs.readFileSync(patchPath, 'utf8')) !== 1) { fail('--force 后标记块数量不对'); return false; }
  console.log('[cli-install] ✓ `awf init --force` 只补缺失目录，state.json 与装配块不受影响');

  // ── ④ 收尾：卸载装配，patch 复原 ──
  const uninstall = run(process.execPath, [awf, 'plugin', 'uninstall'], { cwd: project, env });
  evidence.steps['awf plugin uninstall'] = { code: uninstall.code, out: uninstall.out.trim() };
  if (uninstall.code !== 0 || fs.readFileSync(patchPath, 'utf8').includes('# >>> awf-dsh')) {
    fail('init 之后卸载不干净', evidence.steps['awf plugin uninstall']); return false;
  }
  if (!fs.readFileSync(patchPath, 'utf8').includes('# 用户自己的注释')) { fail('卸载把用户注释一起删了'); return false; }
  console.log('[cli-install] ✓ 卸载后 patch 复原（用户注释仍在）');
  return true;
}

function main() {
  if (DSH_HOME === path.join(os.homedir(), '.dsh')) {
    console.error('[cli-install] 拒绝：DSH_HOME 指向真实 home。用隔离目录。');
    return 2;
  }

  // ── 造一个「DSH 项目」+ 一个干净 profile（只声明 bundles，patch 空）──
  // init 模式要的是**真干净**项目（连 .awf/ 都没有）：平台只能靠 CC_ADAPTER=dsh 声明，
  // 顺带验证 init 会把解析到的平台**记进** .awf/config.json（否则项目会解析回 cc）。
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-cli-install-'));
  if (MODE !== 'init') {
    fs.mkdirSync(path.join(project, '.awf'), { recursive: true });
    fs.writeFileSync(path.join(project, '.awf', 'config.json'), JSON.stringify({ runtime: { adapter: 'dsh' } }));
  }

  const profileDir = path.join(DSH_HOME, 'profiles', PROFILE);
  fs.rmSync(profileDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: `dsh-profile-${PROFILE}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }));
  fs.writeFileSync(path.join(profileDir, 'cordis.yml'), '[]\n');
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '# 用户自己的注释\n[]\n');

  const env = {
    ...process.env, DSH_HOME, AWF_DSH_PROFILE: PROFILE, AWF_DSH_BASE: 'http://127.0.0.1:0',
    ...(MODE === 'init' ? { CC_ADAPTER: 'dsh' } : {}),
  };
  const evidence = { dshHome: DSH_HOME, profile: PROFILE, mode: MODE, steps: {} };
  try {
    if (MODE === 'pack') {
      if (!runPackFlow(project, profileDir, env, evidence)) return;
      evidence.ok = true;
      console.log('\n[cli-install] 证据：');
      console.log(JSON.stringify(evidence, null, 2));
      return;
    }
    if (MODE === 'init') {
      if (!runInitFlow(project, profileDir, env, evidence)) return;
      evidence.ok = true;
      console.log('\n[cli-install] 证据：');
      console.log(JSON.stringify(evidence, null, 2));
      return;
    }
    // ── ① CLI 装 ──
    const install = run(process.execPath, [path.join(REPO, 'cli', 'awf.cjs'), 'plugin', 'install'], { cwd: project, env });
    evidence.steps.install = { code: install.code, out: install.out.trim(), err: install.err.trim() };
    if (install.code !== 0 || !/已装配|已是装配态/.test(install.out)) {
      fail('`awf plugin install` 在 DSH 项目上未走装配路径', evidence.steps.install);
      return;
    }
    console.log(`[cli-install] ✓ CLI 已装配：${install.out.trim().split('\n')[0]}`);

    // ── ② DSH 自己承认（dump-config 里能看到我们的行）──
    const dump = run('dsh', ['--profile', PROFILE, '--dump-config'], { env });
    evidence.steps['dsh --dump-config(装后)'] = { code: dump.code, hasPlugin: dump.out.includes('awf-dsh-plugin') };
    if (dump.code !== 0 || !dump.out.includes('awf-dsh-plugin')) {
      fail('dsh --dump-config 未看到 awf-dsh-plugin（patch 没被 DSH 接受）', { code: dump.code, tail: dump.out.slice(-500), err: dump.err.slice(-500) });
      return;
    }
    console.log('[cli-install] ✓ dsh --dump-config 含 awf-dsh-plugin');
    if (!dump.out.includes('awf-dsh')) fail('dump-config 里没有 awf-dsh 行 id');

    // 装配块里两个配置项都必须对（F42）：
    //   - awfBase：插件连常驻 AWF server 的唯一来源；缺了插件只告警、什么都不驱动
    //   - webPort：**DSH 网页**端口（会话观看地址），不是 AWF 端口
    const patchText = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
    if (!/awfBase: 'http:\/\/127\.0\.0\.1:\d+'/.test(patchText)) {
      fail('装配块没写 awfBase —— 插件将不启动指令通道（真实安装路径等于没配）', patchText);
      return;
    }
    if (!patchText.includes('webPort: 3080')) {
      fail('webPort 不是 DSH 网页端口（缺省 3080）—— 会话观看地址会指向错的服务', patchText);
      return;
    }
    // 自包含：MCP server 随插件目录携带（旧的 awfRepo 指向 cc 插件树的写法已删除）。
    // 装机后从**拷贝出来的副本**里找入口 —— 这才是插件运行时真正会用的路径。
    const pluginDir = path.join(profileDir, 'node_modules', 'awf-dsh-plugin');
    if (!fs.existsSync(path.join(pluginDir, 'mcp', 'awf-state', 'server.cjs'))) {
      fail('插件副本里没有 mcp/awf-state/server.cjs —— session.create 挂不上 MCP（规划/执行入口全断）', patchText);
      return;
    }
    if (fs.existsSync(path.join(pluginDir, '.git'))) {
      fail('插件副本里带着 .git —— 拷贝过滤有问题', patchText);
      return;
    }
    if (/awfRepo:/.test(patchText)) {
      fail('装配块仍写着 awfRepo —— 该配置项已删除（MCP 入口随包携带）', patchText);
      return;
    }
    console.log('[cli-install] ✓ 装配块含 awfBase（AWF server）与 webPort=3080（DSH 网页端口），且插件副本自包含（含 mcp/ 与 skills/）');
    console.log('  提示：DSH 不在 3080 时用 AWF_DSH_WEB_PORT 声明后重新装配');

    // 用户的注释应当还在
    const patched = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
    evidence.steps.patchText = patched;
    if (!patched.includes('# 用户自己的注释')) { fail('用户原有注释被覆盖了'); return; }

    // ── ③ CLI 卸 ──
    const uninstall = run(process.execPath, [path.join(REPO, 'cli', 'awf.cjs'), 'plugin', 'uninstall'], { cwd: project, env });
    evidence.steps.uninstall = { code: uninstall.code, out: uninstall.out.trim() };
    if (uninstall.code !== 0) { fail('`awf plugin uninstall` 失败', evidence.steps.uninstall); return; }

    const dump2 = run('dsh', ['--profile', PROFILE, '--dump-config'], { env });
    evidence.steps['dsh --dump-config(卸后)'] = { code: dump2.code, hasPlugin: dump2.out.includes('awf-dsh-plugin') };
    if (dump2.out.includes('awf-dsh-plugin')) { fail('卸载后 dump-config 仍含 awf-dsh-plugin'); return; }
    const after = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
    if (!after.includes('# 用户自己的注释')) { fail('卸载把用户注释一起删了'); return; }
    console.log('[cli-install] ✓ 卸载后 dump-config 不再含该插件，用户注释仍在');

    evidence.ok = true;
    console.log('\n[cli-install] 证据：');
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
    console.log('[cli-install] 现场已清理（临时 profile 与项目已删）');
  }
  return process.exitCode || 0;
}

main();
