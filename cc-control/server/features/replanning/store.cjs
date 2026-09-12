'use strict';
/**
 * replanning/store.cjs — 动态规划 proposal 与事件的持久化。
 *
 * 布局（.awf/dynamic-planning/）：
 *   - proposals/<proposalId>.json  每个 proposal 一份，原子写覆盖（同一 proposal 的状态演进就地更新）；
 *   - events.jsonl                 追加式事件流，永不过写，为未来人工复审/UI/通知留稳定数据边界。
 * 为什么 proposal 用覆盖写、事件用追加写：proposal 是「当前状态快照」（需可变），事件是「历史」
 * （需不可变）；两者分工，读状态看 proposals，读来龙去脉看 events。
 */
const fs = require('node:fs');
const path = require('node:path');
const storeCore = require('../../shared/store-core.cjs');
const store = require('../../shared/store.cjs');

class DynamicPlanningStore {
  constructor(projectRoot) {
    this.root = path.join(projectRoot, '.awf', 'dynamic-planning');
    this.proposalsDir = path.join(this.root, 'proposals');
    this.eventsPath = path.join(this.root, 'events.jsonl');
  }

  /**
   * proposalId → 绝对路径，并做 id 白名单校验。
   * 校验是防路径穿越的关键：id 直接拼进文件名，非法字符可让 read/write 越出 proposalsDir。
   * @throws id 非字符串或不符合 ^DP-[A-Za-z0-9-]+$ 时抛错
   */
  proposalPath(proposalId) {
    if (typeof proposalId !== 'string' || !/^DP-[A-Za-z0-9-]+$/.test(proposalId)) {
      throw new Error(`invalid dynamic planning proposal id: ${String(proposalId)}`);
    }
    return path.join(this.proposalsDir, `${proposalId}.json`);
  }

  /** 原子写 proposal（写临时文件再 rename，避免读到半截 JSON） */
  writeProposal(proposal) {
    storeCore.writeJsonAtomicSync(this.proposalPath(proposal.proposalId), proposal);
    return proposal;
  }

  /** 读单个 proposal；不存在时返回 null（readJsonSync 语义） */
  readProposal(proposalId) {
    return storeCore.readJsonSync(this.proposalPath(proposalId));
  }

  /**
   * 列出全部 proposal，按文件名倒序（= proposalId 时间戳倒序，最新在前）。
   * 读坏的单个文件被 storeCore 吞成 null，此处 filter(Boolean) 丢弃，不因一个坏文件拖垮整体列表。
   */
  listProposals() {
    let names = [];
    try {
      names = fs.readdirSync(this.proposalsDir).filter((name) => name.endsWith('.json')).sort().reverse();
    } catch {
      return [];
    }
    return names.map((name) => storeCore.readJsonSync(path.join(this.proposalsDir, name))).filter(Boolean);
  }

  /** 追加一条事件（进程内串行，追加写，不改写历史） */
  appendEvent(event) {
    store.createAppendFileStore({ filePath: this.eventsPath, json: true }).appendSync(event);
    return event;
  }
}

module.exports = { DynamicPlanningStore };
