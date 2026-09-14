import './styles.css';
import { Button, Textarea } from '../../../../shared/components/ui/index.js';
import Badge from '../../../../shared/components/business/StatusBadge/index.jsx';
import { display } from '../../../../shared/lib/format.js';
export default function RunComposer({
  pending,
  busy,
  input,
  setInput,
  follow,
  setFollow,
  data,
  hasActiveRun,
  tasks,
  message,
  canSend,
  sendMessage,
  startRun,
  toggleMode,
  interrupt,
  respond
}) {
  return (<>
    {pending && <section className="pending-card">
      <h3>{pending.question}</h3>
      {(pending.options || []).map((option, i) => <Button key={i} disabled={busy} onClick={() => respond(i + 1)}>{display(option)}</Button>)}
    </section>}
    <form className="composer" onSubmit={e => {
      e.preventDefault();
      sendMessage();
    }}>
      <div className="actions">
        {!follow && <Button type="button" onClick={() => setFollow(true)}>回到最新输出</Button>}
        <Badge value={data.state?.mode} />
        {!hasActiveRun && tasks.some(t => t.status === 'pending') && <Button type="button" disabled={busy} onClick={startRun}>启动 Run</Button>}
        {['run', 'pause'].includes(data.state?.mode) && <Button type="button" disabled={busy} onClick={toggleMode}>{data.state.mode === 'pause' ? '恢复运行' : '暂停调度'}</Button>}
        {data.status?.session && <Button type="button" disabled={busy} onClick={interrupt}>打断当前响应</Button>}
      </div>
      <div className="composer-box">
        <Textarea aria-label="消息" value={input} onChange={e => setInput(e.target.value)} placeholder={pending ? '输入回复…' : '补充执行要求…'} />
        <div className="actions">
          <span role="status" className="muted">{message || (canSend ? '会话就绪' : '等待会话就绪')}</span>
          <Button variant="primary" disabled={busy || !input.trim() || !pending && !canSend}>发送</Button>
        </div>
      </div>
    </form>
  </>);
}
