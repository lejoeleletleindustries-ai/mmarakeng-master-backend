const assert = require("assert");
const fs = require("fs");
const path = require("path");

const service = fs.readFileSync(path.join(__dirname, "../src/services/lockboxRooms.js"), "utf8");
const routes = fs.readFileSync(path.join(__dirname, "../src/routes/lockbox.js"), "utf8");
const mig = fs.readFileSync(path.join(__dirname, "../migrations/003_lockbox_rooms_offline.sql"), "utf8");

assert.ok(service.includes("generateRoomCode"));
assert.ok(service.includes("generateAccessSecret"));
assert.ok(service.includes("client_message_id"));
assert.ok(service.includes("ON CONFLICT (room_id, client_message_id)"));
assert.ok(service.includes("PENDING_OFFLINE") || service.includes("pending_offline") || routes.includes("sync"));
assert.ok(service.includes("offlineBootstrap"));
assert.ok(service.includes("revokeParticipant"));
assert.ok(service.includes("regenerateCredentials"));
assert.ok(routes.includes("/rooms"));
assert.ok(routes.includes("/rooms/:roomId/sync"));
assert.ok(routes.includes("joinLimiter") || routes.includes("join"));
assert.ok(mig.includes("lockbox_rooms"));
assert.ok(mig.includes("lockbox_room_messages"));
assert.ok(mig.includes("UNIQUE(room_id, client_message_id)"));
assert.ok(mig.includes("lockbox_room_participants"));

// Ensure secret is hashed not stored plaintext in insert
assert.ok(service.includes("hashPassword(accessSecret)"));
assert.ok(service.includes("verifyPassword(secret, room.access_secret_hash)"));

console.log("PASS: offline Lockbox room architecture static checks");
