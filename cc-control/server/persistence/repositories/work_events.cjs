'use strict';
const { newId, now, required, mapRows } = require('./common.cjs');
const { protect } = require('../errors.cjs');
module.exports = function workEvents(db) {
  const q = sql => db.connection.prepare(sql);
  return {
    append(input = {}) { return protect(() => {
      const id = input.id || newId();
      q('INSERT OR IGNORE INTO work_events(id,project_id,item_type,item_id,event_type,payload_json,actor_type,idempotency_key,occurred_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, required(input.projectId, 'projectId'), required(input.itemType, 'itemType'), required(input.itemId, 'itemId'), required(input.eventType, 'eventType'), JSON.stringify(input.payload || {}), input.actorType || 'system', input.idempotencyKey || null, now());
      return mapRows(q('SELECT * FROM work_events WHERE project_id=? AND item_type=? AND item_id=? ORDER BY occurred_at DESC LIMIT 1').all(input.projectId, input.itemType, input.itemId))[0] || null;
    }); },
    list(input = {}) { return protect(() => mapRows(q('SELECT * FROM work_events WHERE project_id=? AND item_type=? AND item_id=? ORDER BY occurred_at,id').all(required(input.projectId, 'projectId'), required(input.itemType, 'itemType'), required(input.itemId, 'itemId')))); },
  };
};
