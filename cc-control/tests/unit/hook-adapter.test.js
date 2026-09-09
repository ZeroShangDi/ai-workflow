import { describe, it, expect } from 'vitest';
import { translateHook, createHookAdapter } from '../../src/server/hook-adapter.cjs';

// hook→领域事件翻译接缝（W1-031/046）：/hook 收口为 adapter.hook + 事件上抛（cc 细节最小承接 → 完整字段透传）。

describe('translateHook', () => {
  it('SessionStart → run.started；Stop → run.stopped', () => {
    const a = translateHook({ hook_event_name: 'SessionStart', session_id: 's1' });
    expect(a).toHaveLength(1);
    expect(a[0].type).toBe('run.started');
    const b = translateHook({ hook_event_name: 'Stop' });
    expect(b[0].type).toBe('run.stopped');
  });

  it('cc 细节字段透传到事件 payload.cc（字段段收口在 adapter）', () => {
    const e = translateHook({ hook_event_name: 'Stop', session_id: 's1', stop_hook_active: true, last_assistant_message: 'hi', tool_input: { q: 1 } })[0];
    expect(e.payload.cc).toEqual({ session_id: 's1', stop_hook_active: true, last_assistant_message: 'hi', tool_input: { q: 1 } });
  });

  it('SubagentStart/Stop → agent.started/stopped（带 agentId/taskId）', () => {
    const s = translateHook({ hook_event_name: 'SubagentStart', session_id: 'a1', agent_transcript_path: '/x' })[0];
    expect(s.type).toBe('agent.started');
    expect(s.payload.agentId).toBe('/x');
    const st = translateHook({ hook_event_name: 'SubagentStop', session_id: 'a2', task_id: 'T1' })[0];
    expect(st.type).toBe('agent.stopped');
    expect(st.payload.taskId).toBe('T1');
  });

  it('UserPromptSubmit → run.phase；PreToolUse/PostToolUse/未知 → 空', () => {
    expect(translateHook({ hook_event_name: 'UserPromptSubmit' })[0].type).toBe('run.phase');
    expect(translateHook({ hook_event_name: 'PreToolUse' })).toEqual([]);
    expect(translateHook({ hook_event_name: 'PostToolUse' })).toEqual([]);
    expect(translateHook({})).toEqual([]);
    expect(translateHook(null)).toEqual([]);
  });
});

describe('createHookAdapter', () => {
  it('.hook 翻译并 emit（带 runId），返回事件数；未知 hook 不 emit', () => {
    const emitted = [];
    const adapter = createHookAdapter({ emit: (e) => emitted.push(e) });
    const n = adapter.hook({ hook_event_name: 'SubagentStop', session_id: 'a1' }, { runId: 'r1' });
    expect(n).toBe(1);
    expect(emitted[0].type).toBe('agent.stopped');
    expect(emitted[0].runId).toBe('r1');
    expect(adapter.hook({ hook_event_name: 'PreToolUse' })).toBe(0);
    expect(emitted).toHaveLength(1);
  });

  it('缺 emit 抛错', () => {
    expect(() => createHookAdapter({})).toThrowError(/emit 须为函数/);
  });
});
