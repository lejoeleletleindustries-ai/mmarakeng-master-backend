const crypto = require("crypto");
const { query, withClient } = require("../db/pool");
const { PaymentStatus } = require("./types");
const { MpesaProvider } = require("./MpesaProvider");
const { EcocashProvider } = require("./EcocashProvider");
const { audit, notify } = require("../services/audit");

const mpesa = new MpesaProvider();
const ecocash = new EcocashProvider();

function currency() {
  return process.env.CURRENCY || "LSL";
}

function paymentsMode() {
  return (process.env.PAYMENTS_MODE || "production").toLowerCase();
}

function getProvider(name) {
  const n = String(name || "").toLowerCase();
  if (n === "mpesa") return mpesa;
  if (n === "ecocash") return ecocash;
  return null;
}

function makeReference(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

/**
 * Create internal payment row. Does NOT mark successful.
 */
async function createPayment(input) {
  const {
    userId, amount, purpose, listingId, productId, planId, orderId, sellerId,
    customerPhone, provider, idempotencyKey, metadata
  } = input;

  if (!userId || amount == null || Number(amount) < 0) {
    const err = new Error("userId and amount required");
    err.code = "VALIDATION";
    throw err;
  }

  const cur = currency();
  const ref = makeReference("MMK");
  const prov = String(provider || "manual").toLowerCase();

  if (idempotencyKey) {
    const existing = await query(
      `SELECT * FROM payment_transactions WHERE idempotency_key = $1`,
      [idempotencyKey]
    );
    if (existing.rows[0]) return { payment: existing.rows[0], created: false };
  }

  const { rows } = await query(
    `INSERT INTO payment_transactions (
       user_id, amount, currency, provider, status, reference, purpose,
       listing_id, product_id, plan_id, order_id, seller_id, phone,
       idempotency_key, metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING *`,
    [
      userId, Number(amount), cur, prov, PaymentStatus.PENDING, ref, purpose || "general",
      listingId || null, productId || null, planId || null, orderId || null, sellerId || null,
      customerPhone || null, idempotencyKey || null, JSON.stringify(metadata || {})
    ]
  );
  return { payment: rows[0], created: true };
}

/**
 * Initiate with live provider or return pending for manual/test.
 */
async function initiatePayment(paymentId, { customerPhone } = {}) {
  const { rows } = await query(`SELECT * FROM payment_transactions WHERE id = $1`, [paymentId]);
  const payment = rows[0];
  if (!payment) {
    const err = new Error("Payment not found");
    err.code = "NOT_FOUND";
    throw err;
  }
  if (payment.status === PaymentStatus.SUCCESSFUL) {
    return { payment, message: "Already successful" };
  }

  const mode = paymentsMode();
  const providerName = payment.provider;

  // TEST mode simulation only when PAYMENTS_MODE=test — never marks real provider txs
  if (mode === "test" && (providerName === "test" || providerName === "manual")) {
    return { payment, message: "Test mode: use POST /api/payments/test/simulate to set status" };
  }

  if (providerName === "manual" || providerName === "test") {
    return {
      payment,
      message: "Manual payment: admin must confirm after real funds received, or configure M-Pesa/EcoCash."
    };
  }

  const provider = getProvider(providerName);
  if (!provider) {
    const err = new Error("Unknown payment provider: " + providerName);
    err.code = "UNKNOWN_PROVIDER";
    throw err;
  }
  if (!provider.enabled) {
    const err = new Error(`${providerName} is disabled (set ${providerName.toUpperCase()}_ENABLED=true)`);
    err.code = "PROVIDER_DISABLED";
    throw err;
  }
  if (!provider.isConfigured()) {
    const err = new Error(`${providerName} credentials incomplete. Configure env vars from official provider docs.`);
    err.code = "PROVIDER_NOT_CONFIGURED";
    throw err;
  }

  const result = await provider.initiatePayment({
    amount: Number(payment.amount),
    currency: payment.currency,
    reference: payment.reference,
    customerPhone: customerPhone || payment.phone,
    metadata: payment.metadata
  });

  await query(
    `UPDATE payment_transactions SET
       status = $1,
       provider_reference = COALESCE($2, provider_reference),
       provider_raw = $3,
       updated_at = NOW()
     WHERE id = $4`,
    [
      result.status || PaymentStatus.INITIATED,
      result.providerReference || null,
      JSON.stringify(result.raw || {}),
      payment.id
    ]
  );
  const updated = await query(`SELECT * FROM payment_transactions WHERE id = $1`, [payment.id]);
  return { payment: updated.rows[0], providerResult: result };
}

/**
 * Apply successful payment side-effects once (idempotent).
 */
async function fulfillSuccessfulPayment(payment, actorId) {
  return withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const locked = await client.query(
        `SELECT * FROM payment_transactions WHERE id = $1 FOR UPDATE`,
        [payment.id]
      );
      const p = locked.rows[0];
      if (!p) throw new Error("Payment missing");
      if (p.status === PaymentStatus.SUCCESSFUL && p.fulfilled_at) {
        await client.query("COMMIT");
        return { alreadyFulfilled: true, payment: p };
      }

      await client.query(
        `UPDATE payment_transactions SET
           status = $1, verified_at = NOW(), updated_at = NOW(), fulfilled_at = NOW()
         WHERE id = $2`,
        [PaymentStatus.SUCCESSFUL, p.id]
      );

      // Settlement ledger row
      const platformFeePct = Number(process.env.PLATFORM_FEE_PERCENT || 0);
      const amount = Number(p.amount);
      const platformFee = Math.round(amount * platformFeePct) / 100;
      const sellerAmount = amount - platformFee;
      await client.query(
        `INSERT INTO payment_settlements (
           payment_id, user_id, seller_id, gross_amount, platform_fee, seller_amount, currency, status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'recorded')
         ON CONFLICT (payment_id) DO NOTHING`,
        [p.id, p.user_id, p.seller_id, amount, platformFee, sellerAmount, p.currency]
      );

      if (p.purpose === "listing_publish" && p.listing_id) {
        await client.query(
          `UPDATE listings SET status = 'published', published_at = NOW(), payment_tx_id = $1, updated_at = NOW()
           WHERE id = $2 AND status IN ('approved','awaiting_payment','verified')`,
          [p.id, p.listing_id]
        );
      }
      if (p.purpose === "digital_purchase" && p.product_id && p.user_id) {
        await client.query(
          `UPDATE digital_purchases SET status = 'completed', updated_at = NOW()
           WHERE payment_tx_id = $1`,
          [p.id]
        );
        // Ensure purchase row exists
        await client.query(
          `INSERT INTO digital_purchases (buyer_id, seller_id, product_id, amount, currency, payment_tx_id, status)
           SELECT $1, COALESCE($2, (SELECT seller_id FROM digital_products WHERE id = $3)), $3, $4, $5, $6, 'completed'
           WHERE NOT EXISTS (SELECT 1 FROM digital_purchases WHERE payment_tx_id = $6)`,
          [p.user_id, p.seller_id, p.product_id, p.amount, p.currency, p.id]
        );
      }
      if (p.purpose === "subscription" && p.plan_id && p.user_id) {
        const plan = await client.query(`SELECT * FROM subscription_plans WHERE id = $1`, [p.plan_id]);
        const days = plan.rows[0]?.duration_days || 30;
        await client.query(
          `INSERT INTO user_subscriptions (user_id, plan_id, status, starts_at, expires_at, payment_tx_id)
           VALUES ($1,$2,'active',NOW(), NOW() + ($3::text || ' days')::interval, $4)`,
          [p.user_id, p.plan_id, String(days), p.id]
        );
      }

      await client.query("COMMIT");
      if (p.user_id) {
        await notify(p.user_id, "Payment successful", `Payment ${p.reference} confirmed.`, "/#/subscription");
      }
      await audit(actorId || null, "payment_fulfilled", "payment", p.id, null, { reference: p.reference });
      const final = await query(`SELECT * FROM payment_transactions WHERE id = $1`, [p.id]);
      return { alreadyFulfilled: false, payment: final.rows[0] };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
  });
}

async function handleWebhook(providerName, req) {
  const provider = getProvider(providerName);
  if (!provider) {
    const err = new Error("Unknown provider");
    err.code = "UNKNOWN_PROVIDER";
    throw err;
  }
  if (!provider.verifyWebhookSignature(req)) {
    const err = new Error("Invalid webhook signature");
    err.code = "INVALID_SIGNATURE";
    throw err;
  }
  const parsed = provider.parseWebhook(req.body);
  if (!parsed.mmarakengReference && !parsed.providerReference) {
    const err = new Error("Webhook missing reference");
    err.code = "VALIDATION";
    throw err;
  }

  let payment;
  if (parsed.mmarakengReference) {
    const r = await query(`SELECT * FROM payment_transactions WHERE reference = $1`, [parsed.mmarakengReference]);
    payment = r.rows[0];
  }
  if (!payment && parsed.providerReference) {
    const r = await query(`SELECT * FROM payment_transactions WHERE provider_reference = $1`, [parsed.providerReference]);
    payment = r.rows[0];
  }
  if (!payment) {
    const err = new Error("Payment not found for webhook");
    err.code = "NOT_FOUND";
    throw err;
  }

  // Idempotency: already successful
  if (payment.status === PaymentStatus.SUCCESSFUL) {
    return { payment, duplicate: true };
  }

  // Amount validation when present
  if (parsed.amount != null && Number(parsed.amount) !== Number(payment.amount)) {
    await query(
      `UPDATE payment_transactions SET status = $1, failure_reason = $2, callback_at = NOW(), updated_at = NOW() WHERE id = $3`,
      [PaymentStatus.FAILED, "Amount mismatch", payment.id]
    );
    const err = new Error("Amount mismatch");
    err.code = "AMOUNT_MISMATCH";
    throw err;
  }

  await query(
    `UPDATE payment_transactions SET
       provider_reference = COALESCE($1, provider_reference),
       callback_at = NOW(),
       provider_raw = $2,
       updated_at = NOW()
     WHERE id = $3`,
    [parsed.providerReference, JSON.stringify(req.body || {}), payment.id]
  );

  if (parsed.success) {
    // Prefer official verify when configured
    if (provider.isConfigured() && parsed.providerReference) {
      try {
        const verified = await provider.verifyTransaction(parsed.providerReference);
        if (verified.status !== PaymentStatus.SUCCESSFUL) {
          await query(
            `UPDATE payment_transactions SET status = $1, failure_reason = $2, updated_at = NOW() WHERE id = $3`,
            [verified.status || PaymentStatus.PENDING, "Provider verification did not confirm success", payment.id]
          );
          return { payment: (await query(`SELECT * FROM payment_transactions WHERE id = $1`, [payment.id])).rows[0], verified: false };
        }
      } catch (e) {
        // Keep pending if verify endpoint fails — do not auto-success
        await query(
          `UPDATE payment_transactions SET failure_reason = $1, updated_at = NOW() WHERE id = $2`,
          ["Verification call failed: " + e.message, payment.id]
        );
        return { payment, verified: false, error: e.message };
      }
    }
    return await fulfillSuccessfulPayment(payment, null);
  }

  await query(
    `UPDATE payment_transactions SET status = $1, failure_reason = $2, updated_at = NOW() WHERE id = $3`,
    [PaymentStatus.FAILED, String(parsed.statusRaw || "provider reported failure"), payment.id]
  );
  return { payment: (await query(`SELECT * FROM payment_transactions WHERE id = $1`, [payment.id])).rows[0], success: false };
}

function providersStatus() {
  return {
    currency: currency(),
    payments_mode: paymentsMode(),
    mpesa: mpesa.configStatus(),
    ecocash: ecocash.configStatus(),
    note: "Secrets are never returned. Providers are not live until official approval and credentials are configured and verified."
  };
}

module.exports = {
  createPayment,
  initiatePayment,
  fulfillSuccessfulPayment,
  handleWebhook,
  providersStatus,
  getProvider,
  paymentsMode,
  currency,
  PaymentStatus
};
