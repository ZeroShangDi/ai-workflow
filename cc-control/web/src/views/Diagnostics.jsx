// web/src/views/Diagnostics.jsx — Diagnostics 视图（诊断触发 + 展示：指标快照 / AI 诊断结论 / Token / 覆盖范围）。
// T1-089：经 server api（GET /awf/metrics + GET /awf/diagnostics，POST /awf/diagnostics 触发诊断）驱动，轮询刷新。
import { useEffect, useMemo, useState } from 'react';
import { createApiClient } from '../api/client.js';
import { toDiagnosticsModel, fmtTokens, fmtDuration, statusLabel, severityLabel } from './diagnostics-model.js';

export default function Diagnostics({ sid } = {}) {
  const client = useMemo(() => createApiClient({ sid: sid || undefined }), [sid]);
  const [model, setModel] = useState(toDiagnosticsModel());
  const [busy, setBusy] = useState(false); // 触发诊断中
  const [actionError, setActionError] = useState(null);

  async function refresh() {
    const [metrics, diagnosis] = await Promise.all([
      client.get('/awf/metrics').catch(() => null),
      client.get('/awf/diagnostics').catch(() => null),
    ]);
    setModel(toDiagnosticsModel({ metrics, diagnosis }));
  }

  useEffect(() => {
    refresh();
    // T1-091 事件订阅：run/task 推送即刷新；诊断「分析中」期间无对应事件，保留 2s 轮询，
    // 其余状态走 10s 心跳兜底（刷新主通道为事件推送）。
    const timer = setInterval(refresh, model.diagnosisStatus === 'running' ? 2000 : 10000);
    const ws = client.stream('/run/events');
    ws.onmessage = (e) => {
      try { if (JSON.parse(e.data)?.type) refresh(); } catch { /* ignore */ }
    };
    return () => { clearInterval(timer); try { ws.close(); } catch { /* ignore */ } };
  }, [client, model.diagnosisStatus]);

  async function trigger() {
    setBusy(true);
    setActionError(null);
    const r = await client.post('/awf/diagnostics').catch(() => null);
    setBusy(false);
    if (r && r.ok) { refresh(); return; }
    setActionError((r && r.error) || '诊断提交失败');
  }

  const t = model.tokens;
  const ctxMeta = model.context
    ? `${fmtTokens(model.context.totalInputTokens)}/${fmtTokens(model.context.contextWindowSize)} tokens`
    : '';
  const coverageText = model.totalTranscripts
    ? `${model.coveredTranscripts ?? 0}/${model.totalTranscripts}`
    : '—';

  return (
    <main className="diagnostics">
      <header>
        <h1>AWF Diagnostics</h1>
        <span className={model.diagnosisStatus}>{statusLabel(model.diagnosisStatus)}</span>
        <span className="muted">{model.hasMetrics ? '快照数据' : '无运行数据'}</span>
      </header>

      {actionError && <div className="error">诊断提交失败：{actionError}</div>}

      <section className="summary">
        <div className="card"><div className="label">总 Token</div><div className="value">{fmtTokens(t.total)}</div><div className="meta">输入 {fmtTokens(t.input)} · 输出 {fmtTokens(t.output)}</div></div>
        <div className="card"><div className="label">端到端吞吐</div><div className="value">{model.throughput != null ? `${model.throughput.toFixed(2)} tok/s` : '—'}</div><div className="meta">{model.throughputBasis || '不等同模型流式速度'}</div></div>
        <div className="card"><div className="label">总耗时</div><div className="value">{fmtDuration(model.elapsedMs)}</div><div className="meta">{model.activeAgents != null ? `${model.activeAgents} 个 Agent 运行中` : '—'}</div></div>
        <div className="card"><div className="label">上下文</div><div className="value">{model.context ? `${model.context.usedPercentage ?? '—'}%` : '—'}</div><div className="meta">{ctxMeta}</div></div>
      </section>

      <section className="diagnosis-block">
        {model.result ? (
          <div className={`result ${model.result.severity}`}>
            <div className="result-title">
              <h2>AI 诊断结论</h2>
              <span className="badge">{severityLabel(model.result.severity)}</span>
            </div>
            <p>{model.result.summary}</p>
            {model.result.findings.length > 0 && (
              <div className="findings">
                {model.result.findings.map((f, i) => (
                  <article key={i} className="finding">
                    <h3>{f.title}</h3>
                    <p><strong>证据：</strong>{f.evidence}</p>
                    <p><strong>影响：</strong>{f.impact}</p>
                    <p><strong>建议：</strong>{f.recommendation}</p>
                  </article>
                ))}
              </div>
            )}
            {model.result.dataGaps.length > 0 && (
              <ul className="gaps">{model.result.dataGaps.map((g, i) => <li key={i}>{g}</li>)}</ul>
            )}
          </div>
        ) : (
          <div className="empty">
            {model.diagnosisStatus === 'running' ? (
              <span>AI 正在基于当前快照诊断本次运行，页面会自动刷新。</span>
            ) : model.diagnosisStatus === 'failed' ? (
              <span>诊断失败：{model.diagnosisError || '未知错误'}</span>
            ) : (
              <span>尚未生成 AI 诊断。</span>
            )}
            <button onClick={trigger} disabled={busy || model.diagnosisStatus === 'running'}>
              {busy ? '诊断中…' : model.diagnosisStatus === 'failed' ? '重新诊断' : '诊断本次运行'}
            </button>
          </div>
        )}
      </section>

      <section className="panels">
        <div className="card"><h2>Token 明细</h2>
          <dl>
            <dt>输入</dt><dd>{fmtTokens(t.input)}</dd>
            <dt>输出</dt><dd>{fmtTokens(t.output)}</dd>
            <dt>缓存读取</dt><dd>{fmtTokens(t.cacheReadInput)}</dd>
            <dt>缓存写入</dt><dd>{fmtTokens(t.cacheCreationInput)}</dd>
            <dt>合计（不含缓存）</dt><dd>{fmtTokens(t.total)}</dd>
          </dl>
        </div>
        <div className="card"><h2>统计范围</h2>
          <dl>
            <dt>Agent 模式</dt><dd>{model.agentModeLabel || '—'}</dd>
            <dt>统计状态</dt><dd>{model.tokenCoverage || '—'}</dd>
            <dt>已覆盖 transcript</dt><dd>{coverageText}</dd>
            <dt>未提供子 Agent transcript</dt><dd>{model.missingSubagentTranscripts ?? '—'}</dd>
            <dt>运行中 Agent</dt><dd>{model.maxAgents != null ? `${model.activeAgents ?? 0}/${model.maxAgents}` : '—'}</dd>
          </dl>
        </div>
      </section>
    </main>
  );
}
