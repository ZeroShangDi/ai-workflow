import crypto from 'node:crypto';
import path from 'node:path';

import { HubError } from './errors.mjs';
import { AtomicJsonStore } from './storage.mjs';
import {
  assertObject,
  cloneJson,
  isoNow,
  optionalText,
} from './util.mjs';

const BINDING_FIELDS = [
  'controlSessionId',
  'workSessionId',
  'voiceSessionId',
];

export class BindingStore {
  constructor({ dataDir = null } = {}) {
    this.store = new AtomicJsonStore(
      dataDir ? path.join(dataDir, 'bindings.json') : null,
      { bindings: {} },
    );
  }

  create(input) {
    const body = assertObject(input, 'binding');
    const binding = {};
    for (const field of BINDING_FIELDS) {
      binding[field] = optionalText(body[field], field, 256);
    }
    if (!BINDING_FIELDS.some((field) => binding[field])) {
      throw new HubError(
        400,
        'invalid_request',
        'at least one control, work, or voice session id is required',
      );
    }
    const id = body.bindingId
      ? optionalText(body.bindingId, 'bindingId', 128)
      : `bind_${crypto.randomUUID()}`;
    const data = this.store.read();
    if (data.bindings[id]) {
      throw new HubError(409, 'binding_exists', 'binding id already exists');
    }
    const record = {
      bindingId: id,
      ...binding,
      metadata: body.metadata === undefined ? {} : cloneJson(assertObject(body.metadata, 'metadata')),
      createdAt: isoNow(),
    };
    data.bindings[id] = record;
    this.store.write(data);
    return cloneJson(record);
  }

  get(id) {
    const key = optionalText(id, 'bindingId', 128);
    return cloneJson(this.store.read().bindings[key] || null);
  }

  list({ controlSessionId, workSessionId, voiceSessionId } = {}) {
    const filters = { controlSessionId, workSessionId, voiceSessionId };
    return Object.values(this.store.read().bindings)
      .filter((binding) => BINDING_FIELDS.every(
        (field) => !filters[field] || binding[field] === filters[field],
      ))
      .map(cloneJson);
  }
}
