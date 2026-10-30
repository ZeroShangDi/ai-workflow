import fs from 'node:fs';
import path from 'node:path';

import { BridgeError } from './errors.mjs';
import { cloneJson } from './util.mjs';

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export class AtomicJsonStore {
  constructor(filePath, initial) {
    this.filePath = filePath || null;
    this.initial = initial;
    this.value = this.#load();
  }

  #load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return cloneJson(this.initial);
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      throw new BridgeError(500, 'store_corrupt', `cannot read durable store: ${this.filePath}`, {
        cause: error.message,
      });
    }
  }

  read() {
    return cloneJson(this.value);
  }

  write(value, { persist = true } = {}) {
    this.value = cloneJson(value);
    if (!persist || !this.filePath) return this.read();
    ensureParent(this.filePath);
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
    return this.read();
  }

  update(mutator, options) {
    return this.write(mutator(this.read()), options);
  }
}

export class JsonLinesStore {
  constructor(filePath) {
    this.filePath = filePath || null;
  }

  append(value) {
    if (!this.filePath) return;
    ensureParent(this.filePath);
    fs.appendFileSync(this.filePath, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  readAll() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return [];
    const text = fs.readFileSync(this.filePath, 'utf8');
    const rows = [];
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch (error) {
        throw new BridgeError(500, 'store_corrupt', `invalid JSONL at ${this.filePath}:${index + 1}`, {
          cause: error.message,
        });
      }
    }
    return rows;
  }
}
