import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openServerLog, serverLogPath } from '../../src/lib/server-log.js';

/**
 * server 输出落盘（T1-112）。
 * 背景：此前 `spawn(..., { stdio: 'ignore' })` 把 server 的全部 console 输出丢进黑洞，
 * 2026-09-10 宿主卡死时无日志可查，只能靠 transcript 反推。现在接 .awf/logs/server.log。
 */
describe('server 输出日志', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-serverlog-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const logFile = () => path.join(tmp, 'logs', 'server.log');

  it('路径落在 .awf/logs 下', () => {
    expect(serverLogPath('/p/.awf/logs')).toBe('/p/.awf/logs/server.log');
  });

  it('目录不存在时自建', () => {
    const log = openServerLog(logFile());
    expect(fs.existsSync(logFile())).toBe(true);
    log.close();
  });

  it('追加写：再次打开不丢旧内容（常驻 server 重启后仍可追溯）', () => {
    const a = openServerLog(logFile());
    fs.writeSync(a.fd, 'first\n');
    a.close();
    const b = openServerLog(logFile());
    fs.writeSync(b.fd, 'second\n');
    b.close();
    expect(fs.readFileSync(logFile(), 'utf8')).toBe('first\nsecond\n');
  });

  it('超过上限 → 单代轮转：旧内容进 .1，新文件从空开始', () => {
    const a = openServerLog(logFile());
    fs.writeSync(a.fd, 'x'.repeat(50));
    a.close();

    const b = openServerLog(logFile(), { maxBytes: 10 });
    expect(b.rotated).toBe(true);
    fs.writeSync(b.fd, 'new\n');
    b.close();

    expect(fs.readFileSync(logFile(), 'utf8')).toBe('new\n');
    expect(fs.readFileSync(`${logFile()}.1`, 'utf8')).toBe('x'.repeat(50));
  });

  it('未超上限不轮转', () => {
    const a = openServerLog(logFile());
    fs.writeSync(a.fd, 'small\n');
    a.close();
    const b = openServerLog(logFile(), { maxBytes: 1024 });
    expect(b.rotated).toBe(false);
    b.close();
    expect(fs.existsSync(`${logFile()}.1`)).toBe(false);
    expect(fs.readFileSync(logFile(), 'utf8')).toBe('small\n');
  });

  it('maxBytes<=0 表示不轮转（不限量）', () => {
    const a = openServerLog(logFile());
    fs.writeSync(a.fd, 'x'.repeat(100));
    a.close();
    const b = openServerLog(logFile(), { maxBytes: 0 });
    expect(b.rotated).toBe(false);
    b.close();
  });

  it('close() 可重复调用不抛（父进程归还 fd 后不该影响启动）', () => {
    const log = openServerLog(logFile());
    log.close();
    expect(() => log.close()).not.toThrow();
  });
});
