'use strict';const{now,required,mapRow}=require('./common.cjs');const{protect}=require('../errors.cjs');
module.exports=function legacyIds(db){const q=s=>db.connection.prepare(s);return{
 register(input={}){return protect(()=>{q('INSERT INTO legacy_ids(entity_type,legacy_id,entity_id,created_at) VALUES(?,?,?,?) ON CONFLICT(entity_type,legacy_id) DO UPDATE SET entity_id=excluded.entity_id').run(required(input.entityType,'entityType'),required(input.legacyId,'legacyId'),required(input.entityId,'entityId'),now());return mapRow(q('SELECT * FROM legacy_ids WHERE entity_type=? AND legacy_id=?').get(input.entityType,input.legacyId));});},
 resolve(entityType,legacyId){return protect(()=>mapRow(q('SELECT * FROM legacy_ids WHERE entity_type=? AND legacy_id=?').get(required(entityType,'entityType'),required(legacyId,'legacyId'))));},
};};
