// ============================================================
// SQLite — the durable store for users, sessions, API keys,
// per-user daily usage rollups and request events.
//
// One file (data/app.db, gitignored) shared with the dashboard
// container via the ./data bind mount. WAL lets both processes
// read and write concurrently; writes are tiny and rare, so a
// single-file DB is the right tool at this scale (the VPS has
// 1 GB RAM — no Postgres).
//
// The module exports the raw better-sqlite3 Database handle;
// each domain module (api-keys.js, metrics.js, plans.js) prepares
// its own statements against it. Applying db/schema.sql at every
// boot (all statements are IF NOT EXISTS) covers fresh installs;
// migrate() below ALTERs pre-existing DBs for new COLUMNS (new
// tables come from schema.sql alone).
// ============================================================

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "app.db");
const SCHEMA_PATH = path.join(__dirname, "..", "db", "schema.sql");
// Pre-SQLite key store. Migrated once, then renamed so it can't
// be re-applied (hash UNIQUE makes re-applying a no-op anyway).
const LEGACY_KEYS_PATH = path.join(__dirname, "..", "data", "api-keys.json");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000"); // both containers touch the file — wait, don't fail
db.pragma("foreign_keys = ON");

db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));

/**
 * ALTER-style migrations for DBs created before the billing
 * columns existed. schema.sql alone only covers fresh installs.
 * Both containers boot against the same file, so a concurrent
 * ALTER from the dashboard process is a harmless "duplicate
 * column name" error — hence the try/catch.
 */
function migrate() {
  const cols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (!cols.includes("plan")) {
    db.exec("ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'none'");
    console.log("[db] migrated: users.plan");
  }
  if (!cols.includes("plan_expiry")) {
    db.exec("ALTER TABLE users ADD COLUMN plan_expiry INTEGER");
    console.log("[db] migrated: users.plan_expiry");
  }
  if (!cols.includes("balance_usd")) {
    db.exec("ALTER TABLE users ADD COLUMN balance_usd REAL NOT NULL DEFAULT 0");
    console.log("[db] migrated: users.balance_usd");
  }
  if (!cols.includes("dodo_customer_id")) {
    db.exec("ALTER TABLE users ADD COLUMN dodo_customer_id TEXT");
    console.log("[db] migrated: users.dodo_customer_id");
  }
  const dailyCols = db
    .prepare("PRAGMA table_info(usage_daily)")
    .all()
    .map((c) => c.name);
  if (dailyCols.length && !dailyCols.includes("compaction_cost_usd")) {
    db.exec(
      "ALTER TABLE usage_daily ADD COLUMN compaction_cost_usd REAL NOT NULL DEFAULT 0"
    );
    console.log("[db] migrated: usage_daily.compaction_cost_usd");
  }
}
try {
  migrate();
} catch (err) {
  console.warn("[db] migrate skipped:", err.message);
}

/**
 * One-time migration: data/api-keys.json -> api_keys table. Keys
 * created before accounts existed get user_id NULL and can be
 * claimed later. Runs only while the file exists; after success
 * it is renamed to api-keys.json.migrated.
 */
function migrateLegacyKeys() {
  if (!fs.existsSync(LEGACY_KEYS_PATH)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(LEGACY_KEYS_PATH, "utf8"));
    const keys = Array.isArray(raw.keys) ? raw.keys : [];
    if (!keys.length) return;
    const insert = db.prepare(
      `INSERT OR IGNORE INTO api_keys
         (id, user_id, name, hash, prefix, created_at, last_used_at, last_used_route)
       VALUES (@id, NULL, @name, @hash, @prefix, @createdAt, @lastUsedAt, @lastUsedRoute)`
    );
    db.transaction((rows) => {
      for (const k of rows) insert.run(k);
    })(keys);
    fs.renameSync(LEGACY_KEYS_PATH, LEGACY_KEYS_PATH + ".migrated");
    console.log(`[db] migrated ${keys.length} API key(s) from api-keys.json`);
  } catch (err) {
    console.warn("[db] api-keys.json migration skipped:", err.message);
  }
}
migrateLegacyKeys();

module.exports = db;
