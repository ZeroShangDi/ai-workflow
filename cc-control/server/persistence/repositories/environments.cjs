'use strict';
const path = require('node:path');
const { newId, now, required, mapRow, mapRows } = require('./common.cjs');
const { protect } = require('../errors.cjs');
module.exports = function environments(db) {
 const q=s=>db.connection.prepare(s);
 return {
  register(input={}) { return protect(()=>{const t=now(), id=input.id||newId(); q('INSERT INTO environments(id,name,created_at,last_seen_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,last_seen_at=excluded.last_seen_at').run(id,input.name||'',t,t); return mapRow(q('SELECT * FROM environments WHERE id=?').get(id));}); },
  list() { return protect(()=>mapRows(q('SELECT * FROM environments ORDER BY last_seen_at DESC').all())); },
  touch(id) { return protect(()=>{q('UPDATE environments SET last_seen_at=? WHERE id=?').run(now(),required(id,'id')); return mapRow(q('SELECT * FROM environments WHERE id=?').get(id));}); },
 };
};
