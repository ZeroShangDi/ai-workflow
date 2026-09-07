'use strict';
/**
 * decision-store.cjs — 决策记录存储（追加式 jsonl）
 *
 * 目录：.awf/decisions/runs/<runStamp>.jsonl
 * runStamp：与 run-logger 对齐（.awf/logs/<version>-<ts>，version 取 state.json，ts 为
 *   ISO 去冒号/点的前 19 位，如 0.2.0-2026-09-07T00-50-00）。解析取当前最新匹配的 run 目录，
 *   保证决策记录落到正在进行的 run；无 run 目录时按同规则用当前时间生成。
 *
 * 不变量：
 *   - 只追加，绝不覆盖历史记录（fs 追加写 + 行级 JSON）；
 *   - 幂等：同一 decision_id 的正式决策在同一个 run 文件内不重复落盘（防 Stop 双触发）；
 *   - override 以追加事件方式写入原 decision 所在 run 文件，不改写原记录。
 */
const fs = require('node:fs');
const path = require('node:path');
// 决策 jsonl 追加/读取经 store 层 AppendFileStore（json 模式，进程内串行 + 坏行容忍）
const store = require('../lib/store.cjs');

const VERSION_FILE = path.join('.awf', 'state.json');
const LOGS_DIR = path.join('.awf', 'logs');
const RUNS_DIR = path.join('.awf', 'decisions', 'runs');

/** 生成与 run-logger 相同的 ts 片段（ISO 去 :/. 前 19 位） */
function isoStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/** 读 state.json version；缺失/非法 → null */
function readVersion(projectRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectRoot, VERSION_FILE), 'utf8')).version || null;
  } catch {
    return null;
  }
}

/** 列出 .awf/logs 下以 `${version}-` 开头的 run 目录名，倒序（最新在前） */
function logRunDirs(projectRoot, version) {
  if (!version) return [];
  const logsDir = path.join(projectRoot, LOGS_DIR);
  let names = [];
  try {
    names = fs.readdirSync(logsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith(`${version}-`))
      .map((d) => d.name);
  } catch {
    return [];
  }
  return names.sort().reverse();
}

class DecisionStore {
  /**
   * @param {string} projectRoot - 用户项目根目录
   */
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
  }

  get runsDir() {
    return path.join(this.projectRoot, RUNS_DIR);
  }

  /**
   * 解析 runStamp：优先取 .awf/logs 中最新匹配 state.version 的 run 目录名；
   * 无 run 目录时按同规则用当前时间生成（与 run-logger 命名一致）。
   * @returns {string|null} version 缺失时返回 null
   */
  runStamp() {
    const version = readVersion(this.projectRoot);
    if (!version) return null;
    const latest = logRunDirs(this.projectRoot, version)[0];
    return latest || `${version}-${isoStamp()}`;
  }

  fileFor(runStamp) {
    return path.join(this.runsDir, `${runStamp}.jsonl`);
  }

  /** 追加一行记录（jsonl）；目录递归创建由 store 处理 */
  _appendLine(file, record) {
    store.createAppendFileStore({ filePath: file, json: true }).appendSync(record);
  }

  /** 读一份 run 文件的全部记录（store json 模式，容忍坏行） */
  _records(file) {
    return store.createAppendFileStore({ filePath: file, json: true }).readAllSync();
  }

  /**
   * 落一条决策记录（正式决策 / 兜底等，含 event 字段由调用方决定）。
   * 幂等：同 decision_id 已在当前 run 文件落过 → 跳过不重复追加。
   * @param {object} record - 含 decision_id 等；runStamp 由 store 解析后写入
   * @returns {{ appended: boolean, runStamp: string|null, file: string|null }}
   */
  append(record) {
    const runStamp = this.runStamp();
    if (!runStamp) return { appended: false, runStamp: null, file: null };
    const file = this.fileFor(runStamp);
    const stamped = { runStamp, ...record };

    if (record.decision_id && this._hasDecision(file, record.decision_id)) {
      return { appended: false, runStamp, file };
    }
    this._appendLine(file, stamped);
    return { appended: true, runStamp, file };
  }

  /** file 中是否已含同 decision_id 的记录（幂等去重） */
  _hasDecision(file, decisionId) {
    return this._records(file).some((e) => e.decision_id === decisionId);
  }

  /**
   * override：以追加事件写入原 decision 所在 run 文件（不覆盖原记录）。
   * @param {string} decisionId
   * @param {object} payload - override 载荷（instruction/original_answer 等）
   * @returns {{ runStamp: string, file: string }}
   * @throws 找不到含该 decision_id 的记录时抛错
   */
  override(decisionId, payload) {
    const hit = this._findDecision(decisionId);
    if (!hit) throw new Error(`决策记录不存在：${decisionId}`);
    const event = {
      event: 'decision_overridden',
      decision_id: decisionId,
      at: new Date().toISOString(),
      ...payload,
    };
    this._appendLine(hit.file, event);
    return { runStamp: hit.runStamp, file: hit.file };
  }

  /** 在全部 run 文件中查找含 decision_id 的记录，返回 { runStamp, file, entry } 或 null */
  _findDecision(decisionId) {
    for (const { runStamp, file } of this._runFiles()) {
      const entry = this._records(file).find((e) => e.decision_id === decisionId && e.event !== 'decision_overridden');
      if (entry) return { runStamp, file, entry };
    }
    return null;
  }

  /** 已存在的 run 文件列表（按 runStamp 倒序，最新在前） */
  _runFiles() {
    let names = [];
    try {
      names = fs.readdirSync(this.runsDir).filter((n) => n.endsWith('.jsonl')).sort().reverse();
    } catch {
      return [];
    }
    return names.map((n) => ({ runStamp: n.replace(/\.jsonl$/, ''), file: path.join(this.runsDir, n) }));
  }

  /**
   * 聚合读取：各 run 倒序（最新在前），run 内按写入顺序。
   * @returns {Array<{ runStamp: string, file: string, entries: object[] }>}
   */
  listRuns() {
    return this._runFiles().map(({ runStamp, file }) => ({
      runStamp,
      file,
      entries: this._records(file),
    }));
  }

  /** 扁平聚合（倒序），供 Review/override 检索 */
  listAll() {
    return this.listRuns().flatMap((run) => run.entries);
  }
}

module.exports = { DecisionStore, isoStamp };
