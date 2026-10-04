const express = require("express");
const { query } = require("../db/pool");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { audit, notify } = require("../services/audit");
const router = express.Router();

function effectiveStatus(row) {
  if (row.expires_at && new Date(row.expires_at) < new Date() && ["published", "verified"].includes(row.status)) {
    return { ...row, expired: true, effective_status: "expired" };
  }
  return { ...row, expired: false, effective_status: row.status };
}

router.get("/", async (req, res) => {
  const { category, q, status } = req.query;
  const params = [];
  let sql = `SELECT l.*, u.full_name AS user_name FROM listings l
             JOIN users u ON u.id = l.user_id WHERE 1=1`;
  if (category && category !== "All") {
    params.push(category);
    sql += ` AND l.category = $${params.length}`;
  }
  if (q) {
    params.push("%" + q + "%");
    sql += ` AND (l.title ILIKE $${params.length} OR l.description ILIKE $${params.length})`;
  }
  const st = status || "published";
  if (st === "published") {
    sql += ` AND l.status IN ('published','verified')`;
  } else {
    params.push(st);
    sql += ` AND l.status = $${params.length}`;
  }
  sql += ` ORDER BY l.created_at DESC LIMIT 200`;
  const { rows } = await query(sql, params);
  res.json({ listings: rows.map(effectiveStatus) });
});

router.get("/mine", requireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM listings WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [req.user.id]
  );
  res.json({ listings: rows.map(effectiveStatus) });
});

router.get("/:id", async (req, res) => {
  const { rows } = await query(
    `SELECT l.*, u.full_name AS user_name, u.phone AS user_phone FROM listings l
     JOIN users u ON u.id = l.user_id WHERE l.id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Not found." });
  await query(`INSERT INTO listing_views (listing_id, viewer_id) VALUES ($1, $2)`, [
    req.params.id, req.user?.id || null
  ]).catch(() => {});
  res.json({ listing: effectiveStatus(rows[0]) });
});

router.post("/", requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.title || !b.category) return res.status(400).json({ error: "Title and category required." });
  const status = b.status === "submitted" ? "submitted" : "draft";
  const { rows } = await query(
    `INSERT INTO listings (user_id, business_id, category, title, description, price, location, contact_phone, fields_json, status, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [
      req.user.id, b.business_id || null, b.category, b.title, b.description || "",
      b.price != null ? Number(b.price) : null, b.location || null, b.contact_phone || req.user.phone,
      JSON.stringify(b.fields || {}), status, b.expires_at || null
    ]
  );
  await notify(req.user.id, "Listing submitted", `"${b.title}" is awaiting review.`, `/#/listing/${rows[0].id}`);
  res.json({ listing: rows[0] });
});

router.patch("/:id", requireAuth, async (req, res) => {
  const { rows } = await query("SELECT * FROM listings WHERE id = $1", [req.params.id]);
  const listing = rows[0];
  if (!listing) return res.status(404).json({ error: "Not found." });
  if (listing.user_id !== req.user.id && !["admin", "owner"].includes(req.user.role)) {
    return res.status(403).json({ error: "Forbidden." });
  }
  const b = req.body || {};
  const { rows: updated } = await query(
    `UPDATE listings SET
      title = COALESCE($1, title),
      description = COALESCE($2, description),
      price = COALESCE($3, price),
      location = COALESCE($4, location),
      fields_json = COALESCE($5, fields_json),
      status = COALESCE($6, status),
      updated_at = NOW()
     WHERE id = $7 RETURNING *`,
    [b.title, b.description, b.price != null ? Number(b.price) : null, b.location,
      b.fields ? JSON.stringify(b.fields) : null, b.status, listing.id]
  );
  res.json({ listing: updated[0] });
});

module.exports = router;
