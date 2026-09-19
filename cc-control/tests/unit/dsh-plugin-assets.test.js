import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter, listCommands, listSkills, listAgents, mapToolNames, listMcpServers, toolNameFor, pluginRoot } from '../../server/adapters/dsh/plugin/lib/assets.js';
import { composeInjection, registerCommands } from '../../server/adapters/dsh/plugin/lib/commands.js';
import { registerSkills, toRegistration } from '../../server/adapters/dsh/plugin/lib/skills.js';
import { mountSubagentTools, resolveToolFilter } from '../../server/adapters/dsh/plugin/lib/agents.js';
import { resolveServers } from '../../server/adapters/dsh/plugin/lib/mcp.js';
import { readManifest, installHooks } from '../../server/adapters/dsh/plugin/hooks/index.js';

/**
 * DSH 插件的**资产层**：命令 / 技能 / 代理 / MCP 清单 / hooks 声明。
 *
 * 这一层是把「cc 的 md 形态」翻成「DSH 的运行时注册」的地方，也是最容易悄悄错的地方
 * （少一个技能、白名单核不上、frontmatter 没解析出来都不会报错，只会静默少东西）。
 * 所以这里的断言以**数量 + 形状**为主：36 个技能、16 条命令、3 个命名代理，一个都不能少。
 */

describe('资产层：文本只在资产里，代码只做注册', () => {
  /** 去掉注释后的注册代码（注释里引用 cc 口径是为了说明差异，不算「把正文写进代码」） */
  function registrationCode() {
    const files = ['index.js', 'lib/assets.js', 'lib/commands.js', 'lib/skills.js', 'lib/agents.js', 'lib/mcp.js', 'hooks/index.js'];
    return files
      .map((f) => fs.readFileSync(path.join(pluginRoot(), f), 'utf8'))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  }

  /** 从 md 正文里挑「指纹行」：够长、带中文、不是结构符号行 */
  function fingerprints(body, take = 3) {
    return body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length >= 15 && /[一-龥]/.test(l) && !/^[#\-|>\d`]/.test(l))
      .slice(0, take);
  }

  // 诚实说明强度：这条只抓**逐字复制**（把 md 粘进代码）。改写式的重复（当年那份「浓缩版
  // 规划指令」就是）逐行比对抓不到 —— 真正钉死那条规则的是下面那条「逐字节相等」。
  it('抓逐字复制：md 的指纹行不出现在注册代码里', () => {
    const code = registrationCode();
    const all = [
      ...listCommands().map((c) => [c.name, c.body]),
      ...listSkills().skills.map((s) => [s.name, s.body]),
      ...listAgents().map((a) => [a.name, a.persona]),
    ];
    const leaked = [];
    for (const [name, body] of all) {
      for (const line of fingerprints(body)) {
        if (code.includes(line)) leaked.push(`${name}: ${line.slice(0, 40)}…`);
      }
    }
    expect(leaked).toEqual([]);
  });

  // 这条是「不允许在注册代码里写属于 md 的文本」的正面表述：
  // 注册进平台的东西必须**逐字节等于** md 的内容，代码只做搬运，不做改写、不做补充。
  it('正面表述：注册给平台的内容逐字节等于 md（代码只搬运）', () => {
    // ① 命令：注入文本里必须有完整的 md 正文
    for (const cmd of listCommands()) {
      expect(composeInjection(cmd, ''), `命令 ${cmd.name} 的注入文本不含 md 正文`).toContain(cmd.body);
    }
    // ② 技能：注册的 content/description 就是 md 的正文与 frontmatter 值
    for (const s of listSkills().skills) {
      const reg = toRegistration(s);
      expect(reg.content, `技能 ${s.name} 的 content 被改写了`).toBe(s.body);
      expect(reg.description).toBe(s.description);
    }
  });

  it('代理：装配用的 persona / toolFilter / maxDepth 全部来自 md', async () => {
    const mounted = [];
    await mountSubagentTools({ plugin: (m, cfg) => mounted.push(cfg) }, {
      log: () => {}, loadToolSubagent: async () => ({ name: 'tool-subagent' }),
    });
    for (const a of listAgents()) {
      const cfg = mounted.find((c) => c.toolName === a.toolName);
      expect(cfg, `${a.name} 没被装配`).toBeTruthy();
      expect(cfg.persona, `${a.name} 的 persona 被改写了`).toBe(a.persona);
      expect(cfg.maxDepth).toBe(a.maxDepth);   // frontmatter 的 max-depth，不是代码默认值
      if (a.allowTools) expect(cfg.toolFilter.allow.length).toBeGreaterThan(0);
    }
  });

  it('代码里不出现平台工具名以外的命令字面量（cc 命名空间）', () => {
    const code = registrationCode();
    expect(code).not.toContain('ai-workflow-code:');
    expect(code).not.toContain('subagent_type');
  });
});

describe('装配时机：运行期装配必须经 ctx.inject（F25）', () => {
  /**
   * 真机踩到的坑：本插件由 profile patch 层插入，`apply()` 的时机**早于** base bundle 的
   * `commands` 注册表上线。在 apply 顶层 `ctx.get('commands')` 恒得 undefined ——
   * 表现是「插件装上了、hook 也接了，但网页输入框敲 `/` 一个命令都没有」，日志里只有一行
   * `commands 服务不可用`。探针坑位清单的 F25 就是这个。
   *
   * 这条断言把「必须等」钉死：apply 期间不许直接写 registry，只能交给 inject 回调。
   */
  function makeCtx({ autoFire } = {}) {
    const state = { registered: [], injected: [], pending: [] };
    const commands = { register: (d) => { state.registered.push(d); return () => {}; } };
    const ctx = {
      get: (n) => (n === 'commands' ? commands : undefined),
      on: () => () => {},
      effect: (fn) => fn(),
      inject: (deps, cb) => { state.injected.push(deps); if (autoFire) cb(ctx); else state.pending.push(cb); },
    };
    return { ctx, state };
  }

  it('apply 期间：命令一条都不注册，而是声明等待 commands', async () => {
    const { apply } = await import('../../server/adapters/dsh/plugin/index.js');
    const { ctx, state } = makeCtx();
    apply(ctx, { awfBase: 'http://127.0.0.1:59999' });

    expect(state.injected).toContainEqual(['commands']); // 声明了依赖
    expect(state.registered).toEqual([]);                // 没有抢跑（抢跑＝真机上恒为空）

    state.pending.forEach((cb) => cb(ctx));              // 服务就绪后
    expect(state.registered).toHaveLength(16);           // 16 条命令全注册上
  });

  it('没有 awfBase 时完全不装配（明确告警，不是静默半装）', async () => {
    const { apply } = await import('../../server/adapters/dsh/plugin/index.js');
    const { ctx, state } = makeCtx();
    const logs = [];
    const orig = console.error;
    console.error = (...a) => logs.push(a.join(' '));
    apply(ctx, {});
    console.error = orig;

    expect(state.injected).toEqual([]);
    expect(state.registered).toEqual([]);
    expect(logs.join()).toContain('未配置 awfBase');
  });
});

describe('assets：frontmatter 解析', () => {
  it('单行键值 + 引号剥除', () => {
    const { data, body } = parseFrontmatter('---\nname: a-b\ndescription: "带 引号"\n---\n正文\n');
    expect(data).toEqual({ name: 'a-b', description: '带 引号' });
    expect(body).toBe('正文\n');
  });

  it('折叠块 `>` 折成一行，字面块 `|` 保留换行', () => {
    const folded = parseFrontmatter('---\ndescription: >\n  第一行\n  第二行\nname: x\n---\nB');
    expect(folded.data.description).toBe('第一行 第二行');
    expect(folded.data.name).toBe('x'); // 块结束后的键仍要读到

    const literal = parseFrontmatter('---\ntext: |\n  甲\n  乙\n---\nB');
    expect(literal.data.text).toBe('甲\n乙');
  });

  it('没有 frontmatter → 整篇都是正文', () => {
    expect(parseFrontmatter('# 标题\n内容')).toEqual({ data: {}, body: '# 标题\n内容' });
  });
});

describe('assets：包内资产清单', () => {
  it('16 条命令，每条都有 description/hint 与非空正文', () => {
    const cmds = listCommands();
    expect(cmds).toHaveLength(16);
    for (const c of cmds) {
      expect(c.description, `${c.name} 缺 description`).toBeTruthy();
      expect(c.hint, `${c.name} 缺 hint`).toBeTruthy();
      expect(c.body.length, `${c.name} 正文为空`).toBeGreaterThan(50);
    }
    expect(cmds.map((c) => c.name)).toContain('w-plan');
  });

  it('36 个技能，全部带 name/description（DSH 会忽略缺这两项的文件 → 这里不能有跳过）', () => {
    const { skills, skipped } = listSkills();
    expect(skipped).toEqual([]);
    expect(skills).toHaveLength(36);
    for (const s of skills) {
      expect(s.description.length, `${s.name} description 太短`).toBeGreaterThan(5);
      expect(s.body.length, `${s.name} 正文为空`).toBeGreaterThan(50);
      expect(fs.existsSync(path.join(s.dir, 'SKILL.md'))).toBe(true);
    }
    // 技能名以 frontmatter 为准，与目录名一致
    expect(skills.map((s) => s.name)).toContain('awf-plan-wbs');
  });

  it('3 个代理：正文进 persona，tools 白名单与 max-depth 都从 frontmatter 读', () => {
    const agents = listAgents();
    expect(agents.map((a) => a.name).sort()).toEqual(['awf-monitor-probe', 'awf-monitor-repair', 'awf-worker']);
    const worker = agents.find((a) => a.name === 'awf-worker');
    expect(worker.toolName).toBe('awf_worker');
    expect(worker.allowTools).toContain('Read');
    expect(worker.allowTools).toContain('mcp__awf-state__awf_read_state');
    expect(worker.maxDepth).toBe(0);                          // 从 md 的 max-depth 读，不是代码里的默认值
    expect(worker.persona).toContain('RESULT: {"taskId"');   // 协议正文必须原样带着
    expect(worker.persona).toContain('NEEDS_INPUT');
    expect(worker.persona).toContain('awf_worker 工具');      // 平台工具名也是资产的一部分
  });

  it('代理名 kebab → 工具名 snake（DSH 工具名惯例）', () => {
    expect(toolNameFor('awf-worker')).toBe('awf_worker');
    expect(toolNameFor('awf-monitor-probe')).toBe('awf_monitor_probe');
  });

  it('cc 工具名 → DSH 工具名：表内映射，表外原样带回（不猜）', () => {
    const { mapped, unmapped } = mapToolNames(['Read', 'WebSearch', 'mcp__awf-state__awf_read_state']);
    expect(mapped).toEqual(['read', 'web_search']);
    expect(unmapped).toEqual(['mcp__awf-state__awf_read_state']);
  });

  it('mcp.json 声明 2 个 server，入口是包内相对路径，缺省只挂 awf-state', () => {
    const servers = listMcpServers();
    expect(servers.map((s) => s.name)).toEqual(['awf-state', 'awf-session']);
    expect(resolveServers({}).map((s) => s.name)).toEqual(['awf-state']);
    // 入口必须落在包内
    for (const s of servers) {
      expect(fs.existsSync(path.join(pluginRoot(), s.entry))).toBe(true);
      expect(path.relative(pluginRoot(), path.join(pluginRoot(), s.entry)).startsWith('..')).toBe(false);
    }
    // config.mcpServers 可显式指定
    expect(resolveServers({ mcpServers: ['awf-session'] }).map((s) => s.name)).toEqual(['awf-session']);
  });
});

describe('commands：注册与注入', () => {
  it('逐条 register，名字/描述/hint 来自 md 的 frontmatter', () => {
    const registered = [];
    const ctx = {
      get: (n) => (n === 'commands' ? { register: (def) => { registered.push(def); return () => {}; } } : undefined),
      effect: (fn) => fn(),
    };
    const r = registerCommands(ctx, { log: () => {} });
    expect(r.registered).toHaveLength(16);
    expect(r.skipped).toEqual([]);
    const plan = registered.find((d) => d.name === 'w-plan');
    expect(plan.description).toContain('主规划流程');
    expect(plan.input.hint).toContain('需求描述');
    expect(plan.handler).toBeTypeOf('function');
  });

  it('commands 服务不可用 → 一条不注册并回报（不静默少命令）', () => {
    const r = registerCommands({ get: () => undefined }, { log: () => {} });
    expect(r.registered).toEqual([]);
    expect(r.skipped).toHaveLength(16);
  });

  it('注入正文 = 命令正文 + 本次输入；无输入时用 md 声明的 empty-input 提示', () => {
    const cmd = { body: '正文', emptyInput: '（先问清楚）' };
    expect(composeInjection(cmd, '做一个登录页')).toContain('## 本次输入\n\n做一个登录页');
    expect(composeInjection(cmd, '')).toContain('（先问清楚）');
    expect(composeInjection({ body: '正文' }, '')).toBe('正文');
  });

  it('handler 把正文当用户消息注入当前会话（而非塞进工具返回值）', async () => {
    const followed = [];
    const registered = [];
    const ctx = {
      get: (n) => (n === 'commands' ? { register: (def) => { registered.push(def); return () => {}; } } : undefined),
      effect: (fn) => fn(),
    };
    const createUserMessage = vi.fn((m) => m);
    registerCommands(ctx, { log: () => {}, loadLlm: async () => ({ createUserMessage }) });
    const def = registered.find((d) => d.name === 'w-dev');
    const out = await def.handler({ rawInput: 'T1-001', agent: { followup: (m) => followed.push(m) } });
    expect(out.kind).toBe('success');
    expect(followed).toHaveLength(1);
    expect(followed[0].content[0].text).toContain('T1-001');
  });
});

describe('skills：会话级注册', () => {
  it('注册形状带 content / source / provider / resourceBase', () => {
    const seen = [];
    const agentCtx = { get: (n) => (n === 'skills' ? { register: (s) => { seen.push(s); return () => {}; } } : undefined) };
    const r = registerSkills(agentCtx, { log: () => {} });
    expect(r.registered).toHaveLength(36);
    expect(r.failed).toEqual([]);
    const wbs = seen.find((s) => s.name === 'awf-plan-wbs');
    expect(wbs.content.length).toBeGreaterThan(50);
    expect(wbs.resourceBase.kind).toBe('directory');
    expect(wbs.invocation).toEqual({ modelInvocable: true, userInvocable: true });
  });

  // 真机踩到：register 时不校验 source，load 时才校验（dsh-skill:486）——
  // 表现是技能在 `/` 目录里看得见，**一调用就报 `source must be a string`**。
  it('每条注册都带字符串 source（漏了它只会「加载时」炸，注册时静默通过）', () => {
    for (const s of listSkills().skills) {
      const reg = toRegistration(s);
      expect(typeof reg.source, `${s.name} 缺 source`).toBe('string');
      expect(reg.source.length).toBeGreaterThan(0);
      expect(typeof reg.provider).toBe('string');
      expect(typeof reg.content).toBe('string');
    }
  });

  it('缺 name/description 的技能不注册也不炸（DSH 会忽略，这里提前对齐）', () => {
    const reg = toRegistration({ name: 'x', description: 'd', body: 'b', dir: '/tmp' });
    expect(reg.name).toBe('x');
    expect(reg.whenToUse).toBeUndefined();
  });

  it('skills 服务不可用 → 明确告警 + 回报 failed（不是静默 0 个）', () => {
    const r = registerSkills({ get: () => undefined }, { log: () => {} });
    expect(r.registered).toEqual([]);
    expect(r.failed[0].name).toBe('(all)');
  });
});

describe('agents：命名子 Agent 装配', () => {
  it('每个 agents/*.md 挂一个 tool-subagent 实例：provider=spawn、persona 全文、maxDepth=0', async () => {
    const mounted = [];
    const agentCtx = { plugin: (mod, cfg) => mounted.push(cfg) };
    const r = await mountSubagentTools(agentCtx, { log: () => {}, loadToolSubagent: async () => ({ name: 'tool-subagent' }) });
    expect(r.mounted).toHaveLength(3);
    const worker = mounted.find((c) => c.toolName === 'awf_worker');
    expect(worker.provider).toBe('spawn');
    expect(worker.maxDepth).toBe(0);
    expect(worker.persona).toContain('你是 awf-worker');
    expect(worker.toolFilter.allow).toContain('read');
  });

  it('白名单核验：工具面里没有的名字被剔除、有的留下', () => {
    const drops = [];
    const agentCtx = {
      tools: {
        restrict: ({ allow }) => {
          if (allow[0] === 'read') return () => {};
          throw new Error(`tools.restrict() names unknown global tool "${allow[0]}"`);
        },
      },
    };
    const agent = { name: 'awf-worker', allowTools: ['Read', 'WebFetch'] };
    const r = resolveToolFilter(agentCtx, agent, (lvl, m) => drops.push(m));
    expect(r.allow).toEqual(['read']);
    expect(r.dropped.map((d) => d.name)).toEqual(['web_fetch']);
    expect(drops.join()).toContain('剔除');
  });

  it('核验手段本身不可用（非 unknown tool 的错）→ 不据此剔除，原样放行', () => {
    const agentCtx = { tools: { restrict: () => { throw new Error('tools.restrict() requires a scoped context'); } } };
    const r = resolveToolFilter(agentCtx, { name: 'w', allowTools: ['Read', 'Write'] }, () => {});
    expect(r.allow).toEqual(['read', 'write']);
    expect(r.dropped).toEqual([]);
  });

  it('没有 tools 声明的代理 → 不设过滤（null，不误伤）', () => {
    expect(resolveToolFilter({}, { name: 'x', allowTools: null }, () => {}).allow).toBeNull();
  });

  it('tool-subagent 加载不到 → 明确告警且不抛（会话仍能建起来）', async () => {
    const warns = [];
    const r = await mountSubagentTools({ plugin: () => {} }, {
      log: (lvl, m) => warns.push(m),
      loadToolSubagent: async () => { throw new Error('not installed'); },
    });
    expect(r.mounted).toEqual([]);
    expect(warns.join()).toContain('dsh-tool-subagent');
  });
});

describe('hooks：订阅表', () => {
  it('hooks.json 声明了会话事件与批准两条订阅，并如实登记未接的 hook 点', () => {
    const manifest = readManifest();
    expect(manifest.subscriptions.map((s) => s.dsh)).toEqual(['session/event', 'approval/request']);
    // cc 的 5 个 hook 点由同一条会话事件火线覆盖
    const turn = manifest.subscriptions.find((s) => s.dsh === 'session/event');
    expect(turn.cc).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop', 'SubagentStart', 'SubagentStop']);
    expect(Object.keys(manifest.notWired)).toContain('PreToolUse');
  });

  it('接线按声明走，未知处理器只告警不炸', () => {
    const on = [];
    const ctx = { on: (evt) => { on.push(evt); return () => {}; }, effect: (fn) => fn() };
    const deps = {
      createdByAwf: new Set(), inFlight: new Set(), emit: () => {}, noteApproval: () => {}, log: () => {},
    };
    const wired = installHooks(ctx, deps);
    expect(wired).toEqual(['session/event', 'approval/request']);
    expect(on).toEqual(['session/event', 'approval/request']);
  });
});
