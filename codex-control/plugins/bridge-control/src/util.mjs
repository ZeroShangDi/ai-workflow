import crypto from 'node:crypto';

import { BridgeError } from './errors.mjs';

export function isoNow() {
  return new Date().toISOString();
}

export function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function requireText(value, field, maximum = 4096) {
  if (typeof value !== 'string') {
    throw new BridgeError(400, 'invalid_request', `${field} must be a string`);
  }
  const text = value.trim();
  if (!text || text.length > maximum) {
    throw new BridgeError(400, 'invalid_request', `${field} must contain 1-${maximum} characters`);
  }
  return text;
}

export function optionalText(value, field, maximum = 4096) {
  if (value === undefined || value === null || value === '') return null;
  return requireText(value, field, maximum);
}

export function assertObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BridgeError(400, 'invalid_request', `${field} must be an object`);
  }
  return value;
}

export function boundedInteger(value, {
  fallback,
  minimum,
  maximum,
  field,
} = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new BridgeError(400, 'invalid_request', `${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

export function tryParseJson(text, fallback = {}) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

export function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function assertSessionId(value) {
  const id = requireText(value, 'sessionId', 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
    throw new BridgeError(400, 'invalid_request', 'sessionId contains unsupported characters');
  }
  return id;
}
