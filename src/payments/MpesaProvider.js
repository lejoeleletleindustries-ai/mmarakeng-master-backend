/**
 * M-Pesa Lesotho adapter (plug-in ready).
 * Credentials and official API paths come ONLY from environment variables.
 * Does NOT invent or hard-code production endpoints or secrets.
 * Not live until MPESA_ENABLED=true and all required credentials are set.
 */
const crypto = require("crypto");
const { PaymentStatus } = require("./types");

class MpesaProvider {
  constructor() {
    this.name = "mpesa";
    this.enabled = process.env.MPESA_ENABLED === "true";
    this.environment = process.env.MPESA_ENVIRONMENT || "sandbox";
    this.apiBaseUrl = process.env.MPESA_API_BASE_URL || "";
    this.apiVersion = process.env.MPESA_API_VERSION || "";
    this.clientId = process.env.MPESA_CLIENT_ID || "";
    this.clientSecret = process.env.MPESA_CLIENT_SECRET || "";
    this.merchantId = process.env.MPESA_MERCHANT_ID || "";
    this.businessId = process.env.MPESA_BUSINESS_ID || "";
    this.shortcode = process.env.MPESA_SHORTCODE || "";
    this.callbackUrl = process.env.MPESA_CALLBACK_URL || "";
    this.timeoutMs = Number(process.env.MPESA_TIMEOUT_MS) || 30000;
    this.webhookSecret = process.env.MPESA_WEBHOOK_SECRET || "";
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
      provider: "mpesa",
      enabled: this.enabled,
      environment: this.environment,
      credentials_configured: !!(this.clientId && this.clientSecret && this.merchantId),
      api_base_url_configured: !!this.apiBaseUrl,
      callback_configured: !!this.callbackUrl,
      shortcode_configured: !!this.shortcode,
      // never expose secret values
      live: false // remains false until owner verifies production with official approval
    };
  }

  async getAccessToken() {
    if (!this.isConfigured()) {
      const err = new Error("M-Pesa is not fully configured. Set MPESA_* environment variables from official provider docs.");
      err.code = "PROVIDER_NOT_CONFIGURED";
      throw err;
    }
    // Placeholder: official token URL/path must match M-Pesa Lesotho API docs when credentials are issued.
    const url = `${this.apiBaseUrl.replace(/\/$/, "")}/oauth/token`;
    const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: "grant_type=client_credentials",
        signal: controller.signal
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`M-Pesa auth failed (${res.status}): configure endpoints per official docs. ${text.slice(0, 200)}`);
      }
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Initiate a customer payment. Exact payload follows official API once credentials are available.
   */
  async initiatePayment({ amount, currency, reference, customerPhone, metadata }) {
    if (!this.isConfigured()) {
      const err = new Error("M-Pesa provider not configured or disabled.");
      err.code = "PROVIDER_NOT_CONFIGURED";
      throw err;
    }
    const tokenData = await this.getAccessToken();
    const token = tokenData.access_token || tokenData.token;
    if (!token) throw new Error("M-Pesa token response missing access_token — verify official auth response shape.");

    const url = `${this.apiBaseUrl.replace(/\/$/, "")}/payments/initiate`;
    const body = {
      amount,
      currency: currency || "LSL",
      merchantId: this.merchantId,
      businessId: this.businessId || this.shortcode,
      shortcode: this.shortcode,
      reference,
      customerPhone,
      callbackUrl: this.callbackUrl,
      metadata: metadata || {}
    };
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          ok: false,
          status: PaymentStatus.FAILED,
          providerReference: data.transactionId || data.reference || null,
          raw: data,
          error: data.message || `M-Pesa initiate failed (${res.status})`
        };
      }
      return {
        ok: true,
        status: PaymentStatus.INITIATED,
        providerReference: data.transactionId || data.reference || data.ConversationID || null,
        raw: data
      };
    } finally {
      clearTimeout(t);
    }
  }

  async verifyTransaction(providerReference) {
    if (!this.isConfigured()) {
      const err = new Error("M-Pesa not configured.");
      err.code = "PROVIDER_NOT_CONFIGURED";
      throw err;
    }
    const tokenData = await this.getAccessToken();
    const token = tokenData.access_token || tokenData.token;
    const url = `${this.apiBaseUrl.replace(/\/$/, "")}/payments/status/${encodeURIComponent(providerReference)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, status: PaymentStatus.PENDING, raw: data };
    }
    const s = String(data.status || data.ResultCode || "").toLowerCase();
    let status = PaymentStatus.PENDING;
    if (s.includes("success") || s === "0" || s === "completed") status = PaymentStatus.SUCCESSFUL;
    else if (s.includes("fail") || s.includes("error")) status = PaymentStatus.FAILED;
    else if (s.includes("cancel")) status = PaymentStatus.CANCELLED;
    else if (s.includes("expir")) status = PaymentStatus.EXPIRED;
    return { ok: true, status, amount: data.amount, currency: data.currency, raw: data };
  }

  /**
   * Verify webhook authenticity. Official signature algorithm is provider-defined —
   * when documented, implement exact check. Until then require shared secret header if set.
   */
  verifyWebhookSignature(req) {
    if (!this.webhookSecret) {
      // No secret configured: reject in production; allow only when explicitly testing
      if (process.env.NODE_ENV === "production" && process.env.PAYMENTS_MODE !== "test") {
        return false;
      }
      return true;
    }
    const sig = req.headers["x-mpesa-signature"] || req.headers["x-signature"] || "";
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
      providerReference: b.transactionId || b.TransID || b.reference || b.ConversationID || null,
      mmarakengReference: b.AccountReference || b.BillRefNumber || b.merchantReference || b.reference || null,
      amount: b.amount != null ? Number(b.amount) : (b.TransAmount != null ? Number(b.TransAmount) : null),
      currency: b.currency || "LSL",
      statusRaw: b.status || b.ResultCode || b.ResultDesc,
      success: String(b.status || "").toLowerCase().includes("success") || String(b.ResultCode) === "0"
    };
  }
}

module.exports = { MpesaProvider };
