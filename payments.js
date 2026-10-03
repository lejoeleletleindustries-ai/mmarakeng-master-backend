const express = require("express");
const { query } = require("../db/pool");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const PaymentService = require("../payments/PaymentService");
const { audit } = require("../services/audit");
const router = express.Router();

router.get("/methods", (_req, res) => {
  const status = PaymentService.providersStatus();
  res.json({
    currency: status.currency,
    payments_mode: status.payments_mode,
    methods: [
      {
        id: "manual",
        name: "Manual confirmation",
        ready: true,
        note: "Admin confirms after funds received"
      },
      {
        id: "mpesa",
        name: "M-Pesa Lesotho",
        ready: status.mpesa.enabled && status.mpesa.credentials_configured && status.mpesa.api_base_url_configured,
        enabled: status.mpesa.enabled,
        environment: status.mpesa.environment
      },
      {
        id: "ecocash",
        name: "EcoCash Lesotho",
        ready: status.ecocash.enabled && status.ecocash.credentials_configured && status.ecocash.api_base_url_configured,
        enabled: status.ecocash.enabled,
        environment: status.ecocash.environment
      }
    ],
    note: "Providers are not live until official merchant approval and credentials are configured."
  });
});

router.get("/config-status", requireAdmin, (_req, res) => {
  res.json(PaymentService.providersStatus());
});

router.post("/create", requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const { payment } = await PaymentService.createPayment({
      userId: req.user.id,
      amount: b.amount,
      purpose: b.purpose || "general",
      listingId: b.listing_id,
      productId: b.product_id,
      planId: b.plan_id,
      orderId: b.order_id,
      sellerId: b.seller_id,
      customerPhone: b.phone || req.user.phone,
      provider: b.provider || "manual",
      idempotencyKey: b.idempotency_key || req.headers["idempotency-key"],
      metadata: b.metadata
    });
    res.json({ payment: safePayment(payment) });
  } catch (e) {
    res.status(e.code === "VALIDATION" ? 400 : 500).json({ error: e.message });
  }
});

router.post("/:id/initiate", requireAuth, async (req, res) => {
  try {
    const { rows } = await query(`SELECT * FROM payment_transactions WHERE id = $1`, [req.params.id]);
    if (!rows[0] || rows[0].user_id !== req.user.id) {
      return res.status(404).json({ error: "Payment not found." });
    }
    const result = await PaymentService.initiatePayment(req.params.id, {
      customerPhone: req.body?.phone || req.user.phone
    });
    res.json({
      payment: safePayment(result.payment),
      message: result.message || null,
      providerResult: result.providerResult
        ? { ok: result.providerResult.ok, status: result.providerResult.status, error: result.providerResult.error }
        : null
    });
  } catch (e) {
    const code = e.code === "PROVIDER_NOT_CONFIGURED" || e.code === "PROVIDER_DISABLED" ? 503 : 500;
    res.status(code).json({ error: e.message, code: e.code || null });
  }
});

router.get("/:id", requireAuth, async (req, res) => {
  const { rows } = await query(`SELECT * FROM payment_transactions WHERE id = $1`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Not found." });
  if (rows[0].user_id !== req.user.id && !["admin", "owner"].includes(req.user.role) && !req.user.is_owner) {
    return res.status(403).json({ error: "Forbidden." });
  }
  res.json({ payment: safePayment(rows[0]) });
});

// Webhooks — no user JWT; signature verified by provider adapter
router.post("/mpesa/webhook", async (req, res) => {
  try {
    const result = await PaymentService.handleWebhook("mpesa", req);
    res.json({ ok: true, duplicate: !!result.duplicate, status: result.payment?.status });
  } catch (e) {
    const status = e.code === "INVALID_SIGNATURE" ? 401 : e.code === "NOT_FOUND" ? 404 : 400;
    res.status(status).json({ error: e.message, code: e.code || null });
  }
});

router.post("/ecocash/webhook", async (req, res) => {
  try {
    const result = await PaymentService.handleWebhook("ecocash", req);
    res.json({ ok: true, duplicate: !!result.duplicate, status: result.payment?.status });
  } catch (e) {
    const status = e.code === "INVALID_SIGNATURE" ? 401 : e.code === "NOT_FOUND" ? 404 : 400;
    res.status(status).json({ error: e.message, code: e.code || null });
  }
});

/**
 * Test-mode only simulation. Blocked unless PAYMENTS_MODE=test.
 * Never works as a shortcut in production mode.
 */
router.post("/test/simulate", requireAuth, async (req, res) => {
  if (PaymentService.paymentsMode() !== "test") {
    return res.status(403).json({ error: "PAYMENTS_MODE is not test. Simulation disabled." });
  }
  const { payment_id, outcome } = req.body || {};
  const { rows } = await query(`SELECT * FROM payment_transactions WHERE id = $1`, [payment_id]);
  if (!rows[0] || rows[0].user_id !== req.user.id) {
    return res.status(404).json({ error: "Payment not found." });
  }
  const map = {
    successful: PaymentService.PaymentStatus.SUCCESSFUL,
    failed: PaymentService.PaymentStatus.FAILED,
    pending: PaymentService.PaymentStatus.PENDING,
    cancelled: PaymentService.PaymentStatus.CANCELLED
  };
  const status = map[outcome];
  if (!status) return res.status(400).json({ error: "outcome must be successful|failed|pending|cancelled" });
  if (status === PaymentService.PaymentStatus.SUCCESSFUL) {
    const result = await PaymentService.fulfillSuccessfulPayment(rows[0], req.user.id);
    return res.json({ payment: safePayment(result.payment), simulated: true });
  }
  await query(`UPDATE payment_transactions SET status = $1, updated_at = NOW() WHERE id = $2`, [status, payment_id]);
  const u = await query(`SELECT * FROM payment_transactions WHERE id = $1`, [payment_id]);
  res.json({ payment: safePayment(u.rows[0]), simulated: true });
});

// Admin confirm manual payments only (not a substitute for provider webhooks in production)
router.post("/:id/admin-confirm", requireAdmin, async (req, res) => {
  const { rows } = await query(`SELECT * FROM payment_transactions WHERE id = $1`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Not found." });
  if (rows[0].provider !== "manual" && PaymentService.paymentsMode() === "production") {
    return res.status(400).json({
      error: "In production, non-manual payments must be confirmed via provider webhook/verification."
    });
  }
  const result = await PaymentService.fulfillSuccessfulPayment(rows[0], req.user.id);
  await audit(req.user.id, "manual_payment_confirm", "payment", rows[0].id, req.body?.notes || null, null);
  res.json({ payment: safePayment(result.payment) });
});

function safePayment(p) {
  if (!p) return null;
  return {
    id: p.id,
    amount: Number(p.amount),
    currency: p.currency,
    provider: p.provider,
    status: p.status,
    reference: p.reference,
    purpose: p.purpose,
    listing_id: p.listing_id,
    product_id: p.product_id,
    plan_id: p.plan_id,
    provider_reference: p.provider_reference,
    created_at: p.created_at,
    verified_at: p.verified_at,
    failure_reason: p.failure_reason
  };
}

module.exports = router;
