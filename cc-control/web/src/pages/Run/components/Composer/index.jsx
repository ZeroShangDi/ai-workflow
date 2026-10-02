import './styles.css';
import { Button, Textarea } from '@/shared/components/ui/index.js';
import Badge from '@/shared/components/business/StatusBadge/index.jsx';
import { display } from '@/shared/lib/format.js';
export default function RunComposer({
  run,
  cancelRun,
  retryRun,
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
  workflowSession,
  sendMessage,
  toggleMode,
  interrupt,
  respond,
}) {
  const isRunSession = workflowSession?.kind === 'run';
  return (
    <>
      {pending && (
        <section className="pending-card">
          <h3>{pending.question}</h3>
          {(pending.options || []).map((option, i) => (
            <Button key={i} disabled={busy} onClick={() => respond(i + 1)}>
              {display(option)}
            </Button>
          ))}
        </section>
      )}
      <form
        className="composer"
        onSubmit={e => {
          e.preventDefault();
          sendMessage();
        }}>
        <div className="actions">
          {!follow && (
            <Button type="button" onClick={() => setFollow(true)}>
              回到最新输出
            </Button>
          )}
          {isRunSession && <Badge value={data.state?.mode} />}
          {workflowSession && <small role="status">持久化会话：{workflowSession.status}</small>}
          {isRunSession && run?.status === 'running' && (
            <Button type="button" disabled={busy} onClick={cancelRun}>
              取消运行
            </Button>
          )}
          {isRunSession && ['failed', 'cancelled'].includes(run?.status) && (
            <Button type="button" disabled={busy || hasActiveRun} onClick={retryRun}>
              重试运行
            </Button>
          )}
          {isRunSession && ['run', 'pause'].includes(data.state?.mode) && (
            <Button type="button" disabled={busy} onClick={toggleMode}>
              {data.state.mode === 'pause' ? '恢复运行' : '暂停调度'}
            </Button>
          )}
          {data.status?.session && (
            <Button
              type="button"
              disabled={busy || (data.status?.state !== 'busy' && !pending)}
              onClick={interrupt}>
              打断当前响应
            </Button>
          )}
        </div>
        <div className="composer-box">
          <Textarea
            aria-label="消息"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder={pending ? '输入回复…' : workflowSession?.kind === 'plan' ? '补充或修改本需求的 Plan…' : '补充执行要求…'}
          />
          <div className="actions">
            <span role="status" className="muted">
              {message || (canSend ? '会话就绪' : '等待会话就绪')}
            </span>
            <Button variant="primary" disabled={busy || !input.trim() || (!pending && !canSend)}>
              发送
            </Button>
          </div>
        </div>
      </form>
    </>
  );
}
