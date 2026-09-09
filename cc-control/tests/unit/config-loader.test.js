import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import loader from '../../src/lib/config-loader.cjs';

const { ConfigError, deepMerge, readJsonFile, loadConfig } = loader;

// config-loader 三类能力（W1-001 / T1-004）：
//   1. 默认值合并 —— deepMerge 整段对象合并 + loadConfig 逐 key default 兜底
//   2. env 覆盖    —— env(rule.env) > 文件值 > default，env 字符串按 type 强转
//   3. 校验        —— 声明式类型/边界；strict 抛 ConfigError 聚合全部字段，非 strict 回落 default
// 额外：点分 key 嵌套展开、passthrough 保留整份文件、ConfigError.code 保留 fs 错误码。

const tmpDirs = [];

function tmpFile(content, name = 'config.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-configloader-'));
  tmpDirs.push(dir);
  const filePath = path.join(dir, name);
  if (content !== undefined) fs.writeFileSync(filePath, content);
  return filePath;
}

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('deepMerge — 默认值合并', () => {
  it('普通对象逐层递归合并：patch 覆盖、base 未覆盖键保留', () => {
    const out = deepMerge(
      { run: { agents: { max: 1, maxModules: 1 }, decision: { enabled: false } }, docs: { enabled: true } },
      { run: { agents: { max: 10 } }, docs: { enabled: false } },
    );
    expect(out).toEqual({ run: { agents: { max: 10, maxModules: 1 }, decision: { enabled: false } }, docs: { enabled: false } });
  });

  it('数组/标量整体替换，不做逐元素合并', () => {
    expect(deepMerge({ a: [1, 2] }, { a: [3] }).a).toEqual([3]);
    expect(deepMerge({ a: 1 }, { a: 2 }).a).toBe(2);
  });

  it('不改入参（纯函数）', () => {
    const base = { run: { agents: { max: 1 } } };
    deepMerge(base, { run: { agents: { max: 5 } } });
    expect(base.run.agents.max).toBe(1);
  });

  it('非对象（undefined/标量）与对象合并 → 返回 patch', () => {
    expect(deepMerge(undefined, { x: 1 })).toEqual({ x: 1 });
    expect(deepMerge(null, 3)).toBe(3);
    expect(deepMerge({ a: 1 }, null)).toBe(null);
  });
});

describe('readJsonFile — JSON 读取', () => {
  it('正常解析', () => {
    const p = tmpFile(JSON.stringify({ run: { agents: { max: 5 } } }));
    expect(readJsonFile(p).run.agents.max).toBe(5);
  });

  it('optional=true：缺失文件 → null（默认兜底由调用方接管）', () => {
    const p = tmpFile(undefined);
    expect(readJsonFile(p, { optional: true })).toBeNull();
  });

  it('optional=false：缺失文件 → ConfigError，且 code 保留 fs 错误码 ENOENT', () => {
    const p = tmpFile(undefined);
    try {
      readJsonFile(p);
      expect.unreachable('应抛错');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect(e.code).toBe('ENOENT');
      expect(e.message).toContain('读取配置文件失败');
    }
  });

  it('optional=true：非法 JSON → null', () => {
    const p = tmpFile('{ oops');
    expect(readJsonFile(p, { optional: true })).toBeNull();
  });

  it('optional=false：非法 JSON → ConfigError', () => {
    const p = tmpFile('{ oops');
    try {
      readJsonFile(p);
      expect.unreachable('应抛错');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect(e.message).toContain('非法 JSON');
    }
  });

  it('容忍 UTF-8 BOM', () => {
    const p = tmpFile(`﻿${JSON.stringify({ a: 1 })}`);
    expect(readJsonFile(p).a).toBe(1);
  });
});

describe('loadConfig — env > 文件 > default 优先级 + 点分嵌套', () => {
  it('env 覆盖文件值；文件覆盖 default；未命中用 default', () => {
    const p = tmpFile(JSON.stringify({ run: { agents: { max: 4 } }, decision: { enabled: true } }));
    const cfg = loadConfig({
      rules: {
        port: { default: 8787, env: 'CC_PORT', type: 'integer' },
        session: { default: 'cc', type: 'string' },
        'run.agents.max': { default: 1, type: 'integer' },
        missing: { default: 'd' },
      },
      source: { filePath: p },
      env: { CC_PORT: '9000' },
    });
    expect(cfg.port).toBe(9000); // env
    expect(cfg.run.agents.max).toBe(4); // file
    expect(cfg.decision).toBeUndefined(); // 未声明 key 不输出（非 passthrough）
    expect(cfg.session).toBe('cc'); // default
    expect(cfg.missing).toBe('d'); // default
  });

  it('点分 key 展开为嵌套对象', () => {
    const cfg = loadConfig({ rules: { 'a.b.c': { default: 1 } } });
    expect(cfg.a.b.c).toBe(1);
  });

  it('env 字符串按 type 强转：boolean / integer / json', () => {
    const cfg = loadConfig({
      rules: {
        flag: { default: true, env: 'FLAG', type: 'boolean' },
        count: { env: 'N', type: 'integer' },
        meta: { env: 'M', type: 'json' },
      },
      env: { FLAG: 'false', N: '3', M: '{"a":2}' },
    });
    expect(cfg.flag).toBe(false);
    expect(cfg.count).toBe(3);
    expect(cfg.meta).toEqual({ a: 2 });
  });

  it('source 缺失文件 optional=true → 全部回落 default', () => {
    const p = tmpFile(undefined);
    const cfg = loadConfig({ rules: { port: { default: 8787 } }, source: { filePath: p, optional: true } });
    expect(cfg.port).toBe(8787);
  });

  it('可选文件缺失 + env 提供 → 用 env', () => {
    const p = tmpFile(undefined);
    const cfg = loadConfig({ rules: { port: { default: 8787, env: 'CC_PORT', type: 'integer' } }, source: { filePath: p, optional: true }, env: { CC_PORT: '1' } });
    expect(cfg.port).toBe(1);
  });
});

describe('loadConfig — 校验：strict 抛错 / 非 strict 回落', () => {
  it('strict：多个字段非法 → ConfigError 聚合全部字段错误', () => {
    try {
      loadConfig({
        rules: {
          port: { default: 8787, env: 'CC_PORT', type: 'integer', min: 1000 },
          bad: { default: 'x', type: 'integer' },
        },
        env: { CC_PORT: '99' },
      });
      expect.unreachable('应抛错');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect(e.errors).toHaveLength(2);
      expect(e.message).toContain('[port]');
      expect(e.message).toContain('不能小于 1000');
      expect(e.message).toContain('[bad]');
    }
  });

  it('strict：文件值类型非法 → 抛错（文件侧不强转、只校验）', () => {
    const p = tmpFile(JSON.stringify({ run: { agents: { max: 'many' } } }));
    try {
      loadConfig({ rules: { 'run.agents.max': { default: 1, type: 'integer' } }, source: { filePath: p } });
      expect.unreachable('应抛错');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect(e.errors[0]).toContain('应为 整数');
    }
  });

  it('非 strict：非法值回落 default（保留现有 .awf/config.json 静默回落语义）', () => {
    const p = tmpFile(JSON.stringify({ max: 'many' }));
    const cfg = loadConfig({ rules: { max: { default: 1, type: 'integer' } }, source: { filePath: p }, strict: false });
    expect(cfg.max).toBe(1);
  });

  it('非 strict：env 非法且无 default → 丢弃该 key（不写入非法值）', () => {
    const cfg = loadConfig({ rules: { x: { env: 'X', type: 'integer' } }, env: { X: 'abc' }, strict: false });
    expect('x' in cfg).toBe(false);
  });

  it('strict：required 且无任何来源 → 抛错；非 strict → 无该 key', () => {
    try {
      loadConfig({ rules: { x: { required: true } } });
      expect.unreachable('应抛错');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect(e.errors[0]).toContain('缺少必填');
    }
    const loose = loadConfig({ rules: { x: { required: true } }, strict: false });
    expect('x' in loose).toBe(false);
  });

  it('数值边界 / 字符串 pattern / enum 校验', () => {
    const expectThrow = (rules, env) => {
      expect(() => loadConfig({ rules, env })).toThrowError(ConfigError);
    };
    expectThrow({ port: { default: 8787, env: 'P', type: 'integer', min: 1, max: 65535 } }, { P: '0' });
    expectThrow({ name: { env: 'N', type: 'string', pattern: /^[A-Za-z]+$/ } }, { N: 'abc123' });
    expectThrow({ mode: { env: 'M', type: 'string', enum: ['run', 'plan'] } }, { M: 'idle' });
  });
});

describe('loadConfig — passthrough：整份文件为基底', () => {
  it('未声明字段原样保留；声明 key 兜底/覆盖/校验', () => {
    const p = tmpFile(JSON.stringify({ port: 9000, future: { x: 1 }, nested: { a: 1, b: 2 } }));
    const cfg = loadConfig({
      rules: {
        port: { type: 'integer' },
        engineDir: { default: 'core', type: 'string' },
        'nested.b': { type: 'integer' },
      },
      source: { filePath: p },
      passthrough: true,
    });
    expect(cfg.port).toBe(9000);
    expect(cfg.engineDir).toBe('core'); // 缺省兜底
    expect(cfg.future).toEqual({ x: 1 }); // 未声明保留
    expect(cfg.nested).toEqual({ a: 1, b: 2 });
  });

  it('passthrough 下声明 key 非法仍校验', () => {
    const p = tmpFile(JSON.stringify({ port: 'bad' }));
    expect(() =>
      loadConfig({ rules: { port: { type: 'integer' } }, source: { filePath: p }, passthrough: true }),
    ).toThrowError(ConfigError);
  });
});
