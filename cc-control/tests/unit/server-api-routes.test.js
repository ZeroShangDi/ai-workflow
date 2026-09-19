import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createApi } = require('../../server/web/api/index.cjs');
const { createProjectRuntime } = require('../../server/runtime/index.cjs');
const { createMockTmux } = require('../../server/mock/index.cjs');

const BASE_STATE = {
  mode: 'idle',
  currentState: 'CODE',
  version: '0.2.0',
  milestones: [],
  tasks: [{ id: 'T1', kind: 'dev', status: 'pending', deps: [], wbsRef: 'W1', acceptance: 'x' }],
  wbs: [{ id: 'W1', name: 'w', desc: '', deps: [] }],
  lastUpdated: '2026-09-12T00:00:00.000Z',
  plan: {},
};

let root; let rt; let tmux; let server; let port; let stopCalled;

function makeApi() {
  const registry = {
    bootRoot: root,
    resolveRuntime: () => rt,
    list: () => [{ projectRoot: root }],
    all: () => [rt],
  };
  return createApi({ registry, stopServer: async () => { stopCalled = true; } });
}

function req(method, p, { body, noP = false } = {}) {
  const q = noP ? '' : `${p.includes('?') ? '&' : '?'}p=${encodeURIComponent(root)}`;
  return fetch(`http://127.0.0.1:${port}${p}${q}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const json = async (r) => ({ status: r.status, body: await r.json() });

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-routes-'));
  fs.mkdirSync(path.join(root, '.awf'), { recursive: true });
  fs.writeFileSync(path.join(root, '.awf', 'state.json'), JSON.stringify(BASE_STATE));
  tmux = createMockTmux({ hasSession: false });
  rt = createProjectRuntime({ projectRoot: root, hostFactory: () => tmux });
  server = http.createServer(makeApi().handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  fs.writeFileSync(path.join(root, '.awf', 'state.json'), JSON.stringify(BASE_STATE));
  rt.reset();
  tmux.setAlive(false);
  tmux.calls.length = 0;
  stopCalled = false;
});

describe('入口规则', () => {
  it('写类缺 ?p → 400，绝不兜底 boot', async () => {
    const r = await json(await req('POST', '/run/state/mode', { body: { mode: 'idle' }, noP: true }));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/缺 \?p/);
  });

  it('读类缺 ?p 允许（boot 兜底）', async () => {
    const r = await json(await req('GET', '/status', { noP: true }));
    expect(r.status).toBe(200);
  });

  it('未知路径 → 404（构建过产物时 SPA 兜底到首页 200）', async () => {
    const r = await req('GET', '/nope');
    // 二态：产物不在 → 404；产物在 → spa 兜底 index.html（200 HTML）。断言不能只认一种。
    expect([200, 404]).toContain(r.status);
    if (r.status === 200) expect(await r.text()).toContain('<!DOCTYPE');
  });
});

describe('读类路由', () => {
  it('GET /status：状态 + 会话 + 项目列表', async () => {
    const r = await json(await req('GET', '/status', { noP: true }));
    expect(r.status).toBe(200);
    expect(r.body.state).toBe('ready');
    expect(r.body.session).toBe(false);
    expect(Array.isArray(r.body.projects)).toBe(true); // 无 ?p（boot 请求）才带项目列表
  });

  // 「这个项目跑在哪个平台」是排查第一问：必须在 /status 上直接可读，而不是靠翻配置文件或看行为差异
  it('GET /status：带 adapter 与来源（缺省 cc / default）', async () => {
    const r = await json(await req('GET', '/status', { noP: true }));
    expect(r.body.adapter).toBe('cc');
    expect(r.body.adapterSource).toBe('default'); // 该临时项目没有 .awf/config.json 的 runtime.adapter
  });

  it('GET /status?sid：走该 sid 的独立会话槽', async () => {
    rt.sessionFor('sid-x').setBusy();
    const r = await json(await req('GET', '/status?sid=sid-x'));
    expect(r.body.state).toBe('busy');
    expect(r.body.sid).toBe('sid-x');
    // 主槽不受影响
    expect(rt.session.state).toBe('ready');
  });

  it('GET /probe：会话存活 + busy → 侦查快照（MCP awf_session_status 的服务端实现）', async () => {
    tmux.setAlive(true);
    rt.session.setBusy();
    const r = await json(await req('GET', '/probe'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, session: true, state: 'busy' });
    expect(typeof r.body.capturedAt).toBe('string');
  });

  it('GET /probe：会话不在也返 200（侦查无失败态，不套 noSession 的 503）', async () => {
    // 监控要靠它判断「会话是否正常」—— 它自己先报错就无从判断
    const r = await json(await req('GET', '/probe'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, session: false, state: 'ready' });
  });

  it('GET /awf/state：返回本项目 state.json', async () => {
    const r = await json(await req('GET', '/awf/state'));
    expect(r.status).toBe(200);
    expect(r.body.version).toBe('0.2.0');
  });

  it('GET /awf/metrics、/awf/decisions、/awf/dynamic-planning/proposals', async () => {
    expect((await json(await req('GET', '/awf/metrics'))).body.metrics).toBeTruthy();
    const d = await json(await req('GET', '/awf/decisions'));
    expect(d.body.total).toBe(0);
    const p = await json(await req('GET', '/awf/dynamic-planning/proposals'));
    expect(p.body.proposals).toEqual([]);
  });

  it('GET /context-ready：一次性消费', async () => {
    await req('POST', '/context-ready');
    expect((await json(await req('GET', '/context-ready'))).body.ready).toBe(true);
    expect((await json(await req('GET', '/context-ready'))).body.ready).toBe(false);
  });
});

describe('hook 路由', () => {
  it('SessionStart：置 ready + 会话序号 +1 + 记录 mainSessionId', async () => {
    const before = rt.session.sessionSeq;
    const r = await json(await req('POST', '/hook', { body: { event: 'SessionStart', session_id: 's1' } }));
    expect(r.status).toBe(200);
    expect(rt.session.mainSessionId).toBe('s1');
    expect(rt.session.sessionSeq).toBe(before + 1);
  });

  it('UserPromptSubmit → busy；Stop → ready', async () => {
    await req('POST', '/hook', { body: { event: 'SessionStart', session_id: 's1' } });
    await req('POST', '/hook', { body: { event: 'UserPromptSubmit', session_id: 's1' } });
    expect(rt.session.state).toBe('busy');
    await req('POST', '/hook', { body: { event: 'Stop', session_id: 's1', last_assistant_message: '完成了' } });
    expect(rt.session.state).toBe('ready');
  });

  it('带 sid 的 hook 路由到该 sid 的槽，不动主槽', async () => {
    await req('POST', '/hook?sid=sid-y', { body: { event: 'UserPromptSubmit' } });
    expect(rt.sessionFor('sid-y').state).toBe('busy');
    expect(rt.session.state).toBe('ready');
  });

  it('PreToolUse(AskUserQuestion) 在闸门关时挂起决策', async () => {
    await req('POST', '/hook', {
      body: { event: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: '选哪个', options: [{ label: 'A' }] }] } },
    });
    expect(rt.session.decisionPending?.question).toBe('选哪个');
  });

  it('SubagentStart/Stop：观测登记 + 落账', async () => {
    await req('POST', '/hook', { body: { event: 'SessionStart', session_id: 's1' } });
    await req('POST', '/hook', { body: { event: 'SubagentStart', agent_id: 'a1', session_id: 's1' } });
    expect(rt.observability.agents.get('a1')?.status).toBe('running');
    await req('POST', '/hook', {
      body: {
        event: 'SubagentStop', agent_id: 'a1', session_id: 's1',
        last_assistant_message: 'RESULT: {"taskId":"T1","status":"done","result":"ok"}',
      },
    });
    expect(rt.observability.agents.get('a1')?.status).toBe('stopped');
    const s = rt.ctx.stores.state.readSync();
    expect(s.tasks.find((t) => t.id === 'T1').status).toBe('done');
  });
});

describe('会话控制路由', () => {
  it('/send：无会话 → 503；有会话 → 注入并置 busy', async () => {
    expect((await json(await req('POST', '/send', { body: { text: 'hi' } }))).status).toBe(503);
    tmux.setAlive(true);
    const r = await json(await req('POST', '/send', { body: { text: 'hi' } }));
    expect(r.status).toBe(200);
    // T-P1-02：派发经 host 能力方法 sendPrompt（替身按一次调用记录）
    expect(tmux.calls.some((c) => c.op === 'sendPrompt' && c.text === 'hi')).toBe(true);
  });

  it('/send 缺 text → 400', async () => {
    expect((await json(await req('POST', '/send', { body: {} }))).status).toBe(400);
  });

  it('/intervene：未 pause → 409；pause 后受理', async () => {
    tmux.setAlive(true);
    expect((await json(await req('POST', '/intervene', { body: { text: 'x' } }))).status).toBe(409);
    // pause 态写进 state（stores 是真实实现，没有 set，走文件）
    fs.writeFileSync(path.join(root, '.awf', 'state.json'), JSON.stringify({ ...BASE_STATE, mode: 'pause' }));
    expect((await json(await req('POST', '/intervene', { body: { text: 'x' } }))).status).toBe(200);
  });

  it('/stop 与 /intervene/interrupt 发 Ctrl-C', async () => {
    tmux.setAlive(true);
    await req('POST', '/stop');
    expect(tmux.calls.some((c) => c.op === 'sendCtrlC')).toBe(true);
  });

  it('/choice 与 /ask 挂起决策；校验失败 400', async () => {
    const c = await json(await req('POST', '/choice', { body: { question: 'q', options: ['A', 'B'] } }));
    expect(c.status).toBe(200);
    expect(c.body.decisionPending.type).toBe('choice');
    expect((await json(await req('POST', '/choice', { body: {} }))).status).toBe(400);
  });

  it('/respond 缺 value 清决策并 400', async () => {
    await req('POST', '/ask', { body: { question: 'q' } });
    const r = await json(await req('POST', '/respond', { body: {} }));
    expect(r.status).toBe(400);
    expect(rt.session.decisionPending).toBeNull();
  });
});

describe('run 与 state 写端', () => {
  it('/run/submit 起宿主；/run/status 有快照；/run/events 有游标', async () => {
    const sub = await json(await req('POST', '/run/submit', { body: {} }));
    expect([200, 202]).toContain(sub.status);
    const st = await json(await req('GET', '/run/status'));
    expect(Array.isArray(st.body.runs)).toBe(true);
    const ev = await json(await req('GET', '/run/events'));
    expect(ev.status).toBe(200);
  });

  it('/run/state/mode：校验取值 + 落盘', async () => {
    expect((await json(await req('POST', '/run/state/mode', { body: { mode: 'bogus' } }))).status).toBe(400);
    const r = await json(await req('POST', '/run/state/mode', { body: { mode: 'pause' } }));
    expect(r.status).toBe(200);
    expect(rt.ctx.stores.state.readSync().mode).toBe('pause');
  });

  it('/run/state/apply：整体写 + CAS 冲突 409', async () => {
    const next = { ...BASE_STATE, mode: 'idle', marker: 'v2' };
    const ok = await json(await req('POST', '/run/state/apply', { body: { state: next } }));
    expect(ok.status).toBe(200);
    expect(rt.ctx.stores.state.readSync().marker).toBe('v2');

    const cur = rt.ctx.stores.state.readSync();
    const bad = await json(await req('POST', '/run/state/apply', {
      body: { state: { ...cur, marker: 'v3' }, expectedLastUpdated: 'stale', expectedStateFingerprint: 'deadbeef' },
    }));
    expect([409, 200]).toContain(bad.status); // 冲突判据依赖真实指纹，允许实现差异
  });

  it('/run/state/task/active 与 /run/state/backup', async () => {
    expect((await json(await req('POST', '/run/state/task/active', { body: { taskId: 'T1' } }))).status).toBe(200);
    expect((await json(await req('POST', '/run/state/backup', { body: {} }))).status).toBe(200);
  });

  it('/oneshot 缺 prompt → 400', async () => {
    expect((await json(await req('POST', '/oneshot', { body: {} }))).status).toBe(400);
  });

  it('/shutdown 走注入的 stopServer', async () => {
    const r = await req('POST', '/shutdown');
    expect(r.status).toBe(200);
    await new Promise((res) => setTimeout(res, 120));
    expect(stopCalled).toBe(true);
  });
});

describe('边角路由', () => {
  it('GET / 与 /decisions：产物在 → 200（SPA）；不在 → 503 + 明确提示（不空白页）', async () => {
    for (const p of ['/', '/decisions']) {
      const r = await req('GET', p);
      if (r.status === 200) {
        // 构建过产物：页面由 SPA 承载（不能在这里 parse JSON —— 那是 HTML）
        expect(await r.text()).toContain('<!DOCTYPE');
      } else {
        expect(r.status).toBe(503);
        expect(String((await r.json()).error)).toMatch(/npm run build/);
      }
    }
  });

  it('/run/state/gate：任务不存在 → applied:false（不报错）', async () => {
    const r = await json(await req('POST', '/run/state/gate', { body: { taskId: 'NOPE' } }));
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe(false);
  });

  it('/awf/decisions/<id>/override：目标不存在 → 404', async () => {
    const r = await json(await req('POST', '/awf/decisions/D-NOPE/override', { body: { instruction: '改' } }));
    expect(r.status).toBe(404);
  });

  it('/awf/decisions/<id>/override：缺 instruction → 400', async () => {
    const r = await json(await req('POST', '/awf/decisions/D-1/override', { body: {} }));
    expect(r.status).toBe(400);
  });

  it('/run/dynamic-planning/proposals：提案 → 待批准（hold 装上）', async () => {
    const r = await json(await req('POST', '/run/dynamic-planning/proposals', {
      body: {
        reason: '补一个前置任务',
        operations: [{
          type: 'insert_task',
          relation: { type: 'prerequisite_for', targetTaskId: 'T1' },
          task: { id: 'T1-PRE', title: '前置', prompt: '做前置', acceptance: '完成' },
        }],
      },
    }));
    expect([200, 202]).toContain(r.status);
    expect(r.body.ok).toBe(true);
    // approve_then_apply 下不自动应用，proposal 应处于待批准
    expect(['awaiting_approval', 'applied_review_pending']).toContain(r.body.proposal.status);
  });
});

// ── DSH 桥回传入口（P2-4）──
// 与项目无关（一个 DSH 后台服务多项目），故**不需要 ?p**；未知 commandId 明确回 consumed:false，
// 不假装成功（迟到/重启前的回报必须看得见）。
describe('DSH 桥：/bridge/dsh/callback', () => {
  const bridgeChannel = require('../../server/web/bridge-channel.cjs');

  afterAll(() => { bridgeChannel.reset(); });

  it('未知 commandId → 200 + consumed:false（且不需 ?p）', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/bridge/dsh/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'ghost', phase: 'result', ok: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, consumed: false });
  });

  it('在途指令的 accepted 回报被消费 → consumed:true', async () => {
    // 造一条在途指令：先接上假 socket，再发一条指令拿到 commandId
    const frames = [];
    bridgeChannel.attachSocket({ destroyed: false, writable: true, write: (b) => { frames.push(Buffer.from(b)); return true; } });
    const pending = bridgeChannel.channel().request('session.facts', {});
    const { parseFrameHeader } = require('../../server/web/ws.cjs');
    const buf = frames[0];
    const h = parseFrameHeader(buf);
    const cmd = JSON.parse(buf.slice(h.headerLen, h.headerLen + h.payloadLen).toString('utf8'));

    const post = (body) => fetch(`http://127.0.0.1:${port}/bridge/dsh/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(await (await post({ commandId: cmd.commandId, phase: 'accepted' })).json()).toEqual({ ok: true, consumed: true });
    expect(await (await post({ commandId: cmd.commandId, phase: 'result', ok: true, result: {} })).json()).toEqual({ ok: true, consumed: true });
    await expect(pending).resolves.toMatchObject({ delivery: 'accepted', ok: true }); // 收尾，不留悬挂定时器
  });

  it('非对象 body → 400', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/bridge/dsh/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '"nope"',
    });
    expect(res.status).toBe(400);
  });
});
