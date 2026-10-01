// ============================================================
// API keys — inbound auth for /v1/messages and /v1/classify.
// Keys are created/revoked from the dashboard and persist in
// data/api-keys.json (data/ is gitignored). Only SHA-256 hashes
// are stored; the plaintext key is returned exactly once, at
// creation. Once at least one key exists, both /v1/* routes
// require a valid key (see requireApiKey in index.js).
// ============================================================

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const STORE_PATH = path.join(__dirname, "..", "data", "api-keys.json");
const KEY_PREFIX = "sk-relay-";
const MAX_NAME_LENGTH = 60;
// lastUsedAt is cosmetic (minute granularity in the dashboard), so
// verify() only persists when the last write is older than this —
// create/revoke always write immediately.
const LAST_USED_PERSIST_MS = 30_000;

function sha256hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    return { keys: Array.isArray(raw.keys) ? raw.keys : [] };
  } catch (_) {
    return { keys: [] };
  }
}

let state = load();
let lastWriteAt = 0;

function save() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(state, null, 2));
  lastWriteAt = Date.now();
}

/** Persist only when the last write is old enough (see gate above). */
function persistIfDue() {
  if (Date.now() - lastWriteAt >= LAST_USED_PERSIST_MS) save();
}

function toPublic(entry) {
  const { hash, ...pub } = entry;
  return pub;
}

/**
 * Create a key. Returns { entry, secret } or null for an invalid name.
 * `secret` is the only time the plaintext key is exposed — callers
 * must hand it to the client once and never store it.
 */
function createKey(name) {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > MAX_NAME_LENGTH) return null;

  const secret = KEY_PREFIX + crypto.randomBytes(32).toString("hex");
  const entry = {
    id: crypto.randomUUID(),
    name: trimmed,
    hash: sha256hex(secret),
    prefix: KEY_PREFIX + secret.slice(KEY_PREFIX.length, KEY_PREFIX.length + 8),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    lastUsedRoute: null,
  };
  state.keys.unshift(entry); // newest first
  save();
  return { entry: toPublic(entry), secret };
}

/**
 * Verify a raw key string against the store. On a hit, updates usage
 * bookkeeping and returns the public entry; otherwise null.
 */
function verify(rawKey, route) {
  if (typeof rawKey !== "string" || !rawKey) return null;
  const digest = sha256hex(rawKey);
  const digestBuf = Buffer.from(digest, "hex");

  for (const entry of state.keys) {
    // Skip entries whose stored hash isn't a well-formed sha256 —
    // timingSafeEqual throws on length mismatch (corrupt file guard).
    const stored = Buffer.from(entry.hash, "hex");
    if (stored.length !== digestBuf.length) continue;
    if (!crypto.timingSafeEqual(stored, digestBuf)) continue;

    entry.lastUsedAt = new Date().toISOString();
    entry.lastUsedRoute = route;
    persistIfDue();
    return toPublic(entry);
  }
  return null;
}

function listKeys() {
  return state.keys.map(toPublic);
}

function revokeKey(id) {
  const before = state.keys.length;
  state.keys = state.keys.filter((k) => k.id !== id);
  if (state.keys.length === before) return false;
  save();
  return true;
}

function count() {
  return state.keys.length;
}

module.exports = {
  createKey,
  verify,
  listKeys,
  revokeKey,
  count,
};
