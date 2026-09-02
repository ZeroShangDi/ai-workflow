import { describe, expect, it } from 'vitest';
import diagnosis from '../../src/lib/run-diagnosis.cjs';

describe('run-diagnosis', () => {
  it('构造诊断 prompt 时只附带运行指标与任务状态', () => {
    const prompt = diagnosis.buildDiagnosisPrompt(
      { tokens: { total: 100, output: 20 }, elapsedMs: 1000 },
      { mode: 'run', currentState: 'CODE', tasks: [{ id: 'T1', status: 'active', exec: { startedAt: '2026-09-02T12:00:00.000Z' } }] },
    );

    expect(prompt).toContain('只输出 JSON');
    expect(prompt).toContain('"total": 100');
    expect(prompt).toContain('"id": "T1"');
    expect(prompt).not.toContain('result');
  });

  it('解析有效 JSON 并裁剪不受信任的字段', () => {
    const result = diagnosis.parseDiagnosis(JSON.stringify({
      severity: 'attention',
      summary: '任务存在阻塞。',
      findings: [{ title: '等待时间长', evidence: '总耗时 10 分钟', impact: '吞吐下降', recommendation: '检查子 Agent' }],
      dataGaps: ['缺少工具时长'],
      ignored: true,
    }));

    expect(result).toEqual({
      severity: 'attention',
      summary: '任务存在阻塞。',
      findings: [{ title: '等待时间长', evidence: '总耗时 10 分钟', impact: '吞吐下降', recommendation: '检查子 Agent' }],
      dataGaps: ['缺少工具时长'],
    });
  });

  it('拒绝不符合结构的 AI 响应', () => {
    expect(() => diagnosis.parseDiagnosis('{"summary":"缺少 findings"}')).toThrow('expected JSON structure');
  });
});
