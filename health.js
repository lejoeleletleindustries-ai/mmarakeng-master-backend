const express = require("express");
const { query } = require("../db/pool");
const StorageService = require("../storage/StorageService");
const PaymentService = require("../payments/PaymentService");
const router = express.Router();

router.get("/health", async (_req, res) => {
  let db = "unknown";
  try {
    await query("SELECT 1");
    db = "connected";
  } catch (e) {
    db = "error: " + (e.message || "fail");
  }
  res.json({
    status: "ok",
    app: "Mmarakeng",
    mode: "master_backend",
    database: db,
    time: new Date().toISOString(),
    storage: StorageService.status(),
    payments_mode: PaymentService.paymentsMode()
  });
});

router.get("/central/info", (_req, res) => {
  res.json({
    app: "Mmarakeng",
    mode: "central_backend",
    message: "All client apps must use this public API base URL."
  });
});

module.exports = router;
