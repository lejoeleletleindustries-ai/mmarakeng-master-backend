const express = require("express");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const { query } = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
const { sha256 } = require("../utils/crypto");
const { audit } = require("../services/audit");
const router = express.Router();

const attemptLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many timed-auth attempts." }
});

/**
 * Canonical representation: steps joined + normalized interval buckets.
 * Client sends: { steps: [1,2,3,4,5], intervals_ms: [3000,5000,...] } between steps
 * Server hashes steps + rounded intervals (tolerance applied at verify time only for comparison of live attempt).
 */
function hashSequence(steps, intervalsMs) {
  const s = JSON.stringify({
    steps: steps.map(Number),
    intervals: intervalsMs.map((ms) => Math.round(Number(ms)))
  });
  return sha256(s);
}

router.get("/status", requireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT enabled, step_count, tolerance_ms, failed_attempts, locked_until, updated_at
     FROM timed_auth_profiles WHERE user_id = $1`,
    [req.user.id]
  );
  res.json({
    configured: !!rows[0],
    enabled: rows[0] ? rows[0].enabled : false,
    step_count: rows[0] ? rows[0].step_count : null,
    tolerance_ms: rows[0] ? rows[0].tolerance_ms : 800,
    locked_until: rows[0] ? rows[0].locked_until : null
    // never return sequence_hash or intervals
  });
});

/** Set/change sequence — requires normal auth */
router.put("/profile", requireAuth, attemptLimit, async (req, res) => {
  const steps = req.body?.steps;
  const intervals_ms = req.body?.intervals_ms;
  const tolerance_ms = Math.min(Math.max(Number(req.body?.tolerance_ms) || 800, 200), 3000);
  if (!Array.isArray(steps) || steps.length < 3 || steps.length > 12) {
    return res.status(400).json({ error: "steps array required (3–12 entries)." });
  }
  if (!Array.isArray(intervals_ms) || intervals_ms.length !== steps.length - 1) {
    return res.status(400).json({ error: "intervals_ms length must be steps.length - 1." });
  }
  const sequence_hash = hashSequence(steps, intervals_ms);
  await query(
    `INSERT INTO timed_auth_profiles (user_id, sequence_hash, step_count, intervals_ms_json, tolerance_ms, enabled, failed_attempts, locked_until, updated_at)
     VALUES ($1,$2,$3,$4,$5,TRUE,0,NULL,NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       sequence_hash = EXCLUDED.sequence_hash,
       step_count = EXCLUDED.step_count,
       intervals_ms_json = EXCLUDED.intervals_ms_json,
       tolerance_ms = EXCLUDED.tolerance_ms,
       enabled = TRUE,
       failed_attempts = 0,
       locked_until = NULL,
       updated_at = NOW()`,
    [req.user.id, sequence_hash, steps.length, JSON.stringify(intervals_ms.map(Number)), tolerance_ms]
  );
  await audit(req.user.id, "timed_auth_profile_updated", "user", req.user.id, null, { step_count: steps.length });
  res.json({ ok: true, enabled: true, step_count: steps.length, tolerance_ms });
});

/**
 * Verify attempt as second factor (does not replace password login).
 * Body: { steps, intervals_ms } measured on client with network-tolerant intervals.
 */
router.post("/verify", requireAuth, attemptLimit, async (req, res) => {
  const { rows } = await query(`SELECT * FROM timed_auth_profiles WHERE user_id = $1`, [req.user.id]);
  const profile = rows[0];
  if (!profile || !profile.enabled) {
    return res.status(400).json({ error: "Timed sequence not configured." });
  }
  if (profile.locked_until && new Date(profile.locked_until) > new Date()) {
    return res.status(429).json({ error: "Timed auth temporarily locked. Try later." });
  }
  const steps = req.body?.steps;
  const intervals_ms = req.body?.intervals_ms;
  if (!Array.isArray(steps) || !Array.isArray(intervals_ms)) {
    return res.status(400).json({ error: "steps and intervals_ms required." });
  }
  if (steps.length !== profile.step_count || intervals_ms.length !== profile.step_count - 1) {
    await failAttempt(profile, req);
    return res.status(401).json({ error: "Sequence verification failed." });
  }
  const storedIntervals = typeof profile.intervals_ms_json === "string"
    ? JSON.parse(profile.intervals_ms_json)
    : profile.intervals_ms_json;
  const tol = profile.tolerance_ms || 800;
  for (let i = 0; i < storedIntervals.length; i++) {
    if (Math.abs(Number(intervals_ms[i]) - Number(storedIntervals[i])) > tol) {
      await failAttempt(profile, req);
      return res.status(401).json({ error: "Sequence verification failed." });
    }
  }
  // Also require step values match via hash of steps + exact stored intervals
  const attemptHash = hashSequence(steps, storedIntervals);
  if (attemptHash !== profile.sequence_hash) {
    // steps wrong even if timing ok — recompute with submitted intervals only after timing match for steps
    const stepOnly = sha256(JSON.stringify({ steps: steps.map(Number) }));
    const storedStepOnly = sha256(JSON.stringify({
      steps: JSON.parse(JSON.stringify(steps)) // placeholder — stored hash includes intervals
    }));
    // Primary check: hash with stored intervals (timing already validated)
    const primary = hashSequence(steps, storedIntervals);
    if (primary !== profile.sequence_hash) {
      await failAttempt(profile, req);
      return res.status(401).json({ error: "Sequence verification failed." });
    }
  }
  await query(
    `UPDATE timed_auth_profiles SET failed_attempts = 0, locked_until = NULL, updated_at = NOW() WHERE user_id = $1`,
    [req.user.id]
  );
  await audit(req.user.id, "timed_auth_success", "user", req.user.id, null, null);
  // One-time challenge token for optional step-up
  const challenge = crypto.randomBytes(24).toString("hex");
  res.json({ ok: true, challenge_token: challenge, note: "Timed sequence verified (additional factor)." });
});

async function failAttempt(profile, req) {
  const fails = (profile.failed_attempts || 0) + 1;
  const lock = fails >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;
  await query(
    `UPDATE timed_auth_profiles SET failed_attempts = $1, locked_until = $2, updated_at = NOW() WHERE user_id = $3`,
    [fails, lock, req.user.id]
  );
  await audit(req.user.id, "timed_auth_failed", "user", req.user.id, null, { fails });
}

module.exports = router;
