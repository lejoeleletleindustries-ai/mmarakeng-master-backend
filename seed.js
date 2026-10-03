require("dotenv").config();
const { pool, query } = require("../src/db/pool");
const { hashPassword } = require("../src/utils/crypto");
const config = require("../src/config");

const CATEGORIES = [
  "Jobs","Businesses & Services","Property","Plots & Land","Schools & Education",
  "Vehicles","Products","Events","Entertainment","Construction","Professional Services",
  "Agriculture","Promotions","Digital"
];

async function ensureOwner(o) {
  if (!o.password) {
    console.log("Skip owner (no password env):", o.email);
    return;
  }
  const existing = await query("SELECT id FROM users WHERE email = $1 OR phone = $2", [o.email, o.phone]);
  if (existing.rows[0]) {
    await query(`UPDATE users SET role = 'owner', is_owner = TRUE, full_name = $1 WHERE id = $2`, [o.name, existing.rows[0].id]);
    console.log("Owner ready:", o.email);
    return;
  }
  await query(
    `INSERT INTO users (full_name, phone, email, password_hash, role, is_owner, phone_verified, email_verified)
     VALUES ($1,$2,$3,$4,'owner',TRUE,TRUE,TRUE)`,
    [o.name, o.phone, o.email, hashPassword(o.password)]
  );
  console.log("Owner created:", o.email);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  for (const o of config.owners) await ensureOwner(o);

  const adminPhone = process.env.ADMIN_PHONE || "50000000";
  const adminPass = process.env.ADMIN_PASSWORD || "";
  if (adminPass) {
    const a = await query("SELECT id FROM users WHERE phone = $1", [adminPhone]);
    if (!a.rows[0]) {
      await query(
        `INSERT INTO users (full_name, phone, password_hash, role, phone_verified)
         VALUES ('Platform Admin',$1,$2,'admin',TRUE)`,
        [adminPhone, hashPassword(adminPass)]
      );
      console.log("Admin created:", adminPhone);
    }
  }

  const plans = await query("SELECT COUNT(*)::int AS c FROM subscription_plans");
  if (plans.rows[0].c === 0) {
    await query(
      `INSERT INTO subscription_plans (name, price, currency, duration_days, description, features, sort_order) VALUES
       ('Free', 0, 'LSL', 365, 'Basic browsing', '["Browse"]', 0),
       ('Starter', 49, 'LSL', 30, 'More listings', '["Listings","Basic support"]', 1),
       ('Business', 149, 'LSL', 30, 'Business tools', '["Promotions","Analytics"]', 2),
       ('Premium', 299, 'LSL', 30, 'Full access', '["Priority","Digital sales"]', 3)`
    );
    console.log("Subscription plans seeded");
  }

  const fields = await query("SELECT COUNT(*)::int AS c FROM category_fields");
  if (fields.rows[0].c === 0) {
    let order = 0;
    for (const cat of CATEGORIES) {
      await query(
        `INSERT INTO category_fields (category, field_key, field_label, field_type, is_required, sort_order)
         VALUES ($1,'details','Details','textarea',FALSE,$2)`,
        [cat, order++]
      );
    }
    console.log("Category fields seeded");
  }

  await query(
    `INSERT INTO app_settings (key, value) VALUES ('about_credit', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    ["MMARAKENG is an application built/designed by Lejwele Le Te Industries and Origin Dot App Series."]
  );

  console.log("Seed complete.");
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
