import { API } from '../../../shared/api/index.js';
import { useEffect, useRef, useState } from 'react';
import { useAction } from '../../../shared/hooks/useAction.js';
export function useRunPage(props) {
  const {
    data,
    client,
    refresh,
    events
  } = props;
  const tasks = data.state?.tasks || [],
    active = tasks.filter(t => t.status === 'active');
  const done = tasks.filter(t => t.status === 'done').length;
  const [input, setInput] = useState('');
  const output = useRef(null);
  const [follow, setFollow] = useState(true);
  useEffect(() => {
    if (follow && output.current) output.current.scrollTop = output.current.scrollHeight;
  }, [data.status?.snapshot, events, follow]);
  const {
    busy,
    message,
    action
  } = useAction(client, refresh);
  const pending = data.status?.decisionPending;
  const hasActiveRun = props.runs.some(r => ['running', 'queued'].includes(r.status));
  const canSend = data.status?.session && data.status?.state === 'ready';
  async function sendMessage() {
    const text = input.trim();
    if (!text) return;
    if (await action(pending ? API.respond : API.send, pending ? { value: text } : { text })) setInput('');
  }
  async function startRun() {
    const runId = `web-${Date.now()}`;
    if (await action(API.submitRun, { runId })) props.setRunId(runId);
  }
  const toggleMode = () => action(API.workflowMode, { mode: data.state.mode === 'pause' ? 'run' : 'pause' });
  const interrupt = () => action(API.stop, {});
  const respond = value => action(API.respond, { value: String(value) });
  return {
    sendMessage, startRun, toggleMode, interrupt, respond,
    cancelRun: () => action(API.cancelRun(props.runId), {}),
    retryRun: async () => { const result = await action(API.retryRun(props.runId), {}); if (result?.runId) props.setRunId(result.runId); },
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
    canSend
  };
}
