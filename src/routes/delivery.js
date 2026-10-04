const express = require("express");
const { query } = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
const { audit } = require("../services/audit");
const router = express.Router();

function validCoord(lat, lng) {
  const a = Number(lat), b = Number(lng);
  return Number.isFinite(a) && Number.isFinite(b) && a >= -90 && a <= 90 && b >= -180 && b <= 180;
}

/** Customer creates/updates delivery destination for an order reference */
router.post("/", requireAuth, async (req, res) => {
  const b = req.body || {};
  const { rows } = await query(
    `INSERT INTO delivery_locations (order_id, customer_id, seller_id, listing_id, product_id, address_text, latitude, longitude, accuracy, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending') RETURNING *`,
    [
      b.order_id || null, req.user.id, b.seller_id || null, b.listing_id || null, b.product_id || null,
      b.address_text || null,
      validCoord(b.latitude, b.longitude) ? b.latitude : null,
      validCoord(b.latitude, b.longitude) ? b.longitude : null,
      b.accuracy ?? null
    ]
  );
  res.status(201).json({ delivery: publicDelivery(rows[0], true) });
});

router.get("/mine", requireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM delivery_locations WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [req.user.id]
  );
  res.json({ deliveries: rows.map((d) => publicDelivery(d, true)) });
});

/** Seller: only assigned deliveries */
router.get("/seller", requireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM delivery_locations WHERE seller_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [req.user.id]
  );
  res.json({ deliveries: rows.map((d) => publicDelivery(d, false)) });
});

/** Seller navigation — IDOR protected */
router.get("/:id/navigate", requireAuth, async (req, res) => {
  const { rows } = await query(`SELECT * FROM delivery_locations WHERE id = $1`, [req.params.id]);
  const d = rows[0];
  if (!d) return res.status(404).json({ error: "Not found." });
  const isCustomer = d.customer_id === req.user.id;
  const isSeller = d.seller_id === req.user.id;
  const isOwner = req.user.role === "owner" || req.user.is_owner;
  if (!isCustomer && !isSeller && !isOwner) {
    return res.status(403).json({ error: "Not authorized for this delivery location." });
  }
  await audit(req.user.id, "delivery_location_access", "delivery_location", d.id, null, {
    role: isSeller ? "seller" : isCustomer ? "customer" : "owner"
  });
  if (d.latitude == null || d.longitude == null) {
    return res.status(400).json({ error: "No coordinates on this delivery." });
  }
  const navigation_url = `https://www.google.com/maps/dir/?api=1&destination=${d.latitude},${d.longitude}&travelmode=driving`;
  res.json({
    navigation_url,
    destination: {
      latitude: d.latitude,
      longitude: d.longitude,
      address_text: isSeller || isCustomer || isOwner ? d.address_text : undefined
    }
  });
});

function publicDelivery(d, fullAddress) {
  if (!d) return null;
  return {
    id: d.id,
    order_id: d.order_id,
    customer_id: d.customer_id,
    seller_id: d.seller_id,
    status: d.status,
    latitude: d.latitude,
    longitude: d.longitude,
    address_text: fullAddress ? d.address_text : d.address_text,
    created_at: d.created_at,
    updated_at: d.updated_at
  };
}

module.exports = router;
