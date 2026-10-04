const { query } = require("../db/pool");

async function audit(actorId, action, targetType, targetId, reason, meta) {
  await query(
    `INSERT INTO audit_logs (actor_id, action, target_type, target_id, reason, meta)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [actorId || null, action, targetType || null, targetId || null, reason || null, meta ? JSON.stringify(meta) : null]
  );
}

async function notify(userId, title, body, link) {
  if (!userId) return;
  await query(
    `INSERT INTO notifications (user_id, title, body, link) VALUES ($1,$2,$3,$4)`,
    [userId, title, body || "", link || null]
  );
}

module.exports = { audit, notify };
