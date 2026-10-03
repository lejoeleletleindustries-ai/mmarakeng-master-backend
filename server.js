require("dotenv").config();
const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const config = require("./config");

const app = express();

app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({ origin: config.corsOrigin === "*" ? true : config.corsOrigin.split(","), credentials: true }));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));

const uploadsDir = path.join(process.cwd(), "uploads");
fs.mkdirSync(path.join(uploadsDir, "digital"), { recursive: true });
fs.mkdirSync(path.join(uploadsDir, "listings"), { recursive: true });
fs.mkdirSync(path.join(uploadsDir, "profiles"), { recursive: true });
app.use("/uploads", express.static(uploadsDir));

const publicDir = path.join(process.cwd(), "public");
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

app.use("/api", require("./routes/health"));
app.use("/api/auth", require("./routes/auth"));
app.use("/api/listings", require("./routes/listings"));
app.use("/api/lockbox", require("./routes/lockbox"));
app.use("/api/admin", require("./routes/admin"));
app.use("/api/digital", require("./routes/digital"));
app.use("/api/payments", require("./routes/payments"));
app.use("/api", require("./routes/misc"));

// SPA fallback for optional admin UI assets
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) return res.status(404).json({ error: "Not found" });
  const index = path.join(publicDir, "index.html");
  if (fs.existsSync(index)) return res.sendFile(index);
  res.status(200).json({
    app: "Mmarakeng Master Backend",
    message: "API is running. Point client apps at this base URL.",
    health: "/api/health"
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || "Server error" });
});

async function start() {
  if (!config.databaseUrl) {
    console.error("FATAL: DATABASE_URL is required for production PostgreSQL.");
    console.error("Set DATABASE_URL then run: npm run migrate && npm run seed && npm start");
  }
  app.listen(config.port, config.host, () => {
    console.log(`Mmarakeng Master Backend listening on ${config.host}:${config.port}`);
    console.log(`Health: GET /api/health`);
  });
}

start().catch((e) => {
  console.error(e);
  process.exit(1);
});
