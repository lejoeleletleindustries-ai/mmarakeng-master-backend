const express = require("express");
const rateLimit = require("express-rate-limit");
const { query } = require("../db/pool");
const { requireAuth, requireOwner } = require("../middleware/auth");
const { lockboxCode } = require("../utils/crypto");
const { notify, audit } = require("../services/audit");
const Rooms = require("../services/lockboxRooms");
const router = express.Router();

const joinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many room join attempts. Try later." }
});

/* ========== ROOM-BASED LOCKBOX (offline-capable) ========== */

router.post("/rooms", requireAuth, async (req, res) => {
  try {
    const result = await Rooms.createRoom(req.user.id, {
      name: req.body?.name,
      description: req.body?.description
    });
    res.status(201).json(result);
  } catch (e) {
    res.status(e.code === "VALIDATION" ? 400 : 500).json({ error: e.message });
  }
});

router.get("/rooms", requireAuth, async (req, res) => {
  const rooms = await Rooms.listMyRooms(req.user.id);
  res.json({ rooms });
});

/** Bootstrap payload for client offline cache (encrypt at rest on device) */
router.get("/rooms/offline-bootstrap", requireAuth, async (req, res) => {
  const data = await Rooms.offlineBootstrap(req.user.id);
  res.json(data);
});

router.post("/rooms/join", requireAuth, joinLimiter, async (req, res) => {
  try {
    const result = await Rooms.joinRoomWithCredentials(req.user.id, {
      room_code: req.body?.room_code,
      access_secret: req.body?.access_secret
    });
    res.json(result);
  } catch (e) {
    const map = { VALIDATION: 400, INVALID_CREDENTIALS: 401, REVOKED: 403, FORBIDDEN: 403 };
    res.status(map[e.code] || 500).json({ error: e.message, code: e.code || null });
  }
});

router.get("/rooms/:roomId", requireAuth, async (req, res) => {
  try {
    const membership = await Rooms.requireActiveMembership(req.params.roomId, req.user.id);
    const { rows } = await query(`SELECT id, owner_id, room_code, name, description, status, created_at, updated_at FROM lockbox_rooms WHERE id = $1`, [req.params.roomId]);
    res.json({ room: rows[0], membership: { role: membership.role, status: membership.status } });
  } catch (e) {
    res.status(e.code === "FORBIDDEN" || e.code === "REVOKED" ? 403 : 500).json({ error: e.message, code: e.code || null });
  }
});

router.get("/rooms/:roomId/messages", requireAuth, async (req, res) => {
  try {
    const messages = await Rooms.getMessages(req.user.id, req.params.roomId, {
      limit: req.query.limit,
      before: req.query.before
    });
    res.json({ messages });
  } catch (e) {
    res.status(e.code === "FORBIDDEN" || e.code === "REVOKED" ? 403 : 500).json({ error: e.message });
  }
});

router.get("/rooms/:roomId/participants", requireAuth, async (req, res) => {
  try {
    const participants = await Rooms.listParticipants(req.user.id, req.params.roomId);
    res.json({ participants });
  } catch (e) {
    res.status(e.code === "FORBIDDEN" || e.code === "REVOKED" ? 403 : 500).json({ error: e.message });
  }
});

router.post("/rooms/:roomId/credentials/regenerate", requireAuth, async (req, res) => {
  try {
    const result = await Rooms.regenerateCredentials(req.user.id, req.params.roomId);
    res.json(result);
  } catch (e) {
    res.status(e.code === "FORBIDDEN" ? 403 : 500).json({ error: e.message });
  }
});

router.post("/rooms/:roomId/participants/:userId/revoke", requireAuth, async (req, res) => {
  try {
    await Rooms.revokeParticipant(req.user.id, req.params.roomId, req.params.userId);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.code === "FORBIDDEN" || e.code === "VALIDATION" ? 403 : 500).json({ error: e.message });
  }
});

/**
 * Offline-first sync:
 * POST { outgoing: [{ client_message_id, body, message_type? }], since?: ISO timestamp }
 * Returns accepted/duplicates/failed + incoming messages for this room.
 */
router.post("/rooms/:roomId/sync", requireAuth, async (req, res) => {
  try {
    const result = await Rooms.syncRoom(req.user.id, req.params.roomId, {
      outgoing: Array.isArray(req.body?.outgoing) ? req.body.outgoing : [],
      since: req.body?.since
    });
    res.json(result);
  } catch (e) {
    res.status(e.code === "FORBIDDEN" || e.code === "REVOKED" ? 403 : 500).json({ error: e.message, code: e.code || null });
  }
});

router.get("/sync/status", requireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT room_id, last_synced_at FROM lockbox_sync_cursors WHERE user_id = $1`,
    [req.user.id]
  );
  res.json({ cursors: rows, server_time: new Date().toISOString() });
});

/* ========== LEGACY pairwise lockbox (kept for compatibility) ========== */

router.get("/users/search", requireAuth, async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 2) return res.json({ users: [] });
  const { rows } = await query(
    `SELECT id, full_name, phone FROM users
     WHERE id <> $1 AND role <> 'owner'
       AND (phone ILIKE $2 OR full_name ILIKE $2)
     LIMIT 20`,
    [req.user.id, "%" + q + "%"]
  );
  res.json({ users: rows });
});

router.post("/invite", requireAuth, async (req, res) => {
  const to_user_id = req.body?.to_user_id;
  if (!to_user_id || to_user_id === req.user.id) {
    return res.status(400).json({ error: "Select another user to invite." });
  }
  const active = await query(
    `SELECT * FROM lockboxes WHERE status = 'active'
       AND ((user_a = $1 AND user_b = $2) OR (user_a = $2 AND user_b = $1)) LIMIT 1`,
    [req.user.id, to_user_id]
  );
  if (active.rows[0]) return res.json({ already_active: true, lockbox: active.rows[0] });
  const pending = await query(
    `SELECT * FROM lockbox_invites WHERE status = 'pending'
       AND ((from_user_id = $1 AND to_user_id = $2) OR (from_user_id = $2 AND to_user_id = $1)) LIMIT 1`,
    [req.user.id, to_user_id]
  );
  if (pending.rows[0]) return res.status(400).json({ error: "Invitation already pending." });
  const { rows } = await query(
    `INSERT INTO lockbox_invites (from_user_id, to_user_id, status) VALUES ($1,$2,'pending') RETURNING *`,
    [req.user.id, to_user_id]
  );
  await notify(to_user_id, "Lockbox invitation", "You were invited to a private Mmarakeng Lockbox.", "/#/lockbox");
  res.json({ invite: rows[0] });
});

router.get("/invites", requireAuth, async (req, res) => {
  const incoming = await query(
    `SELECT i.*, u.full_name AS from_name, u.phone AS from_phone FROM lockbox_invites i
     JOIN users u ON u.id = i.from_user_id
     WHERE i.to_user_id = $1 AND i.status = 'pending'`,
    [req.user.id]
  );
  const outgoing = await query(
    `SELECT i.*, u.full_name AS to_name FROM lockbox_invites i
     JOIN users u ON u.id = i.to_user_id
     WHERE i.from_user_id = $1 AND i.status = 'pending'`,
    [req.user.id]
  );
  res.json({
    incoming: incoming.rows.map((r) => ({ ...r, from_user: { id: r.from_user_id, full_name: r.from_name, phone: r.from_phone } })),
    outgoing: outgoing.rows.map((r) => ({ ...r, to_user: { id: r.to_user_id, full_name: r.to_name } }))
  });
});

router.post("/invites/:id/accept", requireAuth, async (req, res) => {
  const { rows } = await query("SELECT * FROM lockbox_invites WHERE id = $1", [req.params.id]);
  const invite = rows[0];
  if (!invite || invite.to_user_id !== req.user.id) return res.status(404).json({ error: "Invitation not found." });
  if (invite.status !== "pending") return res.status(400).json({ error: "Not pending." });
  await query("UPDATE lockbox_invites SET status = 'accepted', updated_at = NOW() WHERE id = $1", [invite.id]);
  const code = lockboxCode();
  const { rows: boxes } = await query(
    `INSERT INTO lockboxes (lockbox_code, user_a, user_b, status) VALUES ($1,$2,$3,'active') RETURNING *`,
    [code, invite.from_user_id, invite.to_user_id]
  );
  await notify(invite.from_user_id, "Lockbox accepted", "Your Lockbox is ready.", `/#/lockbox/${boxes[0].id}`);
  res.json({ lockbox: boxes[0] });
});

router.post("/invites/:id/decline", requireAuth, async (req, res) => {
  await query(
    `UPDATE lockbox_invites SET status = 'declined', updated_at = NOW() WHERE id = $1 AND to_user_id = $2`,
    [req.params.id, req.user.id]
  );
  res.json({ ok: true });
});

router.get("/", requireAuth, async (req, res) => {
  const rooms = await Rooms.listMyRooms(req.user.id);
  const { rows } = await query(
    `SELECT b.*, CASE WHEN b.user_a = $1 THEN b.user_b ELSE b.user_a END AS peer_id
     FROM lockboxes b
     WHERE (b.user_a = $1 OR b.user_b = $1) AND b.status <> 'closed'
     ORDER BY b.updated_at DESC`,
    [req.user.id]
  );
  const legacy = [];
  for (const b of rows) {
    const peer = await query("SELECT id, full_name, phone FROM users WHERE id = $1", [b.peer_id]);
    legacy.push({ ...b, peer: peer.rows[0] });
  }
  res.json({ rooms, lockboxes: legacy });
});

router.get("/:id", requireAuth, async (req, res) => {
  // Prefer room UUID if exists
  const roomTry = await query(`SELECT id FROM lockbox_rooms WHERE id = $1`, [req.params.id]);
  if (roomTry.rows[0]) {
    try {
      await Rooms.requireActiveMembership(req.params.id, req.user.id);
      const messages = await Rooms.getMessages(req.user.id, req.params.id, { limit: 200 });
      return res.json({ type: "room", room_id: req.params.id, messages });
    } catch (e) {
      return res.status(403).json({ error: e.message });
    }
  }
  const { rows } = await query("SELECT * FROM lockboxes WHERE id = $1", [req.params.id]);
  const box = rows[0];
  if (!box || (box.user_a !== req.user.id && box.user_b !== req.user.id)) {
    return res.status(403).json({ error: "Not authorized for this Lockbox." });
  }
  if (box.status === "blocked") return res.status(403).json({ error: "Lockbox blocked." });
  const msgs = await query(
    `SELECT id, from_user_id, body, is_read, created_at, hidden_for FROM lockbox_messages
     WHERE lockbox_id = $1 ORDER BY created_at ASC`,
    [box.id]
  );
  const visible = msgs.rows.filter((m) => !(m.hidden_for || []).includes(req.user.id));
  const peerId = box.user_a === req.user.id ? box.user_b : box.user_a;
  const peer = await query("SELECT id, full_name, phone FROM users WHERE id = $1", [peerId]);
  res.json({
    type: "legacy",
    lockbox: box,
    peer: peer.rows[0],
    messages: visible,
    note: "Messages are stored on the central Mmarakeng server."
  });
});

router.post("/:id/messages", requireAuth, async (req, res) => {
  const roomTry = await query(`SELECT id FROM lockbox_rooms WHERE id = $1`, [req.params.id]);
  if (roomTry.rows[0]) {
    try {
      const client_message_id = req.body?.client_message_id || require("crypto").randomUUID();
      const result = await Rooms.syncRoom(req.user.id, req.params.id, {
        outgoing: [{ client_message_id, body: req.body?.body, message_type: req.body?.message_type || "text" }]
      });
      return res.json({ message: result.accepted[0] || result.duplicates[0], sync: result });
    } catch (e) {
      return res.status(403).json({ error: e.message });
    }
  }
  const { rows } = await query("SELECT * FROM lockboxes WHERE id = $1", [req.params.id]);
  const box = rows[0];
  if (!box || box.status !== "active" || (box.user_a !== req.user.id && box.user_b !== req.user.id)) {
    return res.status(403).json({ error: "Not authorized." });
  }
  const body = String(req.body?.body || "").trim();
  if (!body) return res.status(400).json({ error: "Message required." });
  const { rows: msgs } = await query(
    `INSERT INTO lockbox_messages (lockbox_id, from_user_id, body) VALUES ($1,$2,$3) RETURNING id, from_user_id, body, created_at`,
    [box.id, req.user.id, body.slice(0, 5000)]
  );
  await query("UPDATE lockboxes SET updated_at = NOW() WHERE id = $1", [box.id]);
  const peerId = box.user_a === req.user.id ? box.user_b : box.user_a;
  await notify(peerId, "New Lockbox message", body.slice(0, 80), `/#/lockbox/${box.id}`);
  res.json({ message: msgs[0] });
});

router.post("/:id/close", requireAuth, async (req, res) => {
  await query(
    `UPDATE lockboxes SET status = 'closed', closed_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND (user_a = $2 OR user_b = $2)`,
    [req.params.id, req.user.id]
  );
  res.json({ ok: true });
});

router.post("/:id/block", requireAuth, async (req, res) => {
  await query(
    `UPDATE lockboxes SET status = 'blocked', updated_at = NOW()
     WHERE id = $1 AND (user_a = $2 OR user_b = $2)`,
    [req.params.id, req.user.id]
  );
  res.json({ ok: true });
});

router.get("/owner/access/:id", requireOwner, async (req, res) => {
  const reason = req.query.reason || "lawful_review";
  const { rows } = await query("SELECT * FROM lockboxes WHERE id = $1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Not found." });
  await audit(req.user.id, "lockbox_owner_access", "lockbox", req.params.id, reason, null);
  await query(
    `INSERT INTO lockbox_audit (lockbox_id, actor_id, action, reason) VALUES ($1,$2,'owner_access',$3)`,
    [req.params.id, req.user.id, reason]
  );
  const msgs = await query("SELECT * FROM lockbox_messages WHERE lockbox_id = $1 ORDER BY created_at", [req.params.id]);
  res.json({ lockbox: rows[0], messages: msgs.rows, warning: "Access logged for audit." });
});

module.exports = router;
