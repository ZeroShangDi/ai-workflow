'use strict';
/**
 * observability/run-logger.cjs — per-run 人读日志（横切；只写日志，不改业务状态）
 *
 * 职责：把一次 run 的对话与编排事件按**可读文本**落到 `.awf/logs/<version>-<ts>/`：
 *   - main.log                      主会话日志（PROMPT / 回答 / NOTICE / DECISION 混排，追加式）
 *   - agents/<task>--<agent>.log    子 agent 转录（一次落全量，同名重试覆盖）
 * 消费方：人复盘、w-monitor、后端 Review 页（[DECISION] 行的时间戳与决策存储 created_at 对齐，可对上）。
 *
 * 设计取舍：
 *   - append-only 文本、不结构化 —— 目标是「人一眼读得懂」；给机器解析的交给专门 jsonl
 *     （subagent-events.jsonl 等），两种消费者分开。
 *   - 追加经 store 层 AppendFileStore（进程内串行队列），避免同进程并发写交错。
 *   - 所有写都 try/catch 吞错并只打印：日志失败绝不能反过来中断 run。
 *
 * @param {string} projectRoot 项目根；为空则整个 logger 退化为 no-op（enabled === false）
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const store = require('../shared/store.cjs');
const { normalizeStamp } = require('../shared/run-id.cjs'); // run 标识/时间戳归一单源
const { logsDir, stateFilePath } = require('../shared/project-paths.cjs'); // .awf 布局单源
const storeCore = require('../shared/store-core.cjs');
const { extract } = require('../adapters/ports.cjs'); // 经端口契约的唯一门（extract 属非端口工具，同样只从这里出）

const SEP = '─'.repeat(60) + '\n'; // 提示词段前的分隔线：长日志里一眼分清每轮 prompt 边界

class RunLogger {
  /** @param {string} projectRoot 项目根；缺省/空 → 不初始化，后续所有写自动 no-op */
  constructor(projectRoot) {
    this._projectRoot = projectRoot || null;
    this._runDir = null;          // 本次 run 的日志目录（<logs>/<version>-<ts>）
    this._logPath = null;         // main.log 路径；为 null 即代表「未启用」
    this._transcriptFile = null;  // 当前跟踪的 transcript 文件路径（切换时游标归零）
    this._transcriptPos = 0;      // 已消费到的字节偏移（增量读，避免重复捕获）
    this._sessionStartTime = Date.now();
    // main.log 追加经 store 层 AppendFileStore（进程内串行队列，仍沿用现转录/提取方式）
    this._main = null;

    if (!projectRoot) return;
    this._init();
  }

  // ---- 初始化 ----

  /** 建 <root>/.awf/logs/<version>-<ts>/（含 agents/）与 main.log 并写文件头；读不到版本号则整体不启用 */
  _init() {
    const root = this._projectRoot;
    const version = this._readVersion();
    if (!version) return;

    const dir = logsDir(root);
    fs.mkdirSync(dir, { recursive: true });

    // 时间戳归一与 runStamp 同规则，经 shared/run-id.cjs 单源（不再各处手抄同一行正则）
    this._runDir = path.join(dir, `${version}-${normalizeStamp(new Date())}`);
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

  /** 从 state.json 读 version（日志目录前缀）；读不到 → null（进而 _init 不建目录，logger 停用） */
  _readVersion() {
    try {
      const statePath = stateFilePath(this._projectRoot);
      const raw = fs.readFileSync(statePath, 'utf-8');
      const state = JSON.parse(raw);
      return state.version || null;
    } catch {
      return null;
    }
  }

  // ---- public API ----

  /** 是否已启用（有 main.log 即启用） */
  get enabled() {
    return !!this._logPath;
  }

  /** main.log 路径（未启用 → null） */
  get path() {
    return this._logPath;
  }

  /** 本次 run 的日志目录（未启用 → null） */
  get dir() {
    return this._runDir;
  }

  /** 记录注入给会话的提示词 */
  logPrompt(text) {
    this._write('PROMPT', text);
  }

  /** 记录 AI 的回答 */
  logResponse(text) {
    this._write('RESPONSE', text);
  }

  /** 记录一次选择问答（Q/A），用于复盘当时给用户/AI 的选择项与结果 */
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

  /** 重置捕获游标（新会话/clear 后调用）：清空文件引用与偏移，并把「会话开始时间」推到当前，防止再次抓旧文件 */
  resetTranscript() {
    this._sessionStartTime = Date.now();
    this._transcriptFile = null;
    this._transcriptPos = 0;
  }

  /**
   * 增量捕获主会话 transcript 中新增的 assistant 文本，追加为「回答」。
   * 机制：定位当前会话的 transcript（见 _findTranscriptFile），从 _transcriptPos 起只读新增字节；
   * 非助理行/坏行忽略。文件发生切换时游标归零重读（新会话从头开始）。
   */
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

  /**
   * 将子 Agent transcript 转为人可读日志；taskId + agentId 保留重试链路。
   * @param {object} body SubagentStop hook 载荷（取 body.agent_transcript_path）
   * @param {string} taskId 任务 id（文件名前缀，便于按任务找日志）
   * @param {string} agentId 子 agent id（文件名后缀，区分同任务多次重试）
   */
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

  /**
   * 在 ~/.claude/projects/<slug>/ 下定位「本会话」的 transcript：
   * 取 mtime 最新的 .jsonl；若最新文件的 mtime 早于 _sessionStartTime（本会话开始前写的），
   * 说明本会话还没产生 transcript → 返回 null，避免把上一会话的内容抓进来。
   */
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

  /** 按类型套格式（PROMPT 前置分隔线、RESPONSE/其他加时间戳）后追加 */
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

  /** 原样追加到 main.log；写失败只打印不抛（日志绝不能阻断 run） */
  _append(content) {
    try {
      this._main?.appendRawSync(content);
    } catch (err) {
      console.error(`[run-logger] write error: ${err.message}`);
    }
  }
}

module.exports = { RunLogger };
