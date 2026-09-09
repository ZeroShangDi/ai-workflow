import { describe, it, expect } from 'vitest';
import { toDiagnosticsModel, fmtTokens, fmtDuration, statusLabel, severityLabel } from '../../web/src/views/diagnostics-model.js';

// T1-089：Diagnostics 视图模型（server 指标快照 + 诊断记录 → 展示模型，纯逻辑可测）。

function metricsResponse() {
  return {
    ok: true,
    metrics: {
      agentMode: 'single',
      activeAgents: 1,
      maxAgents: 1,
      elapsedMs: 65_000,
      startedAt: '2026-09-09T00:00:00.000Z',
      tokens: {
        total: 123_456, input: 50_000, output: 73_456,
        cacheReadInput: 300_000, cacheCreationInput: 10_000,
        coverage: 'partial', coveredTranscripts: 2, totalTranscripts: 3, missingSubagentTranscripts: 1,
      },
      outputSpeed: { currentTokensPerSecond: 12.34, averageTokensPerSecond: 8.2, basis: 'recent_60s' },
      context: { usedPercentage: 42, totalInputTokens: 300_000, contextWindowSize: 1_000_000 },
    },
  };
}

describe('toDiagnosticsModel', () => {
  it('metrics + complete 诊断 → 归一展示模型（指标/结论/findings/dataGaps）', () => {
    const diag = {
      ok: true,
      diagnosis: {
        status: 'complete',
        requestedAt: '2026-09-09T00:01:00.000Z',
        diagnosis: {
          severity: 'watch',
          summary: '输入 token 偏高',
          findings: [{ title: '上下文膨胀', evidence: '占用 42%', impact: '成本上升', recommendation: '压缩' }],
          dataGaps: ['无子 agent 明细'],
        },
      },
    };
    const m = toDiagnosticsModel({ metrics: metricsResponse(), diagnosis: diag });
    expect(m.diagnosisStatus).toBe('complete');
    expect(m.tokens.total).toBe(123_456);
    expect(m.tokens.cacheReadInput).toBe(300_000);
    expect(m.throughput).toBe(12.34);
    expect(m.throughputBasis).toBe('最近 60s 端到端吞吐');
    expect(m.context.usedPercentage).toBe(42);
    expect(m.agentModeLabel).toBe('单 Agent');
    expect(m.tokenCoverage).toBe('partial');
    expect(m.coveredTranscripts).toBe(2);
    expect(m.missingSubagentTranscripts).toBe(1);
    expect(m.result.severity).toBe('watch');
    expect(m.result.findings[0].title).toBe('上下文膨胀');
    expect(m.result.dataGaps).toEqual(['无子 agent 明细']);
  });

  it('running / failed / 无记录 → 状态与错误归一', () => {
    const running = toDiagnosticsModel({ diagnosis: { ok: true, diagnosis: { status: 'running' } } });
    expect(running.diagnosisStatus).toBe('running');
    expect(running.result).toBe(null);

    const failed = toDiagnosticsModel({ diagnosis: { ok: true, diagnosis: { status: 'failed', error: '超时' } } });
    expect(failed.diagnosisStatus).toBe('failed');
    expect(failed.diagnosisError).toBe('超时');

    const none = toDiagnosticsModel({});
    expect(none.diagnosisStatus).toBe('none');
    expect(none.result).toBe(null);
    expect(none.hasMetrics).toBe(false);
  });

  it('指标缺失 → 安全兜底（无抛错、throughput 取 average、缺省字段 null）', () => {
    const m = toDiagnosticsModel({
      metrics: { ok: true, metrics: { agentMode: 'multi', outputSpeed: { averageTokensPerSecond: 3, basis: 'average' } } },
    });
    expect(m.agentModeLabel).toBe('多 Agent');
    expect(m.throughput).toBe(3);
    expect(m.throughputBasis).toBe('全程端到端吞吐');
    expect(m.elapsedMs).toBe(null);
    expect(m.context).toBe(null);
    expect(m.tokens.total).toBe(null);
  });
});

describe('格式化/标签', () => {
  it('fmtTokens：k 紧凑、整数、非数值 → —', () => {
    expect(fmtTokens(1500)).toBe('1.5k');
    expect(fmtTokens(300000)).toBe('300k');
    expect(fmtTokens(1000)).toBe('1k');
    expect(fmtTokens(999)).toBe('999');
    expect(fmtTokens(null)).toBe('—');
    expect(fmtTokens('x')).toBe('—');
  });

  it('fmtDuration：h/m/s、非数值 → —', () => {
    expect(fmtDuration(9000)).toBe('9s');
    expect(fmtDuration(65_000)).toBe('1m 05s');
    expect(fmtDuration(3_660_000)).toBe('1h 01m 00s');
    expect(fmtDuration(undefined)).toBe('—');
  });

  it('statusLabel / severityLabel', () => {
    expect(statusLabel('running')).toBe('分析中');
    expect(statusLabel('none')).toBe('未诊断');
    expect(severityLabel('healthy')).toBe('健康');
    expect(severityLabel('attention')).toBe('需处理');
    expect(severityLabel('x')).toBe('x');
  });
});
