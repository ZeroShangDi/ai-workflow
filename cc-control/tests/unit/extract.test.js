import { describe, it, expect } from 'vitest';
import {
  parseSubagentResult,
  parseNeedsInput,
  parseTranscriptLine,
  entryParts,
  renderTranscriptText,
} from '../../src/lib/extract.cjs';

// cc 产物提取迁入（W1-048）：RESULT/NEEDS_INPUT/transcript 行级提取单源。

describe('parseSubagentResult / parseNeedsInput', () => {
  it('RESULT 解析（taskId/status）；非法返回 null', () => {
    const r = parseSubagentResult('先做\nRESULT: {"taskId":"T1","status":"done","files":["a.js"]}');
    expect(r.taskId).toBe('T1');
    expect(r.status).toBe('done');
    expect(r.files).toEqual(['a.js']);
    expect(parseSubagentResult('普通文本')).toBeNull();
    expect(parseSubagentResult('RESULT: {"taskId":1}')).toBeNull(); // 非法 taskId 类型
    expect(parseSubagentResult('RESULT: {"taskId":"T1","status":"nope"}')).toBeNull();
  });

  it('NEEDS_INPUT 解析（含 options/context）', () => {
    const n = parseNeedsInput('RESULT? no\nNEEDS_INPUT: {"taskId":"T1","question":"选?","options":["A","B"],"context":"ctx"}');
    expect(n.taskId).toBe('T1');
    expect(n.options).toEqual(['A', 'B']);
    expect(parseNeedsInput('x')).toBeNull();
  });
});

describe('transcript 提取', () => {
  const jsonl = [
    JSON.stringify({ type: 'assistant', timestamp: '2026-09-07T10:00:01.000Z', message: { content: [{ type: 'text', text: '你好' }] } }),
    JSON.stringify({ type: 'user', message: { content: '提示' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }),
    'not-json',
  ].join('\n');

  it('parseTranscriptLine：坏行/空行 null，好行 entry', () => {
    expect(parseTranscriptLine('not-json')).toBeNull();
    expect(parseTranscriptLine('')).toBeNull();
    expect(parseTranscriptLine('   ')).toBeNull();
    expect(parseTranscriptLine(JSON.stringify({ type: 'user' })).type).toBe('user');
  });

  it('renderTranscriptText：assistant text/tool_use 渲染为人读文本，坏行跳过', () => {
    const out = renderTranscriptText(jsonl);
    expect(out).toContain('回答');
    expect(out).toContain('你好');
    expect(out).toContain('调用工具: Bash');
    expect(out).toContain('提示词');
    expect(out).not.toContain('not-json');
    expect(out).toContain('[10:00:01]');
  });

  it('entryParts：无 role/无内容 → null', () => {
    expect(entryParts({ type: 'assistant' })).toBeNull();
    expect(entryParts(null)).toBeNull();
  });
});
