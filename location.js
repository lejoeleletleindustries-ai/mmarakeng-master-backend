const express = require("express");
const { query } = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
const { audit } = require("../services/audit");
const router = express.Router();

function validCoord(lat, lng) {
  const a = Number(lat), b = Number(lng);
  return Number.isFinite(a) && Number.isFinite(b) && a >= -90 && a <= 90 && b >= -180 && b <= 180;
}

/** Save own location (user-approved) */
router.put("/me", requireAuth, async (req, res) => {
  const { latitude, longitude, accuracy, share_location } = req.body || {};
  if (!validCoord(latitude, longitude)) {
    return res.status(400).json({ error: "Valid latitude and longitude required." });
  }
  const { rows } = await query(
    `UPDATE users SET latitude = $1, longitude = $2, location_accuracy = $3,
       location_updated_at = NOW(), share_location = COALESCE($4, share_location)
     WHERE id = $5
     RETURNING id, latitude, longitude, location_accuracy, location_updated_at, share_location`,
    [latitude, longitude, accuracy != null ? Number(accuracy) : null, share_location, req.user.id]
  );
  res.json({ location: rows[0] });
});

router.get("/me", requireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT latitude, longitude, location_accuracy, location_updated_at, share_location, location AS address_text
     FROM users WHERE id = $1`,
    [req.user.id]
  );
  res.json({ location: rows[0] });
});

/** Near-me listings foundation (public published only; optional radius km) */
router.get("/near-listings", async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const radiusKm = Math.min(Number(req.query.radius_km) || 25, 200);
  if (!validCoord(lat, lng)) return res.status(400).json({ error: "lat and lng required." });
  // Haversine approximation in SQL
  const { rows } = await query(
    `SELECT id, title, category, price, location, latitude, longitude, status,
       (6371 * acos(least(1, greatest(-1,
         cos(radians($1)) * cos(radians(latitude)) * cos(radians(longitude) - radians($2))
         + sin(radians($1)) * sin(radians(latitude))
       )))) AS distance_km
     FROM listings
     WHERE status IN ('published','verified')
       AND latitude IS NOT NULL AND longitude IS NOT NULL
     HAVING (6371 * acos(least(1, greatest(-1,
         cos(radians($1)) * cos(radians(latitude)) * cos(radians(longitude) - radians($2))
         + sin(radians($1)) * sin(radians(latitude))
       )))) <= $3
     ORDER BY distance_km ASC
     LIMIT 100`,
    [lat, lng, radiusKm]
  ).catch(async () => {
    // Fallback without HAVING if dialect issues
    const all = await query(
      `SELECT id, title, category, price, location, latitude, longitude, status
       FROM listings WHERE status IN ('published','verified') AND latitude IS NOT NULL LIMIT 200`
    );
    return {
      rows: all.rows.map((r) => {
        const d = haversine(lat, lng, r.latitude, r.longitude);
        return { ...r, distance_km: d };
      }).filter((r) => r.distance_km <= radiusKm).sort((a, b) => a.distance_km - b.distance_km).slice(0, 100)
    };
  });
  res.json({ listings: rows, radius_km: radiusKm });
});

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(lat2 - lat1);
  const dLon = toR(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Navigation payload for authorized client (opens Google Maps externally) */
router.get("/navigate-url", requireAuth, async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const label = String(req.query.label || "Destination");
  if (!validCoord(lat, lng)) return res.status(400).json({ error: "lat and lng required." });
  // Client opens this URL; no Google secret required for basic maps navigation URLs
  const url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
  res.json({
    navigation_url: url,
    destination: { latitude: lat, longitude: lng, label },
    note: "Open with system browser / Google Maps app. Server does not embed Google API keys."
  });
});

module.exports = router;
