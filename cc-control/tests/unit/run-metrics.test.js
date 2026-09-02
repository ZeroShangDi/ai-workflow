import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRunMetrics, resetRunMeta, updateRunMeta } from '../../src/lib/run-metrics.js';

let tmpRoot;
let homeDir;
let originalHome;

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n'));
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-run-metrics-'));
  homeDir = path.join(tmpRoot, 'home');
  fs.mkdirSync(homeDir, { recursive: true });
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('run-metrics', () => {
  it('单 agent：聚合主 transcript usage + context usage + elapsed', () => {
    const projectRoot = path.join(tmpRoot, 'project');
    const slug = projectRoot.replace(/\//g, '-');
    const now = Date.parse('2026-09-02T12:00:00.000Z');

    writeJson(path.join(projectRoot, '.awf', 'state.json'), {
      mode: 'run',
      currentState: 'CODE',
      tasks: [{ id: 'T1', status: 'active', exec: { startedAt: '2026-09-02T11:59:00.000Z' } }],
    });
    writeJson(path.join(projectRoot, '.awf', 'config.json'), { run: { agents: { max: 1 } } });
    writeJson(path.join(projectRoot, '.awf', 'context', 'usage.json'), {
      used_percentage: 61,
      remaining_percentage: 39,
      context_window_size: 200000,
      total_input_tokens: 122000,
      updatedAt: '2026-09-02T11:59:59.000Z',
    });
    resetRunMeta(projectRoot);
    updateRunMeta(projectRoot, (meta) => ({
      ...meta,
      startedAt: '2026-09-02T11:58:00.000Z',
      mainSessionId: 'sess-main',
    }));
    writeJsonl(path.join(homeDir, '.claude', 'projects', slug, 'sess-main.jsonl'), [
      {
        type: 'assistant',
        uuid: 'u1',
        timestamp: '2026-09-02T11:59:40.000Z',
        message: {
          id: 'm1',
          usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 },
        },
      },
      {
        type: 'assistant',
        uuid: 'u2',
        timestamp: '2026-09-02T11:59:45.000Z',
        message: {
          id: 'm1',
          usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 },
        },
      },
      {
        type: 'assistant',
        uuid: 'u3',
        timestamp: '2026-09-02T11:59:55.000Z',
        message: {
          id: 'm2',
          usage: { input_tokens: 40, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
    ]);

    const metrics = readRunMetrics(projectRoot, { nowMs: now, mainSessionId: 'sess-main', activeAgents: 0 });
    expect(metrics.agentMode).toBe('single');
    expect(metrics.tokens.input).toBe(140);
    expect(metrics.tokens.output).toBe(30);
    expect(metrics.tokens.total).toBe(170);
    expect(metrics.tokens.coverage).toBe('exact');
    expect(metrics.context.usedPercentage).toBe(61);
    expect(metrics.context.ratio).toBeCloseTo(0.61);
    expect(metrics.elapsedMs).toBe(120000);
    expect(metrics.outputSpeed.currentTokensPerSecond).toBeGreaterThan(0);
  });

  it('多 agent：聚合主 transcript + 子 agent transcript，运行中子 agent 标 partial', () => {
    const projectRoot = path.join(tmpRoot, 'project-multi');
    const slug = projectRoot.replace(/\//g, '-');
    const now = Date.parse('2026-09-02T12:00:00.000Z');

    writeJson(path.join(projectRoot, '.awf', 'state.json'), {
      mode: 'run',
      currentState: 'CODE',
      tasks: [],
    });
    writeJson(path.join(projectRoot, '.awf', 'config.json'), { run: { agents: { max: 3 } } });
    resetRunMeta(projectRoot);
    updateRunMeta(projectRoot, (meta) => ({
      ...meta,
      startedAt: '2026-09-02T11:50:00.000Z',
      mainSessionId: 'sess-main',
      subagents: {
        'agent-1': {
          agentId: 'agent-1',
          status: 'stopped',
          transcriptPath: path.join(tmpRoot, 'agent-1.jsonl'),
        },
        'agent-2': {
          agentId: 'agent-2',
          status: 'running',
          transcriptPath: null,
        },
      },
    }));
    writeJsonl(path.join(homeDir, '.claude', 'projects', slug, 'sess-main.jsonl'), [
      {
        type: 'assistant',
        uuid: 'u1',
        timestamp: '2026-09-02T11:59:30.000Z',
        message: {
          id: 'm1',
          usage: { input_tokens: 80, output_tokens: 12, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
    ]);
    writeJsonl(path.join(tmpRoot, 'agent-1.jsonl'), [
      {
        type: 'assistant',
        uuid: 'u2',
        timestamp: '2026-09-02T11:59:20.000Z',
        message: {
          id: 'm2',
          usage: { input_tokens: 50, output_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
    ]);

    const metrics = readRunMetrics(projectRoot, { nowMs: now, mainSessionId: 'sess-main', activeAgents: 1 });
    expect(metrics.agentMode).toBe('multi');
    expect(metrics.tokens.input).toBe(130);
    expect(metrics.tokens.output).toBe(20);
    expect(metrics.tokens.total).toBe(150);
    expect(metrics.tokens.coverage).toBe('partial');
    expect(metrics.tokens.missingSubagentTranscripts).toBe(1);
  });
});
