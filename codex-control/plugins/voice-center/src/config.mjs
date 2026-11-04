import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { VoiceControlError } from './errors.mjs';

export const TRIGGER_CONFIG_VERSION = 1;

const TOP_LEVEL_KEYS = new Set(['schemaVersion', 'triggers', 'updatedAt']);
const TRIGGER_KEYS = new Set(['id', 'enabled', 'topics', 'description']);
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TOPIC_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/;

export function defaultDataDirectory() {
  if (process.env.VOICE_CENTER_DATA_DIR) {
    return path.resolve(process.env.VOICE_CENTER_DATA_DIR);
  }
  return path.resolve(import.meta.dirname, '..', 'data');
}

export function defaultConfigPath() {
  return path.join(defaultDataDirectory(), 'config.json');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function emptyConfig() {
  return {
    schemaVersion: TRIGGER_CONFIG_VERSION,
    triggers: [],
    updatedAt: null,
  };
}

function configError(message) {
  return new VoiceControlError('invalid_trigger_configuration', message, { status: 400 });
}

export function validateTriggerConfig(value, { allowUpdatedAt = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw configError('Trigger configuration must be an object');
  }
  const unknown = Object.keys(value).filter((key) => !TOP_LEVEL_KEYS.has(key));
  if (unknown.length) throw configError(`Unknown trigger configuration keys: ${unknown.join(', ')}`);
  if (value.schemaVersion !== TRIGGER_CONFIG_VERSION) {
    throw configError(`schemaVersion must be ${TRIGGER_CONFIG_VERSION}`);
  }
  if (!Array.isArray(value.triggers)) throw configError('triggers must be an array');

  const seen = new Set();
  const triggers = value.triggers.map((trigger, index) => {
    if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) {
      throw configError(`triggers[${index}] must be an object`);
    }
    const extra = Object.keys(trigger).filter((key) => !TRIGGER_KEYS.has(key));
    if (extra.length) throw configError(`Unknown keys in triggers[${index}]: ${extra.join(', ')}`);
    if (typeof trigger.id !== 'string' || !ID_PATTERN.test(trigger.id)) {
      throw configError(`triggers[${index}].id is invalid`);
    }
    if (seen.has(trigger.id)) throw configError(`Duplicate trigger id: ${trigger.id}`);
    seen.add(trigger.id);
    if (typeof trigger.enabled !== 'boolean') {
      throw configError(`triggers[${index}].enabled must be a boolean`);
    }
    if (!Array.isArray(trigger.topics) || trigger.topics.length === 0) {
      throw configError(`triggers[${index}].topics must contain at least one topic`);
    }
    const topics = trigger.topics.map((topic, topicIndex) => {
      if (typeof topic !== 'string' || !TOPIC_PATTERN.test(topic)) {
        throw configError(`triggers[${index}].topics[${topicIndex}] is invalid`);
      }
      return topic;
    });
    if (new Set(topics).size !== topics.length) {
      throw configError(`triggers[${index}].topics contains duplicates`);
    }
    if (
      trigger.description !== undefined
      && (typeof trigger.description !== 'string' || trigger.description.length > 240)
    ) {
      throw configError(`triggers[${index}].description must be at most 240 characters`);
    }
    return {
      id: trigger.id,
      enabled: trigger.enabled,
      topics,
      ...(trigger.description === undefined ? {} : { description: trigger.description }),
    };
  });

  if (!allowUpdatedAt && value.updatedAt !== undefined) {
    throw configError('updatedAt is managed by the runtime');
  }
  if (
    allowUpdatedAt
    && value.updatedAt !== null
    && (typeof value.updatedAt !== 'string' || Number.isNaN(Date.parse(value.updatedAt)))
  ) {
    throw configError('updatedAt must be an ISO timestamp or null');
  }

  return {
    schemaVersion: TRIGGER_CONFIG_VERSION,
    triggers,
    updatedAt: allowUpdatedAt ? (value.updatedAt ?? null) : null,
  };
}

export class TriggerConfigStore {
  constructor({ filePath = defaultConfigPath() } = {}) {
    this.filePath = path.resolve(filePath);
    this.value = emptyConfig();
    this.loaded = false;
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new VoiceControlError(
          'trigger_configuration_unreadable',
          `Cannot read trigger configuration: ${error.message}`,
          { status: 500, cause: error },
        );
      }
      this.value = emptyConfig();
      this.loaded = true;
      return this.snapshot();
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new VoiceControlError(
        'invalid_trigger_configuration',
        `Cannot parse trigger configuration: ${error.message}`,
        { status: 500, cause: error },
      );
    }
    this.value = validateTriggerConfig(parsed, { allowUpdatedAt: true });
    this.loaded = true;
    return this.snapshot();
  }

  snapshot() {
    return clone(this.value);
  }

  replace(value) {
    const validated = validateTriggerConfig(value);
    const next = {
      ...validated,
      updatedAt: new Date().toISOString(),
    };
    this.#write(next);
    this.value = next;
    this.loaded = true;
    return this.snapshot();
  }

  #write(value) {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      fs.renameSync(temporary, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
    } finally {
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        // Best-effort cleanup after an atomic rename or failed write.
      }
    }
  }
}
