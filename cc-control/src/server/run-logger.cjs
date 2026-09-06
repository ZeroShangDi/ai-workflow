'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const SEP = '─'.repeat(60) + '\n';

class RunLogger {
  constructor(projectRoot) {
    this._projectRoot = projectRoot || null;
    this._runDir = null;
    this._logPath = null;
    this._transcriptFile = null;
    this._transcriptPos = 0;
    this._sessionStartTime = Date.now();

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

    const header = [
      '=== AWF Run Log ===\n',
      `version: ${version}\n`,
      `started: ${new Date().toISOString()}\n`,
      `project: ${root}\n`,
      '\n',
    ].join('');
    fs.writeFileSync(this._logPath, header);
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
      fs.writeFileSync(path.join(this._runDir, 'agents', file), header + this._renderTranscript(source));
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
    const records = [];
    for (const line of fs.readFileSync(source, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const role = entry.type === 'assistant' ? '回答' : entry.type === 'user' ? '提示词' : null;
        if (!role) continue;
        const content = entry.message?.content;
        const blocks = Array.isArray(content) ? content : [{ type: 'text', text: content }];
        const parts = [];
        for (const block of blocks) {
          if (block?.type === 'text' && block.text) parts.push(block.text);
          if (block?.type === 'tool_use') parts.push(`调用工具: ${block.name}\n${JSON.stringify(block.input || {}, null, 2)}`);
        }
        if (parts.length === 0) continue;
        const time = typeof entry.timestamp === 'string' ? entry.timestamp.slice(11, 19) : '--:--:--';
        records.push(`[${time}] ${role}\n${parts.join('\n')}\n`);
      } catch { /* 跳过非 JSONL 或不含可读内容的记录 */ }
    }
    return records.join('\n');
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
      fs.appendFileSync(this._logPath, content);
    } catch (err) {
      console.error(`[run-logger] write error: ${err.message}`);
    }
  }
}

module.exports = { RunLogger };
