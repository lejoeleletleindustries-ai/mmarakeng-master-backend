const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const config = require("../config");

function hashPassword(password) {
  return bcrypt.hashSync(String(password), 10);
}

function verifyPassword(password, hash) {
  return bcrypt.compareSync(String(password), hash || "");
}

function signToken(payload, expiresIn = "30d") {
  return jwt.sign(payload, config.jwtSecret, { expiresIn });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
}

function sha256(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

function randomCode(len = 6) {
  const n = Math.pow(10, len - 1);
  return String(Math.floor(n + Math.random() * (9 * n)));
}

function lockboxCode() {
  return "LB-" + crypto.randomBytes(8).toString("hex").toUpperCase();
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken, sha256, randomCode, lockboxCode };
