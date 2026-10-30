import './styles.css';
import { useEffect, useMemo, useState } from 'react';
import { Button, Textarea } from '@/shared/components/ui/index.js';
import Badge from '@/shared/components/business/StatusBadge/index.jsx';
import { display } from '@/shared/lib/format.js';
const optionLabel = option => typeof option === 'string' ? option : option?.label || '';
const optionDescription = option => typeof option === 'object' && option ? option.description || '' : '';
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
  message,
  canSend,
  workflowSession,
  sendMessage,
  toggleMode,
  interrupt,
}) {
  const isRunSession = workflowSession?.kind === 'run';
  const [selectedAnswers, setSelectedAnswers] = useState({});
  const questionItems = useMemo(() => pending?.questions?.length
    ? pending.questions
    : pending ? [{ question: pending.question, options: pending.options || [] }] : [], [pending]);
  useEffect(() => { setSelectedAnswers({}); }, [pending?.decisionId, pending?.question]);
  useEffect(() => {
    const answered = questionItems.flatMap((question, index) => {
      const answer = selectedAnswers[index];
      return answer ? [`${question.header ? `${question.header}: ` : ''}${question.question}：${answer}`] : [];
    });
    if (answered.length) setInput(answered.join('\n'));
  }, [questionItems, selectedAnswers, setInput]);
  return (
    <>
      {pending && (
        <section className="pending-card">
          {questionItems.map((question, questionIndex) => <div className="pending-question" key={`${question.header || ''}:${questionIndex}`}>
            {question.header && <small className="muted">{question.header}</small>}
            <h3>{question.question}</h3>
            {(question.options || []).map((option, i) => (
              <Button type="button" key={i} disabled={busy} className={selectedAnswers[questionIndex] === optionLabel(option) ? 'selected' : ''} onClick={() => setSelectedAnswers(old => ({ ...old, [questionIndex]: optionLabel(option) }))}>
                <strong>{optionLabel(option) || display(option)}</strong>
                {optionDescription(option) && <small>{optionDescription(option)}</small>}
              </Button>
            ))}
          </div>)}
        </section>
      )}
      <form
        className="composer"
        onSubmit={e => {
          e.preventDefault();
          sendMessage();
        }}>
        <div className="actions">
          <Button type="button" className="composer-attach-placeholder" disabled title="本机终端集成暂不可用">查看 CC 运行</Button>
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
