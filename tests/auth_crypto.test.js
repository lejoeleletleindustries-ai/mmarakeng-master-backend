const assert = require("assert");
const { hashPassword, verifyPassword, signToken, verifyToken, sha256 } = require("../src/utils/crypto");

assert.ok(hashPassword("secret123").startsWith("$2"));
assert.ok(verifyPassword("secret123", hashPassword("secret123")));
assert.ok(!verifyPassword("wrong", hashPassword("secret123")));
const tok = signToken({ sub: "user-1", role: "user" }, "1h");
const payload = verifyToken(tok);
assert.strictEqual(payload.sub, "user-1");
assert.ok(sha256("abc").length === 64);
console.log("PASS: auth crypto");
