/**
 * Static review: lockbox routes must require auth and participant checks.
 * Runtime DB tests require DATABASE_URL.
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const src = fs.readFileSync(path.join(__dirname, "../src/routes/lockbox.js"), "utf8");
assert.ok(src.includes("requireAuth"));
assert.ok(src.includes("user_a") && src.includes("user_b"));
assert.ok(src.includes("Not authorized"));
assert.ok(src.includes("requireOwner"));
assert.ok(src.includes("lockbox_owner_access") || src.includes("owner_access"));
console.log("PASS: lockbox authorization patterns present");
