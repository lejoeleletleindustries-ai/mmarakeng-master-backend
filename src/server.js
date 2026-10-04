require("dotenv").config();
const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const config = require("./config");

const app = express();

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
  hidePoweredBy: true
}));

const corsOrigins = config.corsOrigin
  ? config.corsOrigin.split(",").map((s) => s.trim()).filter(Boolean)
  : [];
app.use(cors({
  origin: corsOrigins.length ? corsOrigins : (config.isProd ? false : true),
  credentials: true
}));

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: config.isProd ? 120 : 400,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Try again shortly." }
}));

const uploadsDir = path.join(process.cwd(), "uploads");
["digital", "listings", "profiles", "distress", "public"].forEach((d) => {
  fs.mkdirSync(path.join(uploadsDir, d), { recursive: true });
});

// SECURITY: only intentionally public assets (previews, listing images) — NOT private digital products
app.use("/uploads/public", express.static(path.join(uploadsDir, "public"), {
  fallthrough: false,
  index: false
}));
app.use("/uploads/listings", express.static(path.join(uploadsDir, "listings"), {
  fallthrough: false,
  index: false
}));
app.use("/uploads/profiles", express.static(path.join(uploadsDir, "profiles"), {
  fallthrough: false,
  index: false
}));
// DO NOT mount /uploads/digital or /uploads/distress as static

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
app.use("/api/location", require("./routes/location"));
app.use("/api/distress", require("./routes/distress"));
app.use("/api/timed-auth", require("./routes/timedAuth"));
app.use("/api/delivery", require("./routes/delivery"));
app.use("/api", require("./routes/misc"));

app.get("*", (req, res) => {
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
  console.error(err && err.stack ? err.stack : err);
  const status = err.status || err.statusCode || 500;
  const msg = config.isProd
    ? (status < 500 ? (err.message || "Request failed") : "Server error")
    : (err.message || "Server error");
  res.status(status).json({ error: msg });
});

async function start() {
  if (config.isProd && !config.databaseUrl) {
    console.error("FATAL: DATABASE_URL is required in production.");
    process.exit(1);
  }
  app.listen(config.port, config.host, () => {
    console.log(`Mmarakeng Master Backend listening on ${config.host}:${config.port}`);
    console.log(`Environment: ${config.env}`);
  });
}

start().catch((e) => {
  console.error(e);
  process.exit(1);
});
