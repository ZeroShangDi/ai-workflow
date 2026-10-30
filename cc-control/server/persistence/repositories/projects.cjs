'use strict';
const { newId, now, required, mapRow, mapRows } = require('./common.cjs');
const { protect, PersistenceError } = require('../errors.cjs');

module.exports = function projects(db) {
  const q = (sql) => db.connection.prepare(sql);
  return {
    create(input = {}) { return protect(() => { const t=now(), id=input.id || newId(); q('INSERT INTO projects(id,name,status,created_at,updated_at) VALUES(?,?,?,?,?)').run(id,input.name || '',input.status || 'active',t,t); return mapRow(q('SELECT * FROM projects WHERE id=?').get(id)); }); },
    get(id) { return protect(() => mapRow(q('SELECT * FROM projects WHERE id=?').get(required(id,'id')))); },
    list({limit=100,cursor}={}) { return protect(() => { const n=Math.max(1,Math.min(200,Number(limit)||100)); const rows=cursor?q('SELECT * FROM projects WHERE id>? ORDER BY id LIMIT ?').all(cursor,n+1):q('SELECT * FROM projects ORDER BY id LIMIT ?').all(n+1); const more=rows.length>n; const items=mapRows(rows.slice(0,n)); return {items,nextCursor:more?items.at(-1).id:null}; }); },
    update(id, patch={}) { return protect(() => { id=required(id,'id'); const project=q('SELECT * FROM projects WHERE id=?').get(id); if(!project) throw new PersistenceError('NOT_FOUND','Project not found'); if(patch.activeRequirementId){const r=q('SELECT project_id FROM requirements WHERE id=?').get(patch.activeRequirementId);if(!r||r.project_id!==id)throw new PersistenceError('VALIDATION','Active requirement must belong to the project');} const fields={name:'name',status:'status',activeRequirementId:'active_requirement_id'}; const sets=[], vals=[]; for(const [k,col] of Object.entries(fields)) if(Object.hasOwn(patch,k)){sets.push(`${col}=?`);vals.push(patch[k]);} if(!sets.length) return mapRow(project); sets.push('updated_at=?');vals.push(now(),id); q(`UPDATE projects SET ${sets.join(',')} WHERE id=?`).run(...vals); return mapRow(q('SELECT * FROM projects WHERE id=?').get(id)); }); },
  };
};
