const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const { v4: uuid } = require("uuid");
const { query } = require("../db/pool");
const { requireAuth, requireOwner } = require("../middleware/auth");
const { audit, notify } = require("../services/audit");
const router = express.Router();

const distressLimit = rateLimit({ windowMs: 60 * 1000, max: 5, message: { error: "Distress rate limited." } });
const evidenceRoot = path.join(process.cwd(), "uploads", "distress");
fs.mkdirSync(evidenceRoot, { recursive: true });

const ALLOWED_EVIDENCE = new Set([".jpg", ".jpeg", ".png", ".webp", ".mp4", ".webm", ".m4a", ".mp3", ".wav"]);
const upload = multer({
  storage: multer.diskStorage({
    destination: (_r, _f, cb) => cb(null, evidenceRoot),
    filename: (_r, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase();
      cb(null, uuid() + (ALLOWED_EVIDENCE.has(ext) ? ext : ".bin"));
    }
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_r, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (!ALLOWED_EVIDENCE.has(ext)) return cb(new Error("Evidence file type not allowed."));
    cb(null, true);
  }
});

/** Trusted contacts CRUD */
router.get("/contacts", requireAuth, async (req, res) => {
  const { rows } = await query(`SELECT id, name, phone, email, relationship, channel, created_at FROM distress_contacts WHERE user_id = $1 ORDER BY created_at`, [req.user.id]);
  res.json({ contacts: rows });
});

router.post("/contacts", requireAuth, async (req, res) => {
  const { name, phone, email, relationship, channel } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required." });
  const { rows } = await query(
    `INSERT INTO distress_contacts (user_id, name, phone, email, relationship, channel)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, phone, email, relationship, channel, created_at`,
    [req.user.id, String(name).slice(0, 120), phone || null, email || null, relationship || null, channel || "sms"]
  );
  res.status(201).json({ contact: rows[0] });
});

router.delete("/contacts/:id", requireAuth, async (req, res) => {
  await query(`DELETE FROM distress_contacts WHERE id = $1 AND user_id = $2`, [req.params.id, req.user.id]);
  res.json({ ok: true });
});

/**
 * Activate distress
 * Emergency provider is NOT active until configured — status not_configured.
 */
router.post("/activate", requireAuth, distressLimit, async (req, res) => {
  const { latitude, longitude, accuracy, note } = req.body || {};
  const { rows } = await query(
    `INSERT INTO distress_events (user_id, status, latitude, longitude, accuracy, note, emergency_provider_status)
     VALUES ($1,'active',$2,$3,$4,$5,'not_configured') RETURNING *`,
    [req.user.id, latitude ?? null, longitude ?? null, accuracy ?? null, note ? String(note).slice(0, 500) : null]
  );
  const event = rows[0];
  await audit(req.user.id, "distress_activated", "distress_event", event.id, null, {
    has_location: latitude != null
  });

  const contacts = await query(`SELECT * FROM distress_contacts WHERE user_id = $1`, [req.user.id]);
  const notifications = [];
  for (const c of contacts.rows) {
    // Provider not live — record PENDING attempt only
    const { rows: n } = await query(
      `INSERT INTO distress_notifications (event_id, contact_id, channel, status, provider_response)
       VALUES ($1,$2,$3,'pending',$4) RETURNING *`,
      [event.id, c.id, c.channel || "sms", "Emergency provider not configured; notification queued only."]
    );
    notifications.push(n[0]);
    if (c.phone || c.email) {
      // In-app notify if contact is also a MMARAKENG user by phone
      try {
        const u = await query(`SELECT id FROM users WHERE phone = $1 LIMIT 1`, [c.phone]);
        if (u.rows[0]) {
          await notify(u.rows[0].id, "Distress alert", `${req.user.full_name || "A contact"} activated a Mmarakeng distress event.`, "/#/distress");
        }
      } catch (_) {}
    }
  }

  res.status(201).json({
    event,
    notifications,
    emergency_provider: {
      active: false,
      status: "not_configured",
      message: "No verified police/emergency provider is connected. Trusted contacts were recorded as pending notifications only."
    }
  });
});

router.get("/events/mine", requireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT id, status, latitude, longitude, accuracy, note, emergency_provider_status, created_at, updated_at, resolved_at
     FROM distress_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [req.user.id]
  );
  res.json({ events: rows });
});

router.post("/events/:id/resolve", requireAuth, async (req, res) => {
  const status = req.body?.status || "resolved";
  const allowed = ["resolved", "cancelled", "false_alarm", "acknowledged"];
  if (!allowed.includes(status)) return res.status(400).json({ error: "Invalid status." });
  const { rows } = await query(
    `UPDATE distress_events SET status = $1, resolved_at = CASE WHEN $1 IN ('resolved','cancelled','false_alarm') THEN NOW() ELSE resolved_at END, updated_at = NOW()
     WHERE id = $2 AND user_id = $3 RETURNING *`,
    [status, req.params.id, req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Not found." });
  await audit(req.user.id, "distress_status_" + status, "distress_event", req.params.id, null, null);
  res.json({ event: rows[0] });
});

/** Evidence upload — OS permissions on client; server only stores authorized files */
router.post("/events/:id/evidence", requireAuth, distressLimit, upload.single("file"), async (req, res) => {
  const { rows } = await query(`SELECT * FROM distress_events WHERE id = $1 AND user_id = $2`, [req.params.id, req.user.id]);
  if (!rows[0]) return res.status(404).json({ error: "Event not found." });
  if (!req.file) return res.status(400).json({ error: "file required." });
  const media_type = (req.body?.media_type || "other").toLowerCase();
  const key = path.join("distress", req.file.filename);
  const { rows: ev } = await query(
    `INSERT INTO distress_evidence (event_id, user_id, media_type, storage_key, file_name, mime_type, size_bytes, latitude, longitude)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, event_id, media_type, created_at, size_bytes`,
    [
      req.params.id, req.user.id, ["audio", "photo", "video", "other"].includes(media_type) ? media_type : "other",
      key, req.file.originalname, req.file.mimetype, req.file.size,
      req.body?.latitude ?? null, req.body?.longitude ?? null
    ]
  );
  await audit(req.user.id, "distress_evidence_upload", "distress_evidence", ev[0].id, null, { event_id: req.params.id });
  res.status(201).json({ evidence: ev[0] });
});

/** Authorized download of own evidence only (or owner with audit) */
router.get("/evidence/:id/download", requireAuth, async (req, res) => {
  const { rows } = await query(`SELECT * FROM distress_evidence WHERE id = $1`, [req.params.id]);
  const ev = rows[0];
  if (!ev) return res.status(404).json({ error: "Not found." });
  const isOwner = req.user.role === "owner" || req.user.is_owner;
  if (ev.user_id !== req.user.id && !isOwner) {
    return res.status(403).json({ error: "Not authorized." });
  }
  if (isOwner && ev.user_id !== req.user.id) {
    await audit(req.user.id, "distress_evidence_owner_access", "distress_evidence", ev.id, req.query.reason || "review", null);
  }
  const abs = path.join(process.cwd(), "uploads", ev.storage_key);
  const resolved = path.resolve(abs);
  if (!resolved.startsWith(path.resolve(evidenceRoot))) {
    return res.status(400).json({ error: "Invalid path." });
  }
  if (!fs.existsSync(resolved)) return res.status(404).json({ error: "File missing." });
  res.download(resolved, ev.file_name || path.basename(resolved));
});

/** Nearest help foundation — no fake stations */
router.get("/nearest-help", requireAuth, async (req, res) => {
  res.json({
    active: false,
    provider: null,
    message: "No verified emergency facility directory is connected. Configure an Emergency Service Provider adapter with official data before nearest-help can return results.",
    user_location: {
      latitude: req.query.lat ? Number(req.query.lat) : null,
      longitude: req.query.lng ? Number(req.query.lng) : null
    }
  });
});

module.exports = router;
