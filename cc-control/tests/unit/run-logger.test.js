import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RunLogger } = require('../../src/server/run-logger.cjs');

describe('RunLogger', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-logger-test-'));
  });

  afterEach(() => {
    vi.restoreAllMocks(); // 恢复 os.homedir / fs.appendFileSync 等 spy
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── transcript 测试辅助 ──

  function makeLogger() {
    const awfDir = path.join(tmpDir, '.awf');
    fs.mkdirSync(awfDir, { recursive: true });
    fs.writeFileSync(path.join(awfDir, 'state.json'), JSON.stringify({ version: '0.1.0' }));
    const fakeHome = path.join(tmpDir, 'fake-home');
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    return new RunLogger(tmpDir);
  }

  function transcriptPath() {
    const slug = tmpDir.replace(/\//g, '-');
    return path.join(tmpDir, 'fake-home', '.claude', 'projects', slug, 'session.jsonl');
  }

  function assistantLine(texts) {
    const content = (Array.isArray(texts) ? texts : [texts]).map((t) => ({ type: 'text', text: t }));
    return JSON.stringify({ type: 'assistant', message: { content } });
  }

  // ── TC1: 正常初始化 ──

  it('TC1: 正常初始化 — 有 projectRoot + 有效 state.json', () => {
    const awfDir = path.join(tmpDir, '.awf');
    fs.mkdirSync(awfDir);
    fs.writeFileSync(path.join(awfDir, 'state.json'), JSON.stringify({ version: '0.1.0' }));

    const logger = new RunLogger(tmpDir);

    expect(logger.enabled).toBe(true);
    expect(logger.path).toContain('.awf/logs/0.1.0.log');

    // 日志目录已创建
    expect(fs.existsSync(path.join(awfDir, 'logs'))).toBe(true);

    // 日志文件包含头部
    const logContent = fs.readFileSync(logger.path, 'utf-8');
    expect(logContent).toContain('=== AWF Run Log ===');
    expect(logContent).toContain('version: 0.1.0');
    expect(logContent).toContain(`project: ${tmpDir}`);
    expect(logContent).toContain('started: ');
  });

  // ── TC2: projectRoot 为空字符串 ──

  it('TC2: projectRoot 为空字符串 → enabled=false', () => {
    const logger = new RunLogger('');

    expect(logger.enabled).toBe(false);
    expect(logger.path).toBeNull();
  });

  // ── TC3: projectRoot 为 null ──

  it('TC3: projectRoot 为 null → enabled=false', () => {
    const logger = new RunLogger(null);

    expect(logger.enabled).toBe(false);
    expect(logger.path).toBeNull();
  });

  // ── TC4: state.json 不存在 ──

  it('TC4: state.json 不存在 → enabled=false', () => {
    const logger = new RunLogger(tmpDir);

    expect(logger.enabled).toBe(false);
    expect(logger.path).toBeNull();
  });

  // ── TC5: state.json 无 version 字段 ──

  it('TC5: state.json 无 version 字段 → enabled=false', () => {
    const awfDir = path.join(tmpDir, '.awf');
    fs.mkdirSync(awfDir);
    fs.writeFileSync(path.join(awfDir, 'state.json'), JSON.stringify({ mode: 'idle' }));

    const logger = new RunLogger(tmpDir);

    expect(logger.enabled).toBe(false);
  });

  // ── TC6: state.json 非法 JSON ──

  it('TC6: state.json 非法 JSON → enabled=false', () => {
    const awfDir = path.join(tmpDir, '.awf');
    fs.mkdirSync(awfDir);
    fs.writeFileSync(path.join(awfDir, 'state.json'), '{broken');

    const logger = new RunLogger(tmpDir);

    expect(logger.enabled).toBe(false);
  });

  // ── TC7: logPrompt 格式 ──

  it('TC7: logPrompt 格式验证', () => {
    const awfDir = path.join(tmpDir, '.awf');
    fs.mkdirSync(awfDir);
    fs.writeFileSync(path.join(awfDir, 'state.json'), JSON.stringify({ version: '0.1.0' }));

    const logger = new RunLogger(tmpDir);
    logger.logPrompt('请实现功能 X');

    const content = fs.readFileSync(logger.path, 'utf-8');
    // 60 个 ─ 分隔线
    expect(content).toContain('─'.repeat(60));
    // 时间戳 + 提示词标签
    expect(content).toMatch(/\[\d{2}:\d{2}:\d{2}\] 提示词/);
    expect(content).toContain('请实现功能 X');
  });

  // ── TC8: logResponse 格式 ──

  it('TC8: logResponse 格式验证', () => {
    const awfDir = path.join(tmpDir, '.awf');
    fs.mkdirSync(awfDir);
    fs.writeFileSync(path.join(awfDir, 'state.json'), JSON.stringify({ version: '0.1.0' }));

    const logger = new RunLogger(tmpDir);
    logger.logResponse('已完成功能 X');

    const content = fs.readFileSync(logger.path, 'utf-8');
    expect(content).toMatch(/\[\d{2}:\d{2}:\d{2}\] 回答/);
    expect(content).toContain('已完成功能 X');
    // RESPONSE 不应有分隔线
    const afterHeader = content.split('\n\n').slice(1).join('\n\n');
    expect(afterHeader).not.toContain('─'.repeat(60));
  });

  // ── TC9: logChoice 格式 ──

  it('TC9: logChoice 格式验证', () => {
    const awfDir = path.join(tmpDir, '.awf');
    fs.mkdirSync(awfDir);
    fs.writeFileSync(path.join(awfDir, 'state.json'), JSON.stringify({ version: '0.1.0' }));

    const logger = new RunLogger(tmpDir);
    logger.logChoice('选择方案?', 'A方案');

    const content = fs.readFileSync(logger.path, 'utf-8');
    expect(content).toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
    expect(content).toContain('Q: 选择方案?');
    expect(content).toContain('A: A方案');
  });

  // ── TC10: enabled=false 时写入被跳过 ──

  it('TC10: enabled=false 时写入被跳过', () => {
    const logger = new RunLogger(null);

    // These should not throw
    logger.logPrompt('test');
    logger.logResponse('test');
    logger.logChoice('Q', 'A');
    logger.captureFromTranscript();

    expect(logger.enabled).toBe(false);
  });

  // ── TC11: _append 异常不抛出 ──

  it('TC11: _append 异常不抛出（错误被 console.error 捕获）', () => {
    const awfDir = path.join(tmpDir, '.awf');
    fs.mkdirSync(awfDir);
    fs.writeFileSync(path.join(awfDir, 'state.json'), JSON.stringify({ version: '0.1.0' }));

    const logger = new RunLogger(tmpDir);

    // 强制 appendFileSync 抛错，验证 _append 的 catch 分支真正执行
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const appendSpy = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    expect(() => logger.logPrompt('test')).not.toThrow();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[run-logger] write error'));

    appendSpy.mockRestore();
    errSpy.mockRestore();
  });

  // ── TC17: 日志头格式验证 ──

  it('TC17: 日志头格式验证', () => {
    const awfDir = path.join(tmpDir, '.awf');
    fs.mkdirSync(awfDir);
    fs.writeFileSync(path.join(awfDir, 'state.json'), JSON.stringify({ version: '0.2.0' }));

    const logger = new RunLogger(tmpDir);
    const content = fs.readFileSync(logger.path, 'utf-8');

    const lines = content.split('\n');
    expect(lines[0]).toBe('=== AWF Run Log ===');
    expect(lines[1]).toBe('version: 0.2.0');
    expect(lines[2]).toMatch(/^started: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(lines[3]).toBe(`project: ${tmpDir}`);
    expect(lines[4]).toBe('');
  });

  // ── TC18: 版本号来自 state.json ──

  it('TC18: 版本号来自 state.json', () => {
    const awfDir = path.join(tmpDir, '.awf');
    fs.mkdirSync(awfDir);
    fs.writeFileSync(path.join(awfDir, 'state.json'), JSON.stringify({ version: '1.0.0' }));

    const logger = new RunLogger(tmpDir);

    expect(logger.path).toContain('1.0.0.log');
    const content = fs.readFileSync(logger.path, 'utf-8');
    expect(content).toContain('version: 1.0.0');
  });

  // ── transcript 捕获（TC12–TC16, TC19–TC20）──

  it('TC12: 增量捕获 — 只追加新内容，不重复', () => {
    const logger = makeLogger();
    fs.mkdirSync(path.dirname(transcriptPath()), { recursive: true });
    fs.writeFileSync(transcriptPath(), assistantLine('hello') + '\n');
    logger.captureFromTranscript();
    const after1 = fs.readFileSync(logger.path, 'utf-8');
    expect(after1).toContain('回答');
    expect(after1).toContain('hello');

    fs.appendFileSync(transcriptPath(), assistantLine('world') + '\n');
    logger.captureFromTranscript();
    const after2 = fs.readFileSync(logger.path, 'utf-8');
    expect(after2).toContain('world');
    expect(after2.match(/hello/g)).toHaveLength(1); // hello 只记录一次
  });

  it('TC13: 无新内容 → 跳过', () => {
    const logger = makeLogger();
    fs.mkdirSync(path.dirname(transcriptPath()), { recursive: true });
    fs.writeFileSync(transcriptPath(), assistantLine('hello') + '\n');
    logger.captureFromTranscript();
    const before = fs.readFileSync(logger.path, 'utf-8');
    logger.captureFromTranscript(); // 无新内容
    expect(fs.readFileSync(logger.path, 'utf-8')).toBe(before);
  });

  it('TC14: transcript 文件不存在 → 不抛', () => {
    const logger = makeLogger();
    expect(() => logger.captureFromTranscript()).not.toThrow();
  });

  it('TC15: 非 assistant 行跳过', () => {
    const logger = makeLogger();
    fs.mkdirSync(path.dirname(transcriptPath()), { recursive: true });
    const userLine = JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'USER TEXT' }] } });
    fs.writeFileSync(transcriptPath(), userLine + '\n');
    logger.captureFromTranscript();
    expect(fs.readFileSync(logger.path, 'utf-8')).not.toContain('USER TEXT');
  });

  it('TC16: 多 text block 拼接', () => {
    const logger = makeLogger();
    fs.mkdirSync(path.dirname(transcriptPath()), { recursive: true });
    fs.writeFileSync(transcriptPath(), assistantLine(['a', 'b']) + '\n');
    logger.captureFromTranscript();
    expect(fs.readFileSync(logger.path, 'utf-8')).toContain('ab');
  });

  it('TC19: slug 路径解析 — transcript 文件在 slug 目录中被找到', () => {
    const logger = makeLogger();
    fs.mkdirSync(path.dirname(transcriptPath()), { recursive: true });
    fs.writeFileSync(transcriptPath(), assistantLine('slug-ok') + '\n');
    logger.captureFromTranscript();
    expect(fs.readFileSync(logger.path, 'utf-8')).toContain('slug-ok');
  });

  it('TC20: sessionStartTime 过滤 — 早于会话开始的文件被跳过', () => {
    const logger = makeLogger();
    fs.mkdirSync(path.dirname(transcriptPath()), { recursive: true });
    fs.writeFileSync(transcriptPath(), assistantLine('stale') + '\n');
    // 明确把文件 mtime 设为过去时间，避免与 sessionStartTime 同一毫秒导致的竞争
    const past = new Date(Date.now() - 60000);
    fs.utimesSync(transcriptPath(), past, past);
    // resetTranscript 将会话开始时间设为「现在」，晚于文件 mtime → 过滤
    logger.resetTranscript();
    logger.captureFromTranscript();
    expect(fs.readFileSync(logger.path, 'utf-8')).not.toContain('stale');
  });
});
