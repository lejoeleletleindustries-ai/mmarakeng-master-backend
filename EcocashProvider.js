/**
 * EcoCash Lesotho adapter (plug-in ready).
 * All secrets and base URLs from environment only.
 */
const crypto = require("crypto");
const { PaymentStatus } = require("./types");

class EcocashProvider {
  constructor() {
    this.name = "ecocash";
    this.enabled = process.env.ECOCASH_ENABLED === "true";
    this.environment = process.env.ECOCASH_ENVIRONMENT || "sandbox";
    this.apiBaseUrl = process.env.ECOCASH_API_BASE_URL || "";
    this.apiVersion = process.env.ECOCASH_API_VERSION || "";
    this.clientId = process.env.ECOCASH_CLIENT_ID || "";
    this.clientSecret = process.env.ECOCASH_CLIENT_SECRET || "";
    this.merchantId = process.env.ECOCASH_MERCHANT_ID || "";
    this.businessId = process.env.ECOCASH_BUSINESS_ID || "";
    this.callbackUrl = process.env.ECOCASH_CALLBACK_URL || "";
    this.timeoutMs = Number(process.env.ECOCASH_TIMEOUT_MS) || 30000;
    this.webhookSecret = process.env.ECOCASH_WEBHOOK_SECRET || "";
  }

  isConfigured() {
    return !!(
      this.enabled &&
      this.apiBaseUrl &&
      this.clientId &&
      this.clientSecret &&
      this.merchantId &&
      this.callbackUrl
    );
  }

  configStatus() {
    return {
      provider: "ecocash",
      enabled: this.enabled,
      environment: this.environment,
      credentials_configured: !!(this.clientId && this.clientSecret && this.merchantId),
      api_base_url_configured: !!this.apiBaseUrl,
      callback_configured: !!this.callbackUrl,
      live: false
    };
  }

  async getAccessToken() {
    if (!this.isConfigured()) {
      const err = new Error("EcoCash is not fully configured. Set ECOCASH_* from official provider documentation.");
      err.code = "PROVIDER_NOT_CONFIGURED";
      throw err;
    }
    const url = `${this.apiBaseUrl.replace(/\/$/, "")}/oauth/token`;
    const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials"
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`EcoCash auth failed (${res.status}). ${text.slice(0, 200)}`);
    }
    return await res.json();
  }

  async initiatePayment({ amount, currency, reference, customerPhone, metadata }) {
    if (!this.isConfigured()) {
      const err = new Error("EcoCash provider not configured or disabled.");
      err.code = "PROVIDER_NOT_CONFIGURED";
      throw err;
    }
    const tokenData = await this.getAccessToken();
    const token = tokenData.access_token || tokenData.token;
    const url = `${this.apiBaseUrl.replace(/\/$/, "")}/payments/initiate`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        amount,
        currency: currency || "LSL",
        merchantId: this.merchantId,
        businessId: this.businessId,
        reference,
        customerPhone,
        callbackUrl: this.callbackUrl,
        metadata: metadata || {}
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        status: PaymentStatus.FAILED,
        providerReference: data.transactionId || null,
        raw: data,
        error: data.message || `EcoCash initiate failed (${res.status})`
      };
    }
    return {
      ok: true,
      status: PaymentStatus.INITIATED,
      providerReference: data.transactionId || data.reference || null,
      raw: data
    };
  }

  async verifyTransaction(providerReference) {
    if (!this.isConfigured()) {
      const err = new Error("EcoCash not configured.");
      err.code = "PROVIDER_NOT_CONFIGURED";
      throw err;
    }
    const tokenData = await this.getAccessToken();
    const token = tokenData.access_token || tokenData.token;
    const url = `${this.apiBaseUrl.replace(/\/$/, "")}/payments/status/${encodeURIComponent(providerReference)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: PaymentStatus.PENDING, raw: data };
    const s = String(data.status || "").toLowerCase();
    let status = PaymentStatus.PENDING;
    if (s.includes("success") || s === "completed") status = PaymentStatus.SUCCESSFUL;
    else if (s.includes("fail")) status = PaymentStatus.FAILED;
    else if (s.includes("cancel")) status = PaymentStatus.CANCELLED;
    else if (s.includes("expir")) status = PaymentStatus.EXPIRED;
    return { ok: true, status, amount: data.amount, currency: data.currency, raw: data };
  }

  verifyWebhookSignature(req) {
    if (!this.webhookSecret) {
      if (process.env.NODE_ENV === "production" && process.env.PAYMENTS_MODE !== "test") return false;
      return true;
    }
    const sig = req.headers["x-ecocash-signature"] || req.headers["x-signature"] || "";
    const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
    const expected = crypto.createHmac("sha256", this.webhookSecret).update(body).digest("hex");
    try {
      return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  parseWebhook(body) {
    const b = body || {};
    return {
      providerReference: b.transactionId || b.reference || null,
      mmarakengReference: b.merchantReference || b.reference || null,
      amount: b.amount != null ? Number(b.amount) : null,
      currency: b.currency || "LSL",
      statusRaw: b.status,
      success: String(b.status || "").toLowerCase().includes("success")
    };
  }
}

module.exports = { EcocashProvider };
