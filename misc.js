const express = require("express");
const { query } = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
const { notify } = require("../services/audit");
const router = express.Router();

router.get("/categories", async (_req, res) => {
  const { rows } = await query(`SELECT DISTINCT category FROM category_fields ORDER BY category`);
  res.json({ categories: rows.map((r) => r.category) });
});

router.get("/categories/:name/fields", async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM category_fields WHERE category = $1 ORDER BY sort_order`,
    [decodeURIComponent(req.params.name)]
  );
  res.json({ fields: rows });
});

router.patch("/profile", requireAuth, async (req, res) => {
  const b = req.body || {};
  const { rows } = await query(
    `UPDATE users SET
      full_name = COALESCE($1, full_name),
      email = COALESCE($2, email),
      location = COALESCE($3, location),
      bio = COALESCE($4, bio),
      updated_at = NOW()
     WHERE id = $5 RETURNING *`,
    [b.full_name, b.email, b.location, b.bio, req.user.id]
  );
  const { publicUser } = require("../middleware/auth");
  res.json({ user: publicUser(rows[0]) });
});

router.get("/subscription/plans", async (_req, res) => {
  const { rows } = await query(`SELECT * FROM subscription_plans WHERE active = TRUE ORDER BY sort_order, price`);
  res.json({ plans: rows });
});

router.get("/subscription/me", requireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT s.*, p.name AS plan_name, p.price AS plan_price FROM user_subscriptions s
     LEFT JOIN subscription_plans p ON p.id = s.plan_id
     WHERE s.user_id = $1 ORDER BY s.created_at DESC LIMIT 5`,
    [req.user.id]
  );
  const active = rows.find((s) => s.status === "active" && (!s.expires_at || new Date(s.expires_at) > new Date())) || null;
  res.json({ subscription: active, history: rows });
});

router.post("/subscription/checkout", requireAuth, async (req, res) => {
  const plan_id = req.body?.plan_id;
  const { rows: plans } = await query(`SELECT * FROM subscription_plans WHERE id = $1 AND active = TRUE`, [plan_id]);
  const plan = plans[0];
  if (!plan) return res.status(404).json({ error: "Plan not found." });
  if (Number(plan.price) === 0) {
    const { rows } = await query(
      `INSERT INTO user_subscriptions (user_id, plan_id, status, starts_at, expires_at)
       VALUES ($1,$2,'active',NOW(), NOW() + ($3 || ' days')::interval) RETURNING *`,
      [req.user.id, plan.id, String(plan.duration_days)]
    );
    await notify(req.user.id, "Subscription active", `You are on ${plan.name}.`, "/#/subscription");
    return res.json({ activated: true, subscription: rows[0], payment: null });
  }
  const ref = "SUB-" + String(plan.id).slice(0, 8).toUpperCase();
  const tx = await query(
    `INSERT INTO payment_transactions (user_id, amount, currency, provider, status, reference, purpose, plan_id, phone, metadata)
     VALUES ($1,$2,$3,$4,'pending',$5,'subscription',$6,$7,$8) RETURNING *`,
    [req.user.id, plan.price, plan.currency, req.body?.provider || "manual", ref, plan.id, req.body?.phone || null,
      JSON.stringify({ instructions: "Configure M-Pesa/EcoCash via env; until then admin confirms manual payments." })]
  );
  await query(
    `INSERT INTO user_subscriptions (user_id, plan_id, status, payment_tx_id)
     VALUES ($1,$2,'pending_payment',$3)`,
    [req.user.id, plan.id, tx.rows[0].id]
  );
  res.json({
    activated: false,
    payment: { id: tx.rows[0].id, reference: ref, amount: Number(plan.price), status: "pending", provider: tx.rows[0].provider }
  });
});

router.get("/payments/methods", (_req, res) => {
  res.json({
    methods: [
      { id: "manual", name: "Manual / Bank", ready: true },
      { id: "mpesa", name: "M-Pesa", ready: !!process.env.PAYMENT_API_KEY && process.env.PAYMENT_PROVIDER === "mpesa" },
      { id: "ecocash", name: "EcoCash", ready: !!process.env.PAYMENT_API_KEY && process.env.PAYMENT_PROVIDER === "ecocash" }
    ]
  });
});

router.post("/support", requireAuth, async (req, res) => {
  const { subject, category, body } = req.body || {};
  if (!subject || !body) return res.status(400).json({ error: "Subject and message required." });
  const { rows } = await query(
    `INSERT INTO support_tickets (user_id, subject, category, body) VALUES ($1,$2,$3,$4) RETURNING *`,
    [req.user.id, String(subject).slice(0, 200), category || "general", String(body).slice(0, 5000)]
  );
  res.json({ ticket: rows[0] });
});

router.get("/support/mine", requireAuth, async (req, res) => {
  const { rows } = await query(`SELECT * FROM support_tickets WHERE user_id = $1 ORDER BY created_at DESC`, [req.user.id]);
  res.json({ tickets: rows });
});

router.post("/follow/:userId", requireAuth, async (req, res) => {
  if (req.params.userId === req.user.id) return res.status(400).json({ error: "Cannot follow yourself." });
  await query(
    `INSERT INTO follows (follower_id, following_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [req.user.id, req.params.userId]
  );
  res.json({ ok: true, following: true });
});

router.delete("/follow/:userId", requireAuth, async (req, res) => {
  await query(`DELETE FROM follows WHERE follower_id = $1 AND following_id = $2`, [req.user.id, req.params.userId]);
  res.json({ ok: true, following: false });
});

router.get("/seller/dashboard", requireAuth, async (req, res) => {
  const uid = req.user.id;
  const listings = await query(`SELECT COUNT(*)::int AS c FROM listings WHERE user_id = $1`, [uid]);
  const published = await query(`SELECT COUNT(*)::int AS c FROM listings WHERE user_id = $1 AND status IN ('published','verified')`, [uid]);
  const digital = await query(`SELECT COUNT(*)::int AS c FROM digital_products WHERE seller_id = $1`, [uid]);
  const sales = await query(`SELECT COUNT(*)::int AS c, COALESCE(SUM(amount),0)::float AS revenue FROM digital_purchases WHERE seller_id = $1 AND status = 'completed'`, [uid]);
  const followers = await query(`SELECT COUNT(*)::int AS c FROM follows WHERE following_id = $1`, [uid]);
  const views = await query(
    `SELECT COUNT(*)::int AS c FROM listing_views v JOIN listings l ON l.id = v.listing_id WHERE l.user_id = $1`,
    [uid]
  );
  const biz = await query(`SELECT * FROM businesses WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [uid]);
  res.json({
    stats: {
      listings: listings.rows[0].c,
      published_listings: published.rows[0].c,
      digital_products: digital.rows[0].c,
      digital_sales: sales.rows[0].c,
      digital_revenue: sales.rows[0].revenue,
      followers: followers.rows[0].c,
      listing_views: views.rows[0].c
    },
    business: biz.rows[0] || null
  });
});

router.patch("/seller/whatsapp", requireAuth, async (req, res) => {
  const { rows } = await query(`SELECT * FROM businesses WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [req.user.id]);
  if (!rows[0]) return res.status(400).json({ error: "Create a business profile first." });
  const wa = req.body?.whatsapp != null ? String(req.body.whatsapp).replace(/[^\d+]/g, "").slice(0, 20) : rows[0].whatsapp;
  const en = req.body?.whatsapp_enabled != null ? !!req.body.whatsapp_enabled : rows[0].whatsapp_enabled;
  await query(`UPDATE businesses SET whatsapp = $1, whatsapp_enabled = $2, updated_at = NOW() WHERE id = $3`, [wa, en, rows[0].id]);
  res.json({ whatsapp: wa, whatsapp_enabled: en });
});

router.get("/terms", (_req, res) => {
  res.json({
    title: "Mmarakeng Terms of Use",
    version: "1.0",
    about: "MMARAKENG is an application built/designed by Lejwele Le Te Industries and Origin Dot App Series.",
    body: "By using Mmarakeng you agree to use the platform lawfully. You are responsible for listings and digital content you publish. Paid downloads unlock only after verified payment. Lockbox conversations are private between participants and stored on the central server; ordinary admins cannot casually browse them; exceptional owner access is logged. Mmarakeng does not guarantee third-party listing accuracy. Prohibited: fraud, illegal goods, hate, IP infringement."
  });
});

router.get("/about", (_req, res) => {
  res.json({
    app: "Mmarakeng",
    credit: "MMARAKENG is an application built/designed by Lejwele Le Te Industries and Origin Dot App Series.",
    owners: ["Lejwele Le Te Industries", "Origin Dot"]
  });
});

router.get("/notifications", requireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [req.user.id]
  );
  res.json({ notifications: rows });
});

module.exports = router;
