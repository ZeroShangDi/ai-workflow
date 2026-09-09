import { describe, it, expect } from 'vitest';
import { SID_PATTERN, SID_MAX_LEN, validateRunId, normalizeStamp, deriveRunId, generateRunId } from '../../src/lib/run-id.cjs';

// run-id（W1-009 / T1-009）：生成/校验/派生规则。
// 派生形状与现行 runStamp 对齐（.awf/logs/<version>-<compactISO>），供 runStamp→sid 归一无痛迁移。

const FIXED_TS = new Date('2026-09-07T13:32:37.000Z');

describe('validateRunId — 校验', () => {
  it('合法 id 通过', () => {
    expect(validateRunId('0.2.0-2026-09-07T13-32-37')).toBe(true);
    expect(validateRunId('a')).toBe(true);
    expect(validateRunId('a'.repeat(64))).toBe(true);
  });

  it('非法 id 拒绝（含分隔符/注入/超长/非字符串）', () => {
    for (const bad of ['../evil', 'a/b', 'a b', '', '-lead', 'a'.repeat(65), null, undefined, 42]) {
      expect(validateRunId(bad), `应拒绝 ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it('SID_PATTERN 约束 ≤64 字符', () => {
    expect(SID_MAX_LEN).toBe(64);
    expect(SID_PATTERN.test('a'.repeat(64))).toBe(true);
    expect(SID_PATTERN.test('a'.repeat(65))).toBe(false);
  });
});

describe('normalizeStamp — 时间戳归一', () => {
  it('ISO/Date → YYYY-MM-DDTHH-mm-ss（:/. → -，19 位）', () => {
    expect(normalizeStamp('2026-09-07T13:32:37.123Z')).toBe('2026-09-07T13-32-37');
    expect(normalizeStamp(FIXED_TS)).toBe('2026-09-07T13-32-37');
  });

  it('非法时间戳抛错', () => {
    expect(() => normalizeStamp('not-a-date')).toThrowError(/非法时间戳/);
    expect(() => normalizeStamp()).toThrowError(/非法时间戳/);
  });
});

describe('deriveRunId — 派生（= runStamp 形状）', () => {
  it('${version}-<compactISO>', () => {
    expect(deriveRunId({ version: '0.2.0', ts: FIXED_TS })).toBe('0.2.0-2026-09-07T13-32-37');
  });

  it('缺 version / 非法结果抛错', () => {
    expect(() => deriveRunId({ ts: FIXED_TS })).toThrowError(/version 缺失/);
    expect(() => deriveRunId({ version: 'v/ x', ts: FIXED_TS })).toThrowError(/非法/);
  });
});

describe('generateRunId — 生成（默认带熵后缀唯一）', () => {
  it('entropy=true：派生 + 短随机后缀，同输入两次不同', () => {
    const a = generateRunId({ version: '0.2.0', ts: FIXED_TS, random: 'ab12' });
    const b = generateRunId({ version: '0.2.0', ts: FIXED_TS, random: 'cd34' });
    expect(a).toBe('0.2.0-2026-09-07T13-32-37-ab12');
    expect(b).not.toBe(a);
    expect(validateRunId(a)).toBe(true);
  });

  it('entropy=false：退化为纯派生（= runStamp，确定可复现）', () => {
    const id = generateRunId({ version: '0.2.0', ts: FIXED_TS, entropy: false });
    expect(id).toBe('0.2.0-2026-09-07T13-32-37');
  });

  it('无 random 注入时默认熵生成也合法', () => {
    const id = generateRunId({ version: '0.2.0', ts: FIXED_TS });
    expect(validateRunId(id)).toBe(true);
    expect(id.startsWith('0.2.0-2026-09-07T13-32-37-')).toBe(true);
  });

  it('超长（version 很长）抛错', () => {
    expect(() => generateRunId({ version: 'v'.repeat(70), ts: FIXED_TS })).toThrowError(/超长|非法/);
  });
});
