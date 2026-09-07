import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import decision from '../../src/server/decision.cjs';

const { parseDecisionResult, validateDecisionResult, REQUIRED_FIELDS } = decision;

const REPO = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

const wrap = (json) => `<AWF_DECISION_RESULT>\n${json}\n</AWF_DECISION_RESULT>`;

const validResult = {
  answer: '选择 A：先做可逆验证',
  type: 'resolved',
  finality: 'final',
  real_question: '本次真正需要决定的行动',
  decisive_factors: ['验证成本', '可逆性'],
  reconsider_when: ['新事实出现时'],
};

describe('parseDecisionResult — 从 last_assistant_message 解析 + 轻量校验', () => {
  it('合法结果（含 <AWF_DECISION_RESULT> 包裹的完整 JSON）→ valid 且 result 还原', () => {
    const msg = `分析完成。\n${wrap(JSON.stringify(validResult, null, 2))}`;
    const r = parseDecisionResult(msg);
    expect(r.valid).toBe(true);
    expect(r.result).toEqual(validResult);
  });

  it('缺 answer（JSON 完整但无 answer 字段）→ invalid(missing_required) 且 missing 含 answer', () => {
    const { answer, ...rest } = validResult;
    const r = parseDecisionResult(wrap(JSON.stringify(rest)));
    expect(r.valid).toBe(false);
    expect(r.error).toBe('missing_required');
    expect(r.missing).toContain('answer');
  });

  it('answer 为空字符串 → invalid（answer 非空约束）', () => {
    const r = parseDecisionResult(wrap(JSON.stringify({ ...validResult, answer: '  ' })));
    expect(r.valid).toBe(false);
    expect(r.missing).toContain('answer');
  });

  it('数组字段类型不符（decisive_factors 为字符串）→ invalid', () => {
    const r = parseDecisionResult(wrap(JSON.stringify({ ...validResult, decisive_factors: 'f1' })));
    expect(r.valid).toBe(false);
    expect(r.missing).toContain('decisive_factors');
  });

  it('标记内非 JSON → invalid(invalid_json)', () => {
    const r = parseDecisionResult(wrap('{ not json'));
    expect(r.valid).toBe(false);
    expect(r.error).toBe('invalid_json');
  });

  it('无结果标记 → invalid(no_marker)', () => {
    const r = parseDecisionResult('普通完成，无决策标记');
    expect(r.valid).toBe(false);
    expect(r.error).toBe('no_marker');
  });

  it('非字符串输入 / 缺失字段集合 → 均回落 no_marker', () => {
    expect(parseDecisionResult(undefined).error).toBe('no_marker');
    expect(parseDecisionResult(null).error).toBe('no_marker');
    const { reconsider_when, ...rest } = validResult;
    const r = parseDecisionResult(wrap(JSON.stringify(rest)));
    expect(r.valid).toBe(false);
    expect(r.missing).toEqual(expect.arrayContaining(['reconsider_when']));
  });
});

describe('必填集合与 schema 一致', () => {
  it('REQUIRED_FIELDS = schema.required − decision_id（server 侧赋值）', () => {
    const schema = JSON.parse(
      fs.readFileSync(path.join(REPO, 'plugin', 'decision', 'decision', 'schemas', 'decision-result.schema.json'), 'utf8'),
    );
    const schemaRequired = schema.required.filter((f) => f !== 'decision_id').sort();
    expect([...REQUIRED_FIELDS].sort()).toEqual(schemaRequired);
    // schema 仍把 decision_id 列为必填（server 捕获时补）
    expect(schema.required).toContain('decision_id');
  });
});
