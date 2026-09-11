'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const store = require('../lib/store.cjs');
const storeCore = require('../lib/store-core.cjs');
const extract = require('../lib/extract.cjs');

const SEP = '─'.repeat(60) + '\n';

class RunLogger {
  constructor(projectRoot) {
    this._projectRoot = projectRoot || null;
    this._runDir = null;
    this._logPath = null;
    this._transcriptFile = null;
    this._transcriptPos = 0;
    this._sessionStartTime = Date.now();
    // main.log 追加经 store 层 AppendFileStore（进程内串行队列，仍沿用现转录/提取方式）
    this._main = null;

    if (!projectRoot) return;
    this._init();
  }

  // ---- 初始化 ----

  _init() {
    const root = this._projectRoot;
    const version = this._readVersion();
    if (!version) return;

    const dir = path.join(root, '.awf', 'logs');
    fs.mkdirSync(dir, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    this._runDir = path.join(dir, `${version}-${ts}`);
    fs.mkdirSync(path.join(this._runDir, 'agents'), { recursive: true });
    this._logPath = path.join(this._runDir, 'main.log');
    this._main = store.createAppendFileStore({ filePath: this._logPath });

    const header = [
      '=== AWF Run Log ===\n',
      `version: ${version}\n`,
      `started: ${new Date().toISOString()}\n`,
      `project: ${root}\n`,
      '\n',
    ].join('');
    this._main.appendRawSync(header);
  }

  _readVersion() {
    try {
      const statePath = path.join(this._projectRoot, '.awf', 'state.json');
      const raw = fs.readFileSync(statePath, 'utf-8');
      const state = JSON.parse(raw);
      return state.version || null;
    } catch {
      return null;
    }
  }

  // ---- public API ----

  get enabled() {
    return !!this._logPath;
  }

  get path() {
    return this._logPath;
  }

  get dir() {
    return this._runDir;
  }

  logPrompt(text) {
    this._write('PROMPT', text);
  }

  logResponse(text) {
    this._write('RESPONSE', text);
  }

  logChoice(question, answer) {
    const ts = new Date().toISOString().slice(11, 19);
    const content = `[${ts}]\nQ: ${question}\nA: ${answer}\n`;
    this._append(content);
  }

  /**
   * 编排层运维提示行（T1-111）：pause 闩锁告警/心跳/放行等。
   * 与 prompt/回答分开标注，人读时一眼能认出「这不是对话内容，是编排在说话」。
   */
  logNotice(kind, detail) {
    if (!this._logPath) return;
    this._append(`[${new Date().toISOString()}] [NOTICE][${kind}] ${detail}\n`);
  }

  /** 决策关键事件行（时间戳与决策存储记录 created_at 对齐，Review 页可对上） */
  logDecision({ at, decisionId, event, detail }) {
    if (!this._logPath) return;
    const ts = at || new Date().toISOString();
    const id = decisionId ? ` ${decisionId}` : '';
    this._append(`[${ts}] [DECISION][${event}]${id} ${detail || ''}\n`);
  }

  // ---- transcript 捕获 ----

  resetTranscript() {
    this._sessionStartTime = Date.now();
    this._transcriptFile = null;
    this._transcriptPos = 0;
  }

  captureFromTranscript() {
    if (!this._logPath) return;

    const fp = this._findTranscriptFile();
    if (!fp) return;

    if (fp !== this._transcriptFile) {
      this._transcriptFile = fp;
      this._transcriptPos = 0;
    }

    const content = fs.readFileSync(fp, 'utf-8');
    if (content.length <= this._transcriptPos) return;

    const newContent = content.slice(this._transcriptPos);
    this._transcriptPos = content.length;

    const lines = newContent.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'assistant') {
          const texts = [];
          for (const block of (entry.message?.content || [])) {
            if (block.type === 'text' && block.text) texts.push(block.text);
          }
          if (texts.length > 0) {
            this.logResponse(texts.join(''));
          }
        }
      } catch {}
    }
  }

  /** 将子 Agent transcript 转为人可读日志；taskId + agentId 保留重试链路。 */
  captureSubagentTranscript(body, taskId, agentId) {
    if (!this._runDir) return;
    const source = body?.agent_transcript_path;
    if (!source || !fs.existsSync(source)) return;
    const safe = (value, fallback) => String(value || fallback).replace(/[^a-zA-Z0-9._-]/g, '_');
    const file = `${safe(taskId, 'unknown')}--${safe(agentId, 'agent')}.log`;
    const header = [
      '=== AWF Subagent Log ===\n',
      `task: ${taskId || 'unknown'}\n`,
      `agent: ${agentId || 'unknown'}\n`,
      `captured: ${new Date().toISOString()}\n`,
      '\n',
    ].join('');
    try {
      // agent 转录全文一次性落盘（原子写；同名重试会覆盖而非追加，保持原语义）
      storeCore.atomicWriteFileSync(path.join(this._runDir, 'agents', file), header + this._renderTranscript(source));
    } catch (err) {
      console.error(`[run-logger] transcript render error: ${err.message}`);
    }
  }

  _findTranscriptFile() {
    const slug = (this._projectRoot || process.cwd()).replace(/\//g, '-');
    const dir = path.join(os.homedir(), '.claude', 'projects', slug);
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) return null;
    if (this._sessionStartTime && files[0].mtime < this._sessionStartTime) return null;
    return path.join(dir, files[0].name);
  }

  _renderTranscript(source) {
    // transcript 提取/渲染归位 extract.cjs（JSONL 解析 + role/工具片段 → 人读文本）
    return extract.renderTranscriptText(fs.readFileSync(source, 'utf-8'));
  }

  // ---- internal ----

  _write(type, body) {
    if (!this._logPath) return;

    const ts = new Date().toISOString().slice(11, 19);
    let content = '';

    switch (type) {
      case 'PROMPT':
        content = SEP + `[${ts}] 提示词\n${body || ''}\n\n`;
        break;
      case 'RESPONSE':
        content = `[${ts}] 回答\n${body || ''}\n`;
        break;
      default:
        content = `[${ts}]\n${body || ''}\n`;
    }

    this._append(content);
  }

  _append(content) {
    try {
      this._main?.appendRawSync(content);
    } catch (err) {
      console.error(`[run-logger] write error: ${err.message}`);
    }
  }
}

module.exports = { RunLogger };
