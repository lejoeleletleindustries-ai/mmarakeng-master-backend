const { Pool } = require("pg");
const config = require("../config");

if (!config.databaseUrl) {
  console.warn("[db] DATABASE_URL is not set. Migrations and API will fail until it is configured.");
}

const pool = new Pool({
  connectionString: config.databaseUrl || undefined,
  ssl: process.env.DATABASE_SSL === "0" ? false : config.env === "production" ? { rejectUnauthorized: false } : false,
  max: 20
});

pool.on("error", (err) => {
  console.error("[db] unexpected pool error", err.message);
});

async function query(text, params) {
  return pool.query(text, params);
}

async function withClient(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withClient };
