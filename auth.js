const express = require("express");
const { query } = require("../db/pool");
const { hashPassword, verifyPassword, signToken, sha256, randomCode } = require("../utils/crypto");
const { requireAuth, publicUser } = require("../middleware/auth");
const { notify, audit } = require("../services/audit");
const config = require("../config");
const crypto = require("crypto");
const router = express.Router();

router.post("/register", async (req, res) => {
  try {
    const { full_name, phone, email, password, location, captcha_answer } = req.body || {};
    if (!full_name || !phone || !password || String(password).length < 6) {
      return res.status(400).json({ error: "Name, phone and password (min 6) required." });
    }
    // Simple math captcha optional: captcha_token verified client-side with /auth/captcha
    if (req.body.captcha_id && req.body.captcha_token) {
      const expect = crypto.createHmac("sha256", config.sessionSecret)
        .update(req.body.captcha_id + ":" + String(captcha_answer || "").trim())
        .digest("hex");
      if (expect !== req.body.captcha_token) {
        return res.status(400).json({ error: "Human verification failed." });
      }
    }
    const existing = await query("SELECT id FROM users WHERE phone = $1", [String(phone).trim()]);
    if (existing.rows[0]) return res.status(400).json({ error: "This phone number is already registered." });
    if (config.otpRequired) {
      const vt = req.body.verify_token;
      if (!vt) return res.status(400).json({ error: "Phone/email OTP verification required before registration." });
      const otpRow = await query(
        `SELECT * FROM otp_codes WHERE verify_token = $1 AND verified = TRUE AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1`,
        [String(vt)]
      );
      if (!otpRow.rows[0]) return res.status(400).json({ error: "Invalid or expired OTP verification. Request a new code." });
      // consume token
      await query(`UPDATE otp_codes SET verify_token = NULL WHERE id = $1`, [otpRow.rows[0].id]);
    }
    if (email) {
      const e2 = await query("SELECT id FROM users WHERE email = $1", [String(email).trim().toLowerCase()]);
      if (e2.rows[0]) return res.status(400).json({ error: "Email already registered." });
    }
    const { rows } = await query(
      `INSERT INTO users (full_name, phone, email, password_hash, role, location)
       VALUES ($1,$2,$3,$4,'user',$5) RETURNING *`,
      [full_name.trim(), String(phone).trim(), email ? String(email).trim().toLowerCase() : null, hashPassword(password), location || null]
    );
    const user = rows[0];
    const token = signToken({ sub: user.id, role: user.role });
    await notify(user.id, "Welcome to Mmarakeng", "Your account is ready.", "/#/profile");
    res.json({ token, user: publicUser(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Registration failed" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { phone, password } = req.body || {};
    const { rows } = await query("SELECT * FROM users WHERE phone = $1", [String(phone || "").trim()]);
    const user = rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: "Invalid phone or password." });
    }
    const token = signToken({ sub: user.id, role: user.role });
    res.json({ token, user: publicUser(user) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/me", requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

router.post("/change-password", requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!new_password || String(new_password).length < 6) {
    return res.status(400).json({ error: "New password min 6 characters." });
  }
  if (!verifyPassword(current_password, req.user.password_hash)) {
    return res.status(400).json({ error: "Current password is incorrect." });
  }
  await query("UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2", [
    hashPassword(new_password), req.user.id
  ]);
  await audit(req.user.id, "password_changed", "user", req.user.id, null, null);
  res.json({ ok: true, message: "Password updated." });
});

router.post("/change-phone", requireAuth, async (req, res) => {
  const { current_password, new_phone } = req.body || {};
  if (!verifyPassword(current_password, req.user.password_hash)) {
    return res.status(400).json({ error: "Current password is incorrect." });
  }
  const phone = String(new_phone || "").trim();
  if (phone.length < 5) return res.status(400).json({ error: "Invalid phone." });
  const clash = await query("SELECT id FROM users WHERE phone = $1 AND id <> $2", [phone, req.user.id]);
  if (clash.rows[0]) return res.status(400).json({ error: "Phone already in use." });
  await query("UPDATE users SET phone = $1, updated_at = NOW() WHERE id = $2", [phone, req.user.id]);
  const { rows } = await query("SELECT * FROM users WHERE id = $1", [req.user.id]);
  res.json({ ok: true, user: publicUser(rows[0]) });
});

router.get("/captcha", (_req, res) => {
  const a = 1 + Math.floor(Math.random() * 9);
  const b = 1 + Math.floor(Math.random() * 9);
  const id = crypto.randomBytes(16).toString("hex");
  const token = crypto.createHmac("sha256", config.sessionSecret).update(id + ":" + (a + b)).digest("hex");
  res.json({ captcha_id: id, question: `What is ${a} + ${b}?`, token, hcaptcha_sitekey: config.hcaptchaSitekey || null });
});

router.post("/otp/send", async (req, res) => {
  const { phone, email, purpose } = req.body || {};
  const target = phone ? String(phone).trim() : String(email || "").trim().toLowerCase();
  if (!target) return res.status(400).json({ error: "Phone or email required." });
  const code = randomCode(6);
  await query(
    `INSERT INTO otp_codes (target, channel, code_hash, purpose, expires_at)
     VALUES ($1,$2,$3,$4, NOW() + INTERVAL '10 minutes')`,
    [target, phone ? "phone" : "email", sha256(code), purpose || "register"]
  );
  const sandbox = process.env.NODE_ENV !== "production" || process.env.OTP_SANDBOX === "1";
  if (sandbox) console.log(`[OTP] ${target} => ${code}`);
  res.json({
    ok: true,
    message: "Verification code sent (or logged in sandbox).",
    sandbox_code: sandbox ? code : null,
    expires_in_seconds: 600
  });
});

router.post("/otp/verify", async (req, res) => {
  const { phone, email, code } = req.body || {};
  const target = phone ? String(phone).trim() : String(email || "").trim().toLowerCase();
  const { rows } = await query(
    `SELECT * FROM otp_codes WHERE target = $1 AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1`,
    [target]
  );
  const row = rows[0];
  if (!row) return res.status(400).json({ error: "No valid code. Request a new OTP." });
  await query("UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1", [row.id]);
  if (row.attempts >= 5) return res.status(400).json({ error: "Too many attempts." });
  if (sha256(String(code || "").trim()) !== row.code_hash) {
    return res.status(400).json({ error: "Invalid code." });
  }
  const verify_token = crypto.randomBytes(24).toString("hex");
  await query("UPDATE otp_codes SET verified = TRUE, verify_token = $1 WHERE id = $2", [verify_token, row.id]);
  res.json({ ok: true, verify_token });
});

module.exports = router;
