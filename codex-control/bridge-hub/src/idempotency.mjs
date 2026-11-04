import path from 'node:path';

import { HubError, isWriteResultUnknown, publicError } from './errors.mjs';
import { AtomicJsonStore } from './storage.mjs';
import { canonicalJson, cloneJson, isoNow, requireText, sha256 } from './util.mjs';

function requestHash(payload) {
  return sha256(canonicalJson(payload));
}

function unknownReceipt(error) {
  return {
    status: 'unknown',
    code: 'write_result_unknown',
    error: error?.message || 'write result is unknown',
    reconcileRequired: true,
  };
}

function failedReceipt(error) {
  const normalized = publicError(error);
  return {
    status: 'failed',
    code: normalized.body.code || 'write_failed',
    error: normalized.body.error || error?.message || 'write failed',
  };
}

export class IdempotencyStore {
  constructor({ dataDir = null } = {}) {
    this.store = new AtomicJsonStore(
      dataDir ? path.join(dataDir, 'idempotency.json') : null,
      { records: {} },
    );
    this.inflight = new Map();
    this.#recoverPending();
  }

  #recoverPending() {
    const data = this.store.read();
    let changed = false;
    for (const record of Object.values(data.records)) {
      if (record.status !== 'pending') continue;
      record.status = 'unknown';
      record.receipt = {
        status: 'unknown',
        code: 'write_result_unknown',
        error: 'process stopped before the write result was recorded',
        reconcileRequired: true,
      };
      record.updatedAt = isoNow();
      changed = true;
    }
    if (changed) this.store.write(data);
  }

  async execute({
    key,
    payload,
    operation,
  }) {
    const idempotencyKey = requireText(key, 'idempotencyKey', 256);
    const hash = requestHash(payload);
    const existing = this.store.read().records[idempotencyKey];
    if (existing) {
      if (existing.requestHash !== hash) {
        throw new HubError(
          409,
          'idempotency_conflict',
          'idempotencyKey was already used with a different request',
        );
      }
      if (existing.status === 'pending') {
        const pending = this.inflight.get(idempotencyKey);
        if (pending?.hash === hash) return pending.promise;
      }
      return cloneJson(existing.receipt);
    }

    const data = this.store.read();
    data.records[idempotencyKey] = {
      key: idempotencyKey,
      requestHash: hash,
      status: 'pending',
      receipt: null,
      createdAt: isoNow(),
      updatedAt: isoNow(),
    };
    this.store.write(data);

    const promise = (async () => {
      try {
        const result = await operation();
        const receipt = cloneJson(result);
        const current = this.store.read();
        current.records[idempotencyKey].status = result?.status === 'unknown' ? 'unknown' : 'accepted';
        current.records[idempotencyKey].receipt = receipt;
        current.records[idempotencyKey].updatedAt = isoNow();
        this.store.write(current);
        return receipt;
      } catch (error) {
        const current = this.store.read();
        if (isWriteResultUnknown(error)) {
          const receipt = unknownReceipt(error);
          current.records[idempotencyKey].status = 'unknown';
          current.records[idempotencyKey].receipt = receipt;
          current.records[idempotencyKey].updatedAt = isoNow();
          this.store.write(current);
          return receipt;
        }
        const receipt = failedReceipt(error);
        current.records[idempotencyKey].status = 'failed';
        current.records[idempotencyKey].receipt = receipt;
        current.records[idempotencyKey].updatedAt = isoNow();
        this.store.write(current);
        throw error;
      } finally {
        this.inflight.delete(idempotencyKey);
      }
    })();
    this.inflight.set(idempotencyKey, { hash, promise });
    return promise;
  }
}
