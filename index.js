require("dotenv").config();

function requiredInProd(name) {
  const v = process.env[name];
  if (process.env.NODE_ENV === "production" && !v) {
    console.warn(`[config] Missing recommended env: ${name}`);
  }
  return v || "";
}

module.exports = {
  env: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT) || 10000,
  host: process.env.HOST || "0.0.0.0",
  databaseUrl: process.env.DATABASE_URL || "",
  jwtSecret: process.env.JWT_SECRET || process.env.SESSION_SECRET || "dev-only-change-me",
  sessionSecret: process.env.SESSION_SECRET || process.env.JWT_SECRET || "dev-only-change-me",
  corsOrigin: process.env.CORS_ORIGIN || "*",
  otpRequired: process.env.OTP_REQUIRED === "1",
  otpSecret: process.env.OTP_SECRET || "",
  hcaptchaSecret: process.env.HCAPTCHA_SECRET || "",
  hcaptchaSitekey: process.env.HCAPTCHA_SITEKEY || "",
  paymentProvider: process.env.PAYMENT_PROVIDER || "",
  paymentApiKey: process.env.PAYMENT_API_KEY || "",
  paymentWebhookSecret: process.env.PAYMENT_WEBHOOK_SECRET || "",
  owners: [
    {
      name: process.env.OWNER1_NAME || "Lejwele Le Te Industries",
      email: process.env.OWNER1_EMAIL || "Lejweleleteindustries@gmail.com",
      phone: process.env.OWNER1_PHONE || "50000010",
      password: process.env.OWNER1_PASSWORD || ""
    },
    {
      name: process.env.OWNER2_NAME || "Origin Dot",
      email: process.env.OWNER2_EMAIL || "origin.dot@gmail.com",
      phone: process.env.OWNER2_PHONE || "50000011",
      password: process.env.OWNER2_PASSWORD || ""
    }
  ],
  requiredInProd
};
