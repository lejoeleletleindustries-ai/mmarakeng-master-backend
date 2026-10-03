const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { query } = require("../db/pool");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { notify } = require("../services/audit");
const { v4: uuid } = require("uuid");
const router = express.Router();

const ALLOWED = new Set([".mp4",".webm",".mov",".avi",".wmv",".mkv",".mp3",".wav",".m4a",".aac",".ogg",".flac",".pdf",".epub",".mobi",".doc",".docx",".txt",".jpg",".jpeg",".png",".gif",".webp",".zip"]);
const uploadRoot = path.join(process.cwd(), "uploads", "digital");
fs.mkdirSync(uploadRoot, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _f, cb) => cb(null, uploadRoot),
    filename: (_req, file, cb) => cb(null, Date.now() + "-" + uuid().slice(0, 8) + path.extname(file.originalname).toLowerCase())
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (!ALLOWED.has(ext)) return cb(new Error("File type not allowed: " + ext));
    cb(null, true);
  }
});

function publicProduct(p, includeMeta) {
  const o = {
    id: p.id, seller_id: p.seller_id, title: p.title, description: p.description,
    category: p.category, price: Number(p.price), currency: p.currency,
    visibility: p.visibility, preview_enabled: p.preview_enabled,
    has_preview: !!(p.preview_enabled && p.preview_path),
    status: p.status, views: p.views, file_type: p.file_type, file_size: p.file_size,
    created_at: p.created_at, published_at: p.published_at
  };
  if (includeMeta) { o.file_name = p.file_name; o.has_file = !!p.file_path; }
  return o;
}

router.get("/", async (_req, res) => {
  const { rows } = await query(
    `SELECT * FROM digital_products WHERE status = 'published' AND visibility = 'public' ORDER BY created_at DESC LIMIT 100`
  );
  res.json({ products: rows.map((p) => publicProduct(p, false)) });
});

router.get("/mine", requireAuth, async (req, res) => {
  const { rows } = await query(`SELECT * FROM digital_products WHERE seller_id = $1 ORDER BY created_at DESC`, [req.user.id]);
  res.json({ products: rows.map((p) => publicProduct(p, true)) });
});

router.get("/purchases", requireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT dp.*, p.title AS product_title FROM digital_purchases dp
     LEFT JOIN digital_products p ON p.id = dp.product_id
     WHERE dp.buyer_id = $1 AND dp.status = 'completed' ORDER BY dp.created_at DESC`,
    [req.user.id]
  );
  res.json({ purchases: rows.map((b) => ({ ...b, can_download: true })) });
});

router.post("/", requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.title) return res.status(400).json({ error: "Title required." });
  const { rows } = await query(
    `INSERT INTO digital_products (seller_id, title, description, category, price, currency, visibility, preview_enabled, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft') RETURNING *`,
    [req.user.id, b.title, b.description || "", b.category || "Digital", Number(b.price) || 0,
      b.currency || "LSL", b.visibility === "public" ? "public" : "paid", !!b.preview_enabled]
  );
  res.json({ product: publicProduct(rows[0], true) });
});

router.post("/:id/upload", requireAuth, upload.single("file"), async (req, res) => {
  const { rows } = await query("SELECT * FROM digital_products WHERE id = $1", [req.params.id]);
  if (!rows[0] || rows[0].seller_id !== req.user.id) return res.status(404).json({ error: "Not found." });
  if (!req.file) return res.status(400).json({ error: "No file." });
  const rel = "/uploads/digital/" + req.file.filename;
  const kind = req.body?.kind || "main";
  if (kind === "preview") {
    await query(`UPDATE digital_products SET preview_path = $1, preview_enabled = TRUE, updated_at = NOW() WHERE id = $2`, [rel, req.params.id]);
  } else {
    await query(
      `UPDATE digital_products SET file_path = $1, file_name = $2, file_type = $3, file_size = $4, updated_at = NOW() WHERE id = $5`,
      [rel, req.file.originalname, path.extname(req.file.originalname).toLowerCase(), req.file.size || 0, req.params.id]
    );
  }
  const u = await query("SELECT * FROM digital_products WHERE id = $1", [req.params.id]);
  res.json({ product: publicProduct(u.rows[0], true) });
});

router.post("/:id/submit", requireAuth, async (req, res) => {
  const { rows } = await query("SELECT * FROM digital_products WHERE id = $1 AND seller_id = $2", [req.params.id, req.user.id]);
  if (!rows[0]) return res.status(404).json({ error: "Not found." });
  if (!rows[0].file_path) return res.status(400).json({ error: "Upload the digital file first." });
  await query(`UPDATE digital_products SET status = 'submitted', updated_at = NOW() WHERE id = $1`, [req.params.id]);
  res.json({ product: publicProduct({ ...rows[0], status: "submitted" }, true) });
});

router.get("/:id", async (req, res) => {
  const { rows } = await query("SELECT * FROM digital_products WHERE id = $1", [req.params.id]);
  const p = rows[0];
  if (!p) return res.status(404).json({ error: "Not found." });
  res.json({ product: publicProduct(p, false), can_download: false });
});

router.post("/:id/buy", requireAuth, async (req, res) => {
  const { rows } = await query("SELECT * FROM digital_products WHERE id = $1", [req.params.id]);
  const p = rows[0];
  if (!p || p.status !== "published") return res.status(404).json({ error: "Product not available." });
  const owned = await query(
    `SELECT * FROM digital_purchases WHERE buyer_id = $1 AND product_id = $2 AND status = 'completed'`,
    [req.user.id, p.id]
  );
  if (owned.rows[0]) return res.json({ already_owned: true, can_download: true });
  if (Number(p.price) === 0 || p.visibility === "public") {
    await query(
      `INSERT INTO digital_purchases (buyer_id, seller_id, product_id, amount, currency, status)
       VALUES ($1,$2,$3,$4,$5,'completed')`,
      [req.user.id, p.seller_id, p.id, 0, p.currency]
    );
    return res.json({ activated: true, can_download: true });
  }
  const ref = "DIG-" + String(p.id).slice(0, 8).toUpperCase();
  const tx = await query(
    `INSERT INTO payment_transactions (user_id, amount, currency, provider, status, reference, purpose, product_id, phone, metadata)
     VALUES ($1,$2,$3,$4,'pending',$5,'digital_purchase',$6,$7,$8) RETURNING *`,
    [req.user.id, p.price, p.currency, req.body?.provider || "manual", ref, p.id, req.body?.phone || null,
      JSON.stringify({ instructions: "Complete payment then wait for admin confirmation, or connect live provider webhooks." })]
  );
  await query(
    `INSERT INTO digital_purchases (buyer_id, seller_id, product_id, amount, currency, payment_tx_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,'pending')`,
    [req.user.id, p.seller_id, p.id, p.price, p.currency, tx.rows[0].id]
  );
  res.json({
    activated: false,
    payment: {
      id: tx.rows[0].id, status: "pending", reference: ref, amount: Number(p.price),
      currency: p.currency, provider: tx.rows[0].provider,
      instructions: "Manual payment pending admin confirmation until live M-Pesa/EcoCash keys are configured."
    }
  });
});

router.get("/:id/download", requireAuth, async (req, res) => {
  const { rows } = await query("SELECT * FROM digital_products WHERE id = $1", [req.params.id]);
  const p = rows[0];
  if (!p || !p.file_path) return res.status(404).json({ error: "File not found." });
  const isSeller = p.seller_id === req.user.id;
  const free = p.visibility === "public" && Number(p.price) === 0;
  const owned = await query(
    `SELECT * FROM digital_purchases WHERE buyer_id = $1 AND product_id = $2 AND status = 'completed'`,
    [req.user.id, p.id]
  );
  if (!isSeller && !free && !owned.rows[0]) {
    return res.status(403).json({ error: "Purchase required before download." });
  }
  if (owned.rows[0]) {
    await query(`UPDATE digital_purchases SET downloads = downloads + 1, last_download_at = NOW() WHERE id = $1`, [owned.rows[0].id]);
  }
  const abs = path.join(process.cwd(), p.file_path.replace(/^\//, ""));
  if (!fs.existsSync(abs)) return res.status(404).json({ error: "File missing on server." });
  res.download(abs, p.file_name || path.basename(abs));
});

router.get("/admin/all", requireAdmin, async (_req, res) => {
  const { rows } = await query(
    `SELECT p.*, u.full_name AS seller_name, u.phone AS seller_phone FROM digital_products p
     JOIN users u ON u.id = p.seller_id ORDER BY p.created_at DESC LIMIT 300`
  );
  res.json({ products: rows.map((p) => ({ ...publicProduct(p, true), seller_name: p.seller_name, seller_phone: p.seller_phone })) });
});

router.post("/admin/:id/status", requireAdmin, async (req, res) => {
  const status = req.body?.status;
  const allowed = ["draft","submitted","approved","published","rejected","suspended"];
  if (!allowed.includes(status)) return res.status(400).json({ error: "Invalid status." });
  const { rows } = await query(
    `UPDATE digital_products SET status = $1, published_at = CASE WHEN $1 = 'published' THEN NOW() ELSE published_at END, updated_at = NOW()
     WHERE id = $2 RETURNING *`,
    [status, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Not found." });
  await notify(rows[0].seller_id, "Digital product " + status, `"${rows[0].title}" is now ${status}.`, "/#/seller");
  res.json({ product: publicProduct(rows[0], true) });
});

module.exports = router;
