'use strict';

/** 动态规划 proposal + 追加式事件记录；为未来人工复审/UI/通知预留稳定数据边界。 */
const fs = require('node:fs');
const path = require('node:path');
const storeCore = require('../../lib/store-core.cjs');
const store = require('../../lib/store.cjs');

class DynamicPlanningStore {
  constructor(projectRoot) {
    this.root = path.join(projectRoot, '.awf', 'dynamic-planning');
    this.proposalsDir = path.join(this.root, 'proposals');
    this.eventsPath = path.join(this.root, 'events.jsonl');
  }

  proposalPath(proposalId) {
    if (typeof proposalId !== 'string' || !/^DP-[A-Za-z0-9-]+$/.test(proposalId)) {
      throw new Error(`invalid dynamic planning proposal id: ${String(proposalId)}`);
    }
    return path.join(this.proposalsDir, `${proposalId}.json`);
  }

  writeProposal(proposal) {
    storeCore.writeJsonAtomicSync(this.proposalPath(proposal.proposalId), proposal);
    return proposal;
  }

  readProposal(proposalId) {
    return storeCore.readJsonSync(this.proposalPath(proposalId));
  }

  listProposals() {
    let names = [];
    try {
      names = fs.readdirSync(this.proposalsDir).filter((name) => name.endsWith('.json')).sort().reverse();
    } catch {
      return [];
    }
    return names.map((name) => storeCore.readJsonSync(path.join(this.proposalsDir, name))).filter(Boolean);
  }

  appendEvent(event) {
    store.createAppendFileStore({ filePath: this.eventsPath, json: true }).appendSync(event);
    return event;
  }
}

module.exports = { DynamicPlanningStore };
