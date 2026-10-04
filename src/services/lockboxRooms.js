const crypto = require("crypto");
const { query, withClient } = require("../db/pool");
const { hashPassword, verifyPassword } = require("../utils/crypto");
const { audit, notify } = require("./audit");

function generateRoomCode() {
  // MMR-XXXX-XXXX using crypto random (not sequential)
  const a = crypto.randomBytes(2).toString("hex").toUpperCase();
  const b = crypto.randomBytes(2).toString("hex").toUpperCase();
  return `MMR-${a}-${b}`;
}

function generateAccessSecret() {
  // 24 bytes -> base32-ish readable secret
  return crypto.randomBytes(18).toString("base64url");
}

async function createRoom(ownerId, { name, description }) {
  if (!name || String(name).trim().length < 1) {
    const err = new Error("Room name required");
    err.code = "VALIDATION";
    throw err;
  }
  let roomCode = generateRoomCode();
  for (let i = 0; i < 5; i++) {
    const clash = await query(`SELECT 1 FROM lockbox_rooms WHERE room_code = $1`, [roomCode]);
    if (!clash.rows[0]) break;
    roomCode = generateRoomCode();
  }
  const accessSecret = generateAccessSecret();
  const secretHash = hashPassword(accessSecret);

  return withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const { rows } = await client.query(
        `INSERT INTO lockbox_rooms (owner_id, room_code, name, description, access_secret_hash)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, owner_id, room_code, name, description, status, credentials_version, created_at`,
        [ownerId, roomCode, String(name).trim().slice(0, 120), description || null, secretHash]
      );
      const room = rows[0];
      await client.query(
        `INSERT INTO lockbox_room_participants (room_id, user_id, role, status)
         VALUES ($1,$2,'owner','active')`,
        [room.id, ownerId]
      );
      await client.query(
        `INSERT INTO lockbox_room_audit (room_id, actor_id, action) VALUES ($1,$2,'room_created')`,
        [room.id, ownerId]
      );
      await client.query("COMMIT");
      // Return plaintext secret ONCE to owner for out-of-band sharing
      return {
        room,
        access: {
          room_code: room.room_code,
          access_secret: accessSecret,
          note: "Share room_code and access_secret only with intended participants. Secret is not stored in plaintext and is shown only now (and after regenerate)."
        }
      };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
  });
}

async function listMyRooms(userId) {
  const { rows } = await query(
    `SELECT r.id, r.room_code, r.name, r.description, r.status, r.owner_id, r.created_at, r.updated_at,
            p.role, p.status AS membership_status, p.joined_at
     FROM lockbox_room_participants p
     JOIN lockbox_rooms r ON r.id = p.room_id
     WHERE p.user_id = $1 AND p.status = 'active' AND r.status = 'active'
     ORDER BY r.updated_at DESC`,
    [userId]
  );
  return rows;
}

async function requireActiveMembership(roomId, userId) {
  const { rows } = await query(
    `SELECT p.*, r.owner_id, r.status AS room_status, r.room_code, r.name
     FROM lockbox_room_participants p
     JOIN lockbox_rooms r ON r.id = p.room_id
     WHERE p.room_id = $1 AND p.user_id = $2`,
    [roomId, userId]
  );
  const m = rows[0];
  if (!m) {
    const err = new Error("Not a participant of this room");
    err.code = "FORBIDDEN";
    throw err;
  }
  if (m.status === "revoked") {
    const err = new Error("Access to this room has been revoked");
    err.code = "REVOKED";
    throw err;
  }
  if (m.room_status !== "active") {
    const err = new Error("Room is not active");
    err.code = "ROOM_CLOSED";
    throw err;
  }
  return m;
}

async function joinRoomWithCredentials(userId, { room_code, access_secret }) {
  const code = String(room_code || "").trim().toUpperCase();
  const secret = String(access_secret || "").trim();
  if (!code || !secret) {
    const err = new Error("room_code and access_secret required");
    err.code = "VALIDATION";
    throw err;
  }
  const { rows } = await query(`SELECT * FROM lockbox_rooms WHERE room_code = $1 AND status = 'active'`, [code]);
  const room = rows[0];
  if (!room || !verifyPassword(secret, room.access_secret_hash)) {
    const err = new Error("Invalid room credentials");
    err.code = "INVALID_CREDENTIALS";
    throw err;
  }
  const existing = await query(
    `SELECT * FROM lockbox_room_participants WHERE room_id = $1 AND user_id = $2`,
    [room.id, userId]
  );
  if (existing.rows[0]) {
    if (existing.rows[0].status === "revoked") {
      const err = new Error("Your access to this room was revoked. Contact the room owner.");
      err.code = "REVOKED";
      throw err;
    }
    await query(
      `UPDATE lockbox_room_participants SET last_auth_sync_at = NOW() WHERE room_id = $1 AND user_id = $2`,
      [room.id, userId]
    );
    return { room: publicRoom(room), membership: existing.rows[0], rejoined: true };
  }
  if (room.owner_id === userId) {
    return { room: publicRoom(room), membership: { role: "owner", status: "active" }, rejoined: true };
  }
  const { rows: part } = await query(
    `INSERT INTO lockbox_room_participants (room_id, user_id, role, status, last_auth_sync_at)
     VALUES ($1,$2,'member','active',NOW()) RETURNING *`,
    [room.id, userId]
  );
  await query(
    `INSERT INTO lockbox_room_audit (room_id, actor_id, action, target_user_id) VALUES ($1,$2,'participant_joined',$3)`,
    [room.id, userId, userId]
  );
  await notify(room.owner_id, "Lockbox room join", "A user joined room " + room.room_code, "/#/lockbox");
  return { room: publicRoom(room), membership: part[0], rejoined: false };
}

function publicRoom(r) {
  return {
    id: r.id,
    room_code: r.room_code,
    name: r.name,
    description: r.description,
    owner_id: r.owner_id,
    status: r.status,
    credentials_version: r.credentials_version,
    created_at: r.created_at,
    updated_at: r.updated_at
  };
}

async function regenerateCredentials(ownerId, roomId) {
  const { rows } = await query(`SELECT * FROM lockbox_rooms WHERE id = $1`, [roomId]);
  const room = rows[0];
  if (!room || room.owner_id !== ownerId) {
    const err = new Error("Only the room owner can regenerate credentials");
    err.code = "FORBIDDEN";
    throw err;
  }
  const accessSecret = generateAccessSecret();
  const { rows: updated } = await query(
    `UPDATE lockbox_rooms SET access_secret_hash = $1, credentials_version = credentials_version + 1, updated_at = NOW()
     WHERE id = $2 RETURNING id, room_code, name, credentials_version`,
    [hashPassword(accessSecret), roomId]
  );
  await query(
    `INSERT INTO lockbox_room_audit (room_id, actor_id, action) VALUES ($1,$2,'credentials_regenerated')`,
    [roomId, ownerId]
  );
  // Existing participants remain authorized unless owner revokes them
  return {
    room: updated[0],
    access: {
      room_code: updated[0].room_code,
      access_secret: accessSecret,
      note: "Old access_secret is invalid. Existing members stay authorized until revoked."
    }
  };
}

async function revokeParticipant(ownerId, roomId, targetUserId) {
  const { rows } = await query(`SELECT * FROM lockbox_rooms WHERE id = $1`, [roomId]);
  if (!rows[0] || rows[0].owner_id !== ownerId) {
    const err = new Error("Only the room owner can revoke access");
    err.code = "FORBIDDEN";
    throw err;
  }
  if (targetUserId === ownerId) {
    const err = new Error("Owner cannot revoke themselves");
    err.code = "VALIDATION";
    throw err;
  }
  await query(
    `UPDATE lockbox_room_participants SET status = 'revoked', revoked_at = NOW(), revoked_by = $1
     WHERE room_id = $2 AND user_id = $3`,
    [ownerId, roomId, targetUserId]
  );
  await query(
    `INSERT INTO lockbox_room_audit (room_id, actor_id, action, target_user_id) VALUES ($1,$2,'participant_revoked',$3)`,
    [roomId, ownerId, targetUserId]
  );
  return { ok: true };
}

async function listParticipants(userId, roomId) {
  await requireActiveMembership(roomId, userId);
  const { rows } = await query(
    `SELECT p.user_id, p.role, p.status, p.joined_at, u.full_name, u.phone
     FROM lockbox_room_participants p
     JOIN users u ON u.id = p.user_id
     WHERE p.room_id = $1
     ORDER BY p.joined_at`,
    [roomId]
  );
  return rows;
}

/**
 * Sync outgoing pending messages + fetch new messages for authorized rooms.
 */
async function syncRoom(userId, roomId, { outgoing = [], since } = {}) {
  await requireActiveMembership(roomId, userId);

  const accepted = [];
  const duplicates = [];
  const failed = [];

  for (const msg of outgoing) {
    const clientMessageId = String(msg.client_message_id || msg.clientMessageId || "").trim();
    const body = String(msg.body || "").trim();
    if (!clientMessageId || !body) {
      failed.push({ client_message_id: clientMessageId, error: "client_message_id and body required" });
      continue;
    }
    try {
      const { rows } = await query(
        `INSERT INTO lockbox_room_messages (
           room_id, sender_id, client_message_id, body, message_type, sync_status, synchronized_at
         ) VALUES ($1,$2,$3,$4,$5,'synced',NOW())
         ON CONFLICT (room_id, client_message_id) DO NOTHING
         RETURNING *`,
        [roomId, userId, clientMessageId, body.slice(0, 5000), msg.message_type || "text"]
      );
      if (rows[0]) {
        accepted.push(rows[0]);
      } else {
        const existing = await query(
          `SELECT * FROM lockbox_room_messages WHERE room_id = $1 AND client_message_id = $2`,
          [roomId, clientMessageId]
        );
        duplicates.push(existing.rows[0]);
      }
    } catch (e) {
      failed.push({ client_message_id: clientMessageId, error: e.message });
    }
  }

  if (accepted.length) {
    await query(`UPDATE lockbox_rooms SET updated_at = NOW() WHERE id = $1`, [roomId]);
  }

  const sinceTs = since || new Date(0).toISOString();
  const { rows: incoming } = await query(
    `SELECT id, room_id, sender_id, client_message_id, body, message_type, sync_status,
            created_at, synchronized_at, is_deleted
     FROM lockbox_room_messages
     WHERE room_id = $1 AND is_deleted = FALSE
       AND (synchronized_at > $2 OR created_at > $2)
       AND sender_id <> $3
     ORDER BY created_at ASC
     LIMIT 500`,
    [roomId, sinceTs, userId]
  );

  await query(
    `INSERT INTO lockbox_sync_cursors (user_id, room_id, last_synced_at)
     VALUES ($1,$2,NOW())
     ON CONFLICT (user_id, room_id) DO UPDATE SET last_synced_at = NOW()`,
    [userId, roomId]
  );

  // membership auth refresh
  await query(
    `UPDATE lockbox_room_participants SET last_auth_sync_at = NOW()
     WHERE room_id = $1 AND user_id = $2`,
    [roomId, userId]
  );

  return {
    room_id: roomId,
    accepted: accepted.map(publicMessage),
    duplicates: duplicates.filter(Boolean).map(publicMessage),
    failed,
    incoming: incoming.map(publicMessage),
    server_time: new Date().toISOString()
  };
}

function publicMessage(m) {
  if (!m) return null;
  return {
    id: m.id,
    room_id: m.room_id,
    sender_id: m.sender_id,
    client_message_id: m.client_message_id,
    body: m.body,
    message_type: m.message_type,
    sync_status: m.sync_status,
    created_at: m.created_at,
    synchronized_at: m.synchronized_at,
    is_deleted: m.is_deleted
  };
}

async function getMessages(userId, roomId, { limit = 100, before } = {}) {
  await requireActiveMembership(roomId, userId);
  const params = [roomId];
  let sql = `SELECT * FROM lockbox_room_messages WHERE room_id = $1 AND is_deleted = FALSE`;
  if (before) {
    params.push(before);
    sql += ` AND created_at < $${params.length}`;
  }
  params.push(Math.min(Number(limit) || 100, 500));
  sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;
  const { rows } = await query(sql, params);
  return rows.reverse().map(publicMessage);
}

async function offlineBootstrap(userId) {
  /** Payload clients cache locally after online session for offline room access */
  const rooms = await listMyRooms(userId);
  const bootstrap = [];
  for (const r of rooms) {
    const msgs = await getMessages(userId, r.id, { limit: 100 });
    bootstrap.push({
      room: {
        id: r.id,
        room_code: r.room_code,
        name: r.name,
        description: r.description,
        owner_id: r.owner_id,
        role: r.role,
        membership_status: r.membership_status
      },
      messages: msgs,
      authorization: {
        user_id: userId,
        room_id: r.id,
        status: "active",
        cached_at: new Date().toISOString(),
        note: "Client must encrypt this cache at rest. Revocation applies on next online sync."
      }
    });
  }
  return {
    offline_capable: true,
    user_id: userId,
    rooms: bootstrap,
    limitation:
      "While completely offline, each device only has its own local cache. New messages reach the other party after sync when a data path is available."
  };
}

module.exports = {
  createRoom,
  listMyRooms,
  joinRoomWithCredentials,
  regenerateCredentials,
  revokeParticipant,
  listParticipants,
  requireActiveMembership,
  syncRoom,
  getMessages,
  offlineBootstrap,
  publicRoom,
  publicMessage
};
