import { API } from '@/shared/api/index.js';
import { useEffect, useRef, useState } from 'react';
import { useAction } from '@/shared/hooks/useAction.js';
import { aggregateDecisions, countPendingReview } from '@/pages/Decisions/model.js';
import { sortTasks } from '@/pages/Tasks/model.js';
export function useRunPage(props) {
  const { data, client, refresh } = props;
  const workflowSession =
    data.workspace?.sessions?.find(session => session.id === props.sessionId) || null;
  const tasks = sortTasks(
    data.workspace?.activeRequirement ? data.workspace.tasks || [] : data.state?.tasks || [],
  );
  const active = tasks.filter(t => t.status === 'active');
  const persistedRunActive =
    data.workspace?.sessions?.some(
      session =>
        session.requirementId === workflowSession?.requirementId &&
        session.kind === 'run' &&
        ['created', 'active'].includes(session.status),
    ) || false;
  const done = tasks.filter(t => t.status === 'done').length;
  const [input, setInput] = useState('');
  const output = useRef(null);
  const [follow, setFollow] = useState(true);
  useEffect(() => {
    if (follow && output.current) output.current.scrollTop = output.current.scrollHeight;
  }, [data.status?.snapshot, follow]);
  const { busy, message, action } = useAction(client, refresh);
  const pending = data.status?.decisionPending;
  const hasActiveRun =
    props.runs.some(r => ['running', 'queued'].includes(r.status)) || persistedRunActive;
  const canSend = data.status?.session && data.status?.state === 'ready';
  async function sendMessage() {
    const text = input.trim();
    if (!text) return;
    if (await action(pending ? API.respond : API.send, pending ? { value: text } : { text }))
      setInput('');
  }
  const toggleMode = () =>
    action(API.workflowMode, { mode: data.state.mode === 'pause' ? 'run' : 'pause' });
  const interrupt = () => action(API.stop, {});
  const respond = value => action(API.respond, { value: String(value) });
  // 决策：展示与复审的唯一入口在决策页，这里只给一行计数 + 跳转
  // （场景 2「上抛给人答」本版不做，run 期间没有需要人实时作答的东西，故不做弹窗）。
  const decisionEntries = data.decisions?.decisions || [];
  const decisionTotal = aggregateDecisions(decisionEntries).filter(e => e.completed).length;
  const pendingReview = countPendingReview(decisionEntries);
  const goDecisions = () => props.setView('decisions');
  return {
    sendMessage,
    toggleMode,
    interrupt,
    respond,
    decisionTotal,
    pendingReview,
    goDecisions,
    cancelRun: () => action(API.cancelRun(props.runId), {}),
    retryRun: async () => {
      const result = await action(API.retryRun(props.runId), {});
      if (result?.runId) props.setRunId(result.runId);
    },
    ...props,
    tasks,
    active,
    done,
    input,
    setInput,
    output,
    follow,
    setFollow,
    busy,
    message,
    action,
    pending,
    hasActiveRun,
    workflowSession,
    canSend,
  };
}
