// ============================================================
// API keys — inbound auth for /v1/messages and /v1/classify.
// Keys are created/revoked from the dashboard and persist in the
// api_keys table of data/app.db (was data/api-keys.json — rows
// are migrated at boot by lib/db.js). Only SHA-256 hashes are
// stored; the plaintext key is returned exactly once, at
// creation. Once at least one key exists, both /v1/* routes
// require a valid key (see requireApiKey in index.js).
//
// Public entries carry userId so request metrics can attribute
// usage to an account (usage_daily rollups).
// ============================================================

const crypto = require("crypto");
const db = require("./db");

const KEY_PREFIX = "sk-relay-";
const MAX_NAME_LENGTH = 60;
// last_used_at is cosmetic (minute granularity in the dashboard),
// so verify() only touches the DB when the last write is older
// than this — create/revoke always write immediately.
const LAST_USED_PERSIST_MS = 30_000;
let lastTouchAt = 0;

const stmts = {
  insert: db.prepare(
    `INSERT INTO api_keys (id, user_id, name, hash, prefix, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ),
  byHash: db.prepare(
    `SELECT * FROM api_keys WHERE hash = ? AND revoked_at IS NULL`
  ),
  touch: db.prepare(
    `UPDATE api_keys SET last_used_at = ?, last_used_route = ? WHERE id = ?`
  ),
  list: db.prepare(
    `SELECT * FROM api_keys WHERE revoked_at IS NULL ORDER BY created_at DESC`
  ),
  revoke: db.prepare(
    `UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`
  ),
  // Scoped variants: a signed-in non-operator only ever sees or
  // touches their own keys. Ownership is in the WHERE clause, so a
  // key of another account behaves exactly like an unknown id.
  listByUser: db.prepare(
    `SELECT * FROM api_keys WHERE revoked_at IS NULL AND user_id = ? ORDER BY created_at DESC`
  ),
  revokeScoped: db.prepare(
    `UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`
  ),
  count: db.prepare(
    `SELECT COUNT(*) AS n FROM api_keys WHERE revoked_at IS NULL`
  ),
};

function sha256hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function toPublic(row) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    lastUsedRoute: row.last_used_route,
    userId: row.user_id ?? null,
  };
}

/**
 * Create a key. Returns { entry, secret } or null for an invalid name.
 * `secret` is the only time the plaintext key is exposed — callers
 * must hand it to the client once and never store it.
 */
function createKey(name, userId = null) {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > MAX_NAME_LENGTH) return null;

  const secret = KEY_PREFIX + crypto.randomBytes(32).toString("hex");
  stmts.insert.run(
    crypto.randomUUID(),
    userId,
    trimmed,
    sha256hex(secret),
    KEY_PREFIX + secret.slice(KEY_PREFIX.length, KEY_PREFIX.length + 8),
    new Date().toISOString()
  );
  const row = stmts.byHash.get(sha256hex(secret));
  return { entry: toPublic(row), secret };
}

/**
 * Verify a raw key string against the store. On a hit, updates usage
 * bookkeeping and returns the public entry (with userId); otherwise null.
 */
function verify(rawKey, route) {
  if (typeof rawKey !== "string" || !rawKey) return null;
  const row = stmts.byHash.get(sha256hex(rawKey));
  if (!row) return null;

  // Gate the cosmetic last-used write — same 30s rule as before.
  if (Date.now() - lastTouchAt >= LAST_USED_PERSIST_MS) {
    stmts.touch.run(new Date().toISOString(), route, row.id);
    lastTouchAt = Date.now();
  }
  return toPublic(row);
}

/** Operator view: every active key, whoever owns it. */
function listKeys() {
  return stmts.list.all().map(toPublic);
}

/** Scoped view: only the given account's active keys. */
function listKeysForUser(userId) {
  return stmts.listByUser.all(userId).map(toPublic);
}

function revokeKey(id) {
  const result = stmts.revoke.run(new Date().toISOString(), id);
  return result.changes > 0;
}

/**
 * Revoke a key only if it belongs to userId. Returns false for a
 * key that is unknown, already revoked, or owned by someone else —
 * callers surface the same 404 for all three (no existence leak).
 */
function revokeKeyForUser(id, userId) {
  const result = stmts.revokeScoped.run(new Date().toISOString(), id, userId);
  return result.changes > 0;
}

function count() {
  return stmts.count.get().n;
}

module.exports = {
  createKey,
  verify,
  listKeys,
  listKeysForUser,
  revokeKey,
  revokeKeyForUser,
  count,
};
