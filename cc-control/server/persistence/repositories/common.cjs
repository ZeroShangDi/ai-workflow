'use strict';

const { randomUUID } = require('node:crypto');
const { PersistenceError } = require('../errors.cjs');

const newId = () => randomUUID();
const now = () => new Date().toISOString();

function required(value, name) {
  if (value === undefined || value === null || value === '') {
    throw new PersistenceError('VALIDATION', `${name} is required`);
  }
  return value;
}

function jsonText(value, name = 'value') {
  if (value === undefined || value === null) return '{}';
  try { return JSON.stringify(value); } catch (error) {
    throw new PersistenceError('VALIDATION', `${name} must be JSON serializable`, { cause: error.message });
  }
}

function decodeJson(value, fallback = {}) {
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function camelKey(key) {
  return key.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
}

function mapRow(row) {
  if (!row) return null;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    const mappedKey = camelKey(key);
    if (key.endsWith('_json')) {
      const base = camelKey(key.slice(0, -5));
      out[base] = decodeJson(value);
    } else {
      out[mappedKey] = value;
    }
  }
  return out;
}

function mapRows(rows) { return rows.map(mapRow); }

function assertRevision(actual, expected, entity) {
  if (expected === undefined || expected === null) return;
  if (Number(actual) !== Number(expected)) {
    throw new PersistenceError('CONFLICT', `${entity} revision conflict`, { expectedRevision: expected, currentRevision: Number(actual) });
  }
}

function page(rows, limit, cursor, total) {
  return { items: mapRows(rows), nextCursor: rows.length === limit ? String(rows.at(-1).id) : null, total };
}

function inTransaction(db, fn) { return db.withTransaction(fn); }

module.exports = { newId, now, required, jsonText, decodeJson, mapRow, mapRows, assertRevision, page, inTransaction };
