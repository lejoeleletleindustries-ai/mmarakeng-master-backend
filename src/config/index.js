require("dotenv").config();

const env = process.env.NODE_ENV || "development";
const isProd = env === "production";

function requireSecret(name) {
  const v = process.env[name];
  if (isProd && (!v || v === "dev-only-change-me" || v.length < 16)) {
    console.error(`[FATAL] ${name} must be set to a strong secret in production (min 16 chars).`);
    process.exit(1);
  }
  return v || "dev-only-change-me";
}

module.exports = {
  env,
  isProd,
  port: Number(process.env.PORT) || 10000,
  host: process.env.HOST || "0.0.0.0",
  databaseUrl: process.env.DATABASE_URL || "",
  jwtSecret: requireSecret("JWT_SECRET"),
  sessionSecret: process.env.SESSION_SECRET || requireSecret("JWT_SECRET"),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "7d",
  corsOrigin: process.env.CORS_ORIGIN || (isProd ? "" : "*"),
  otpRequired: process.env.OTP_REQUIRED === "1",
  otpSecret: process.env.OTP_SECRET || "",
  hcaptchaSecret: process.env.HCAPTCHA_SECRET || "",
  hcaptchaSitekey: process.env.HCAPTCHA_SITEKEY || "",
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || "",
  googleMapsBrowserKey: process.env.GOOGLE_MAPS_BROWSER_KEY || "",
  storageProvider: process.env.STORAGE_PROVIDER || "local",
  smsProvider: process.env.SMS_PROVIDER || "",
  smsApiKey: process.env.SMS_API_KEY || "",
  emailProvider: process.env.EMAIL_PROVIDER || "",
  emailApiKey: process.env.EMAIL_API_KEY || "",
  owners: [
    {
      name: process.env.OWNER1_NAME || "Lejwele Le Te Industries",
      email: process.env.OWNER1_EMAIL || "",
      phone: process.env.OWNER1_PHONE || "",
      password: process.env.OWNER1_PASSWORD || ""
    },
    {
      name: process.env.OWNER2_NAME || "Origin Dot",
      email: process.env.OWNER2_EMAIL || "",
      phone: process.env.OWNER2_PHONE || "",
      password: process.env.OWNER2_PASSWORD || ""
    }
  ]
};
