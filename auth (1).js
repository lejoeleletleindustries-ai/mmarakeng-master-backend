const { verifyToken } = require("../utils/crypto");
const { query } = require("../db/pool");

function authFromReq(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  return verifyToken(m[1].trim());
}

async function requireAuth(req, res, next) {
  const payload = authFromReq(req);
  if (!payload || !payload.sub) {
    return res.status(401).json({ error: "Please log in." });
  }
  const { rows } = await query("SELECT * FROM users WHERE id = $1", [payload.sub]);
  if (!rows[0]) return res.status(401).json({ error: "User not found." });
  req.user = rows[0];
  req.auth = { userId: rows[0].id, role: rows[0].role };
  next();
}

async function requireAdmin(req, res, next) {
  await requireAuth(req, res, async () => {
    if (!req.user || !["admin", "owner"].includes(req.user.role) && !req.user.is_owner) {
      return res.status(403).json({ error: "Admin access required." });
    }
    next();
  });
}

async function requireOwner(req, res, next) {
  await requireAuth(req, res, async () => {
    if (!req.user || (req.user.role !== "owner" && !req.user.is_owner)) {
      return res.status(403).json({ error: "Owner access required." });
    }
    next();
  });
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    full_name: u.full_name,
    phone: u.phone,
    email: u.email,
    role: u.role,
    is_owner: !!(u.is_owner || u.role === "owner"),
    location: u.location,
    bio: u.bio,
    profile_picture: u.profile_picture,
    phone_verified: !!u.phone_verified,
    whatsapp: u.whatsapp_enabled ? u.whatsapp : undefined,
    whatsapp_enabled: !!u.whatsapp_enabled,
    created_at: u.created_at
  };
}

module.exports = { requireAuth, requireAdmin, requireOwner, publicUser, authFromReq };
