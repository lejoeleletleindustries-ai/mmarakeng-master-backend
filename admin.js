const express = require("express");
const { query } = require("../db/pool");
const { requireAdmin, requireOwner, publicUser } = require("../middleware/auth");
const { hashPassword } = require("../utils/crypto");
const { audit, notify } = require("../services/audit");
const router = express.Router();

router.get("/queue", requireAdmin, async (_req, res) => {
  const { rows } = await query(
    `SELECT l.*, u.full_name AS user_name, u.phone AS user_phone FROM listings l
     JOIN users u ON u.id = l.user_id
     WHERE l.status IN ('submitted','under_review','more_info')
     ORDER BY l.created_at ASC LIMIT 200`
  );
  res.json({ listings: rows });
});

router.get("/listings", requireAdmin, async (req, res) => {
  const { rows } = await query(
    `SELECT l.*, u.full_name AS user_name FROM listings l
     JOIN users u ON u.id = l.user_id ORDER BY l.created_at DESC LIMIT 500`
  );
  res.json({ listings: rows });
});

router.post("/listings/:id/status", requireAdmin, async (req, res) => {
  const { status, notes, reason } = req.body || {};
  const allowed = ["draft","submitted","under_review","more_info","rejected","approved","verified","published","suspended","awaiting_payment"];
  if (!allowed.includes(status)) return res.status(400).json({ error: "Invalid status." });
  const { rows } = await query("SELECT * FROM listings WHERE id = $1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Not found." });
  const published_at = status === "published" ? new Date() : rows[0].published_at;
  const { rows: updated } = await query(
    `UPDATE listings SET status = $1, verified_by = $2, verified_at = NOW(), published_at = $3, updated_at = NOW()
     WHERE id = $4 RETURNING *`,
    [status, req.user.full_name, published_at, req.params.id]
  );
  await audit(req.user.id, "listing_" + status, "listing", req.params.id, reason || notes, null);
  await notify(rows[0].user_id, `Listing ${status}`, `"${rows[0].title}" is now ${status}.`, `/#/listing/${rows[0].id}`);
  res.json({ ok: true, listing: updated[0] });
});

router.post("/listings/:id/delete", requireAdmin, async (req, res) => {
  const { rows } = await query("SELECT * FROM listings WHERE id = $1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Not found." });
  await query("DELETE FROM listings WHERE id = $1", [req.params.id]);
  await audit(req.user.id, "listing_deleted", "listing", req.params.id, req.body?.reason || null, null);
  await notify(rows[0].user_id, "Listing removed", `"${rows[0].title}" was removed by admin.`, "/#/my-listings");
  res.json({ ok: true });
});

router.get("/users", requireAdmin, async (_req, res) => {
  const { rows } = await query(
    `SELECT id, full_name, phone, email, role, is_owner, location, created_at FROM users ORDER BY created_at DESC LIMIT 500`
  );
  res.json({ users: rows });
});

router.post("/users/:id/reset-password", requireAdmin, async (req, res) => {
  const { rows } = await query("SELECT * FROM users WHERE id = $1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Not found." });
  if (rows[0].is_owner || rows[0].role === "owner") {
    return res.status(403).json({ error: "Cannot reset owner password via this endpoint." });
  }
  const np = req.body?.new_password;
  if (!np || String(np).length < 6) return res.status(400).json({ error: "Password min 6 chars." });
  await query("UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2", [hashPassword(np), req.params.id]);
  await audit(req.user.id, "admin_reset_password", "user", req.params.id, null, { phone: rows[0].phone });
  res.json({ ok: true, message: "Password reset for " + rows[0].phone });
});

router.get("/support", requireAdmin, async (_req, res) => {
  const { rows } = await query(
    `SELECT t.*, u.full_name AS user_name, u.phone AS user_phone FROM support_tickets t
     JOIN users u ON u.id = t.user_id ORDER BY t.created_at DESC LIMIT 200`
  );
  res.json({ tickets: rows });
});

router.post("/support/:id/reply", requireAdmin, async (req, res) => {
  const { rows } = await query(
    `UPDATE support_tickets SET admin_reply = $1, status = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
    [req.body?.reply || "", req.body?.status || "answered", req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Not found." });
  await notify(rows[0].user_id, "Support reply", (req.body?.reply || "").slice(0, 100), "/#/support");
  res.json({ ticket: rows[0] });
});

router.get("/platform-stats", requireAdmin, async (_req, res) => {
  const users = await query(`SELECT COUNT(*)::int AS c FROM users WHERE role <> 'owner'`);
  const active = await query(
    `SELECT COUNT(DISTINCT viewer_id)::int AS c FROM listing_views
     WHERE created_at > NOW() - INTERVAL '24 hours' AND viewer_id IS NOT NULL`
  );
  const businesses = await query(`SELECT COUNT(*)::int AS c FROM businesses`);
  const listings = await query(`SELECT COUNT(*)::int AS c FROM listings`);
  const published = await query(`SELECT COUNT(*)::int AS c FROM listings WHERE status IN ('published','verified')`);
  const digitalSales = await query(`SELECT COUNT(*)::int AS c FROM digital_purchases WHERE status = 'completed'`);
  const subs = await query(`SELECT COUNT(*)::int AS c FROM user_subscriptions WHERE status = 'active'`);
  const owners = await query(`SELECT id, full_name, email FROM users WHERE is_owner = TRUE OR role = 'owner'`);
  res.json({
    registered_users: users.rows[0].c,
    active_users_24h: active.rows[0].c,
    businesses: businesses.rows[0].c,
    listings_total: listings.rows[0].c,
    listings_published: published.rows[0].c,
    digital_sales: digitalSales.rows[0].c,
    active_subscriptions: subs.rows[0].c,
    owners: owners.rows,
    note: "Active users = accounts with measurable activity in last 24h. Install counts are not claimed without device registration."
  });
});

router.get("/audit", requireAdmin, async (_req, res) => {
  const { rows } = await query(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200`);
  res.json({ audit: rows });
});

router.post("/owners/admins", requireOwner, async (req, res) => {
  const { full_name, phone, password, permissions } = req.body || {};
  if (!full_name || !phone || !password || String(password).length < 6) {
    return res.status(400).json({ error: "Name, phone, password required." });
  }
  const exists = await query("SELECT id FROM users WHERE phone = $1", [String(phone).trim()]);
  if (exists.rows[0]) return res.status(400).json({ error: "Phone already registered." });
  const { rows } = await query(
    `INSERT INTO users (full_name, phone, password_hash, role, phone_verified)
     VALUES ($1,$2,$3,'admin',TRUE) RETURNING *`,
    [full_name.trim(), String(phone).trim(), hashPassword(password)]
  );
  await query(
    `INSERT INTO admin_permissions (user_id, permissions) VALUES ($1,$2)`,
    [rows[0].id, JSON.stringify(permissions || { listings: true, users: true, support: true, digital: true })]
  );
  await audit(req.user.id, "admin_created", "user", rows[0].id, null, { phone });
  res.json({ ok: true, admin: publicUser(rows[0]) });
});

router.post("/payments/:id/confirm", requireAdmin, async (req, res) => {
  const { rows } = await query("SELECT * FROM payment_transactions WHERE id = $1", [req.params.id]);
  const tx = rows[0];
  if (!tx) return res.status(404).json({ error: "Not found." });
  await query(`UPDATE payment_transactions SET status = 'successful', updated_at = NOW() WHERE id = $1`, [tx.id]);
  let listing = null;
  if (tx.purpose === "listing_publish" && tx.listing_id) {
    const u = await query(
      `UPDATE listings SET status = 'published', published_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`,
      [tx.listing_id]
    );
    listing = u.rows[0];
    if (listing) await notify(listing.user_id, "Listing published", `"${listing.title}" is live.`, `/#/listing/${listing.id}`);
  }
  if (tx.purpose === "digital_purchase" && tx.product_id) {
    await query(
      `UPDATE digital_purchases SET status = 'completed', updated_at = NOW()
       WHERE payment_tx_id = $1`,
      [tx.id]
    );
    if (tx.user_id) await notify(tx.user_id, "Purchase complete", "Your digital product is ready.", "/#/my-purchases");
  }
  if (tx.purpose === "subscription" && tx.plan_id && tx.user_id) {
    const plan = await query("SELECT * FROM subscription_plans WHERE id = $1", [tx.plan_id]);
    const days = plan.rows[0]?.duration_days || 30;
    await query(
      `INSERT INTO user_subscriptions (user_id, plan_id, status, starts_at, expires_at, payment_tx_id)
       VALUES ($1,$2,'active',NOW(), NOW() + ($3 || ' days')::interval, $4)`,
      [tx.user_id, tx.plan_id, String(days), tx.id]
    );
  }
  await audit(req.user.id, "payment_confirmed", "payment", tx.id, req.body?.notes || null, { amount: tx.amount });
  res.json({ payment: { ...tx, status: "successful" }, listing });
});

module.exports = router;
