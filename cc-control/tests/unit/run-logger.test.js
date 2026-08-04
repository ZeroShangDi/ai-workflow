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
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

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

  it('TC11: _append 异常不抛出', () => {
    const awfDir = path.join(tmpDir, '.awf');
    fs.mkdirSync(awfDir);
    fs.writeFileSync(path.join(awfDir, 'state.json'), JSON.stringify({ version: '0.1.0' }));

    const logger = new RunLogger(tmpDir);

    // Make parent directory read-only to cause write failure
    const logDir = path.join(awfDir, 'logs');
    fs.chmodSync(logDir, 0o444); // read-only

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Should not throw
    expect(() => logger.logPrompt('test')).not.toThrow();

    spy.mockRestore();
    fs.chmodSync(logDir, 0o755); // restore for cleanup
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
});
