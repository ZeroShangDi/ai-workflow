import { useState } from 'react';
import RunSelect from '@/shared/components/business/RunSelect/index.jsx';
import { display, label, formatTime } from '@/shared/lib/format.js';
import '@/shared/components/business/workflow.css';
export default function RunOutput({ data, output, setFollow, events, runId, ...selection }) {
  const [source, setSource] = useState('conversation');
  return (
    <>
      <header className="pane-header">
        <div className="run-identity">
          <span className="status-dot" />
          <h1>Run 对话</h1>
        </div>
        <RunSelect {...selection} />
      </header>
      <div className="toolbar">
        <select aria-label="会话展示" value={source} onChange={e => setSource(e.target.value)}>
          <option value="conversation">结构化会话</option>
          <option value="session">当前会话输出</option>
          <option value="original">项目真实日志</option>
        </select>
        <small className="muted">会话属于当前项目；Run 筛选仅影响编排事件</small>
      </div>
      <div
        className="output-area"
        ref={output}
        onScroll={e => {
          const n = e.currentTarget;
          setFollow(n.scrollHeight - n.scrollTop - n.clientHeight < 48);
        }}>
        {source === 'conversation' ? (
          <>
            {(data.conversation?.messages || []).map(m => (
              <article className="conversation-card" data-role={m.role} key={m.id}>
                <small>
                  {m.role === 'user' ? '你' : m.role === 'tool' ? '工具 / 执行' : 'cc-work'} ·{' '}
                  {m.status ? label(m.status) : m.role === 'tool' ? '执行记录' : '消息'} ·{' '}
                  {formatTime(m.at)}
                </small>
                {m.title && <h3>{m.title}</h3>}
                <p>{m.text}</p>
              </article>
            ))}
            {!data.conversation?.messages?.length && (
              <p className="muted">暂无会话。提交需求或发送消息开始。</p>
            )}
          </>
        ) : source === 'original' ? (
          <>
            <p className="muted">
              来源：{data.sourceLog?.source} · 项目历史决策日志，非完整聊天转录
            </p>
            <pre className="terminal">{data.sourceLog?.text || '暂无原始日志'}</pre>
          </>
        ) : (
          <pre className="terminal">{data.status?.snapshot || '暂无会话输出，等待执行更新。'}</pre>
        )}
        <div className="event-tail">
          {events
            .filter(e => !runId || e.runId === runId)
            .slice(-12)
            .map(e => (
              <div key={e.seq}>
                <span className="muted">{e.type}</span> {display(e.payload)}
              </div>
            ))}
        </div>
      </div>
    </>
  );
}
