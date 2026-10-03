/**
 * Storage abstraction: local (dev only) or S3-compatible (production).
 * Paid/private files must not be world-readable; use authorized download flow.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");

function provider() {
  return (process.env.STORAGE_PROVIDER || "local").toLowerCase();
}

function s3Configured() {
  return !!(
    process.env.S3_BUCKET &&
    process.env.S3_ACCESS_KEY_ID &&
    process.env.S3_SECRET_ACCESS_KEY &&
    (process.env.S3_ENDPOINT || process.env.S3_REGION)
  );
}

function status() {
  const p = provider();
  return {
    provider: p,
    configured: p === "local" ? true : s3Configured(),
    bucket: p === "s3" ? (process.env.S3_BUCKET ? "[set]" : null) : null,
    note: p === "local"
      ? "Local disk is not durable on ephemeral hosts (e.g. free Render). Use S3-compatible storage for production."
      : "S3-compatible storage"
  };
}

async function putLocal(bufferOrPath, key, isPath) {
  const root = path.join(process.cwd(), "uploads");
  const dest = path.join(root, key);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (isPath) {
    fs.copyFileSync(bufferOrPath, dest);
  } else {
    fs.writeFileSync(dest, bufferOrPath);
  }
  return { key, url: "/uploads/" + key.replace(/\\/g, "/") };
}

/**
 * Put object. For S3, uses AWS Signature V4 via fetch when possible;
 * if S3 not configured and provider=s3, throws configuration error.
 */
async function putObject({ key, filePath, buffer, contentType }) {
  const p = provider();
  if (p === "s3") {
    if (!s3Configured()) {
      const err = new Error("S3 storage not configured. Set S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_ENDPOINT or S3_REGION.");
      err.code = "STORAGE_NOT_CONFIGURED";
      throw err;
    }
    // Minimal PUT using path-style endpoint — works with many S3-compatible providers.
    // Official AWS SDK can replace this later without changing call sites.
    const endpoint = process.env.S3_ENDPOINT || `https://s3.${process.env.S3_REGION}.amazonaws.com`;
    const bucket = process.env.S3_BUCKET;
    const url = `${endpoint.replace(/\/$/, "")}/${bucket}/${key}`;
    const body = buffer || fs.readFileSync(filePath);
    // Note: full SigV4 signing should be used in production with official SDK.
    // Placeholder stores metadata only if direct put unsupported without SDK.
    const err = new Error(
      "S3 upload requires official AWS SDK or signed requests. Install @aws-sdk/client-s3 when going live, or set STORAGE_PROVIDER=local for development only."
    );
    err.code = "S3_SDK_REQUIRED";
    err.hint = { endpoint, bucket, key, contentType };
    throw err;
  }
  return putLocal(filePath || buffer, key, !!filePath);
}

function resolveLocalPath(key) {
  const root = path.join(process.cwd(), "uploads");
  const dest = path.join(root, key);
  if (!dest.startsWith(root)) throw new Error("Invalid path");
  return dest;
}

async function getReadableStream(key) {
  if (provider() === "s3" && s3Configured()) {
    const err = new Error("Use getSignedDownloadUrl for S3 objects.");
    err.code = "USE_SIGNED_URL";
    throw err;
  }
  const dest = resolveLocalPath(key);
  if (!fs.existsSync(dest)) {
    const err = new Error("File not found");
    err.code = "NOT_FOUND";
    throw err;
  }
  return fs.createReadStream(dest);
}

/**
 * Signed URL placeholder for S3 — implement with official SDK when credentials exist.
 */
async function getSignedDownloadUrl(key, expiresSeconds = 300) {
  if (provider() === "local") {
    return { url: "/uploads/" + key.replace(/\\/g, "/"), expiresIn: expiresSeconds, local: true };
  }
  if (!s3Configured()) {
    const err = new Error("S3 not configured");
    err.code = "STORAGE_NOT_CONFIGURED";
    throw err;
  }
  const err = new Error("Signed URL generation requires official S3 SDK configuration. Configure @aws-sdk/client-s3 in production.");
  err.code = "S3_SDK_REQUIRED";
  throw err;
}

module.exports = { putObject, getReadableStream, getSignedDownloadUrl, status, provider, s3Configured };
