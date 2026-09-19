import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const serve = require('../../server/adapters/dsh/serve.cjs');

/**
 * DSH 网页后台的「确保在跑」（`server/adapters/dsh/serve.cjs`）。
 *
 * 为什么值得单测：它会在用户机器上**起后台进程**，判错了不是报错而是行为错 ——
 * 假复用（端口被别的服务占着却当成 dsh）要到建会话才以难懂的方式炸；该复用却硬起
 * 会拉起第二个后台。这两条都用假探针钉住。
 */

describe('serve：启动参数（F37 的别名坑）', () => {
  it("profile=web 走 `dsh web`（别名不接受父级 --profile）", () => {
    expect(serve.dshArgs('web', 3080)).toEqual(['web', '--port', '3080', '--no-open']);
  });

  it('自定义 profile 才走 `--profile`', () => {
    expect(serve.dshArgs('awf-probe', 39081)).toEqual(['--profile', 'awf-probe', '--port', '39081', '--no-open']);
  });

  it('端口 / profile 的取值优先级：显式 > 环境变量 > 缺省', () => {
    expect(serve.webPortOf(undefined, {})).toBe(3080);
    expect(serve.webPortOf(undefined, { AWF_DSH_WEB_PORT: '4000' })).toBe(4000);
    expect(serve.webPortOf(5000, { AWF_DSH_WEB_PORT: '4000' })).toBe(5000);
    expect(serve.profileOf(undefined, {})).toBe('web');
    expect(serve.profileOf(undefined, { AWF_DSH_PROFILE: 'x' })).toBe('x');
    expect(serve.profileOf('y', { AWF_DSH_PROFILE: 'x' })).toBe('y');
  });
});

describe('serve：复用 / 拉起 / 报错', () => {
  function makeDeps(probes) {
    const spawned = [];
    const queue = [...probes];
    return {
      spawned,
      deps: {
        probeFn: vi.fn(async () => (queue.length > 1 ? queue.shift() : queue[0])),
        spawnFn: vi.fn((cmd, args) => { spawned.push({ cmd, args }); return { unref: () => {} }; }),
        sleepFn: async () => {},
      },
    };
  }

  it('已在跑（GET / = 401）→ 复用，不起第二个', async () => {
    const { spawned, deps } = makeDeps([{ kind: 'dsh', status: 401 }]);
    const r = await serve.ensureWeb({ deps });
    expect(r).toMatchObject({ reused: true, started: false, port: 3080, profile: 'web' });
    expect(spawned).toEqual([]);
  });

  it('没在跑 → 拉起（参数正确）并等到就绪', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-dsh-serve-'));
    const { spawned, deps } = makeDeps([{ kind: 'absent' }, { kind: 'dsh', status: 401 }]);
    const r = await serve.ensureWeb({ logDir: tmp, webPort: 39081, profile: 'p', deps });

    expect(r).toMatchObject({ reused: false, started: true, port: 39081, profile: 'p' });
    expect(spawned).toEqual([{ cmd: 'dsh', args: ['--profile', 'p', '--port', '39081', '--no-open'] }]);
    expect(fs.existsSync(path.join(tmp, 'dsh-web.log'))).toBe(true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('端口被别的服务占着（HTTP 200）→ 显式报错，绝不硬起', async () => {
    const { spawned, deps } = makeDeps([{ kind: 'foreign', status: 200 }]);
    await expect(serve.ensureWeb({ deps })).rejects.toThrow(/不是 dsh 网页后台/);
    expect(spawned).toEqual([]);
  });

  it('端口有人监听但不响应 → 同样报错（不当成「没起」）', async () => {
    const { spawned, deps } = makeDeps([{ kind: 'timeout' }]);
    await expect(serve.ensureWeb({ deps })).rejects.toThrow(/不是 dsh 网页后台/);
    expect(spawned).toEqual([]);
  });

  it('拉起了但一直不就绪 → 超时硬失败，并把日志路径与手动命令给出来', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-dsh-serve-'));
    const { deps } = makeDeps([{ kind: 'absent' }]); // 之后一直是 absent
    await expect(serve.ensureWeb({ logDir: tmp, timeoutMs: 1, deps })).rejects.toThrow(/启动超时/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('dsh 不在 PATH（spawn 抛错）→ 报错并指向 PATH', async () => {
    const deps = {
      probeFn: async () => ({ kind: 'absent' }),
      spawnFn: () => { throw new Error('spawn dsh ENOENT'); },
      sleepFn: async () => {},
    };
    await expect(serve.ensureWeb({ deps })).rejects.toThrow(/dsh 在 PATH 里吗/);
  });
});
