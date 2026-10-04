const assert = require("assert");
const fs = require("fs");
const path = require("path");

const lock = fs.readFileSync(path.join(__dirname, "../package-lock.json"), "utf8");
assert.ok(!lock.includes("35.245.43.102"), "package-lock must not use 35.245.43.102");
assert.ok(lock.includes("registry.npmjs.org"), "package-lock should use registry.npmjs.org");

const server = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");
assert.ok(!server.includes('app.use("/uploads", express.static'), "must not expose full /uploads statically");
assert.ok(server.includes("/uploads/digital") === false || !/app\.use\(\s*"\/uploads\/digital"/.test(server));
assert.ok(server.includes("location") || fs.existsSync(path.join(__dirname, "../src/routes/location.js")));
assert.ok(fs.existsSync(path.join(__dirname, "../src/routes/distress.js")));
assert.ok(fs.existsSync(path.join(__dirname, "../src/routes/timedAuth.js")));
assert.ok(fs.existsSync(path.join(__dirname, "../migrations/004_location_distress_timed_auth.sql")));

const config = fs.readFileSync(path.join(__dirname, "../src/config/index.js"), "utf8");
assert.ok(config.includes("process.exit(1)"), "production must fail without strong secrets");

console.log("PASS: security static checks (lockfile, uploads, new routes)");
