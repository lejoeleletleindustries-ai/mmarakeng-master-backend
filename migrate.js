require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { pool, query } = require("../src/db/pool");

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const dir = path.join(__dirname, "..", "migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  await query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  for (const f of files) {
    const id = f;
    const done = await query("SELECT 1 FROM schema_migrations WHERE id = $1", [id]);
    if (done.rows[0]) {
      console.log("skip", id);
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    console.log("apply", id);
    await query(sql);
    await query("INSERT INTO schema_migrations (id) VALUES ($1)", [id]);
  }
  console.log("Migrations complete.");
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
