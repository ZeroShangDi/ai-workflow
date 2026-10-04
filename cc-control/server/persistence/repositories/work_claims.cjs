'use strict';
const { newId, now, required, mapRow, mapRows } = require('./common.cjs');
const { protect, PersistenceError } = require('../errors.cjs');
module.exports = function workClaims(db) {
  const q = sql => db.connection.prepare(sql);
  return {
    claim(input = {}) { return protect(() => db.withTransaction(() => {
      const projectId = required(input.projectId, 'projectId');
      const itemType = required(input.itemType, 'itemType');
      const itemId = required(input.itemId, 'itemId');
      const stamp = now();
      // A prepared worktree can still contain an active Run after its lease
      // expires. Keep its slot until explicit recovery/release.
      q("UPDATE work_claims SET status='expired',updated_at=? WHERE status='active' AND worktree_path IS NULL AND expires_at<=?").run(stamp, stamp);
      if (q("SELECT id FROM work_claims WHERE status='active' LIMIT 1").get()) throw new PersistenceError('CONFLICT', '已有正在处理的工作项；当前全局并发上限为 1');
      const id = newId(), token = newId();
      const expiresAt = new Date(Date.now() + Math.max(60, Math.min(3600, Number(input.leaseSeconds) || 600)) * 1000).toISOString();
      q('INSERT INTO work_claims(id,project_id,item_type,item_id,owner,token,expires_at,branch_name,worktree_path,base_sha,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id,projectId,itemType,itemId,required(input.owner,'owner'),token,expiresAt,input.branchName||null,input.worktreePath||null,input.baseSha||null,'active',stamp,stamp);
      return mapRow(q('SELECT * FROM work_claims WHERE id=?').get(id));
    })); },
    get(id) { return protect(() => mapRow(q('SELECT * FROM work_claims WHERE id=?').get(required(id,'id')))); },
    attach(id,token,input={}) { return protect(() => { const result=q("UPDATE work_claims SET branch_name=?,worktree_path=?,base_sha=?,updated_at=? WHERE id=? AND token=? AND status='active'").run(required(input.branchName,'branchName'),required(input.worktreePath,'worktreePath'),required(input.baseSha,'baseSha'),now(),required(id,'id'),required(token,'token')); if(!result.changes)throw new PersistenceError('CONFLICT','租约不存在或已结束'); return mapRow(q('SELECT * FROM work_claims WHERE id=?').get(id)); }); },
    expireStale() { return protect(() => { const stamp=now(); return { expired: q("UPDATE work_claims SET status='expired',updated_at=? WHERE status='active' AND worktree_path IS NULL AND expires_at<=?").run(stamp,stamp).changes }; }); },
    list({projectId,itemType,itemId,status} = {}) { return protect(() => { let sql='SELECT * FROM work_claims WHERE 1=1',args=[]; for(const [v,c] of [[projectId,'project_id'],[itemType,'item_type'],[itemId,'item_id'],[status,'status']]) if(v){sql+=` AND ${c}=?`;args.push(v);} return mapRows(q(`${sql} ORDER BY created_at DESC`).all(...args)); }); },
    renew(id,token,leaseSeconds=600) { return protect(() => { const expiresAt=new Date(Date.now()+Math.max(60,Math.min(3600,Number(leaseSeconds)||600))*1000).toISOString(); const result=q("UPDATE work_claims SET expires_at=?,updated_at=? WHERE id=? AND token=? AND status='active' AND expires_at>?").run(expiresAt,now(),required(id,'id'),required(token,'token'),now()); if(!result.changes)throw new PersistenceError('CONFLICT','租约已失效'); return mapRow(q('SELECT * FROM work_claims WHERE id=?').get(id)); }); },
    release(id,token) { return protect(() => { const result=q("UPDATE work_claims SET status='released',updated_at=? WHERE id=? AND token=? AND status='active'").run(now(),required(id,'id'),required(token,'token')); if(!result.changes)throw new PersistenceError('CONFLICT','租约不存在或已结束'); return mapRow(q('SELECT * FROM work_claims WHERE id=?').get(id)); }); },
  };
};
