import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

// ============================================================
// SQLite shared with the Express proxy via the ./data bind
// mount. The proxy writes usage_daily/request_events/api_keys;
// the dashboard reads those and writes users/sessions (login).
// WAL lets both containers touch the file concurrently.
//
// DB_PATH is set by docker-compose; local dev falls back to the
// repo-root data/ dir (the dashboard's cwd is dashboard/ under
// `next dev`).
//
// LAZY open: Next executes the layout during build-time page
// collection — importing this module must not touch the disk,
// otherwise `next build` in a fresh container dies on a missing
// ../data dir. getDb() opens on first actual query.
//
// Mirrors the proxy's lib/db.js. Server-only: imported from
// proxy.ts and route handlers, never from client components.
// ============================================================

const DB_PATH =
  process.env.DB_PATH || path.resolve(process.cwd(), "..", "data", "app.db");
const SCHEMA_PATH = path.join(process.cwd(), "lib", "schema.sql");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("busy_timeout = 5000"); // the proxy writes too — wait, don't fail
  _db.pragma("foreign_keys = ON");
  // Idempotent mirror of the proxy's db/schema.sql — lets the
  // dashboard boot and serve /login before the proxy has run.
  _db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
  // ALTER-style migrations for DBs created before the billing
  // columns existed (mirror of lib/db.js migrate()). The proxy
  // may win the race — "duplicate column name" is harmless.
  try {
    const cols = _db
      .prepare("PRAGMA table_info(users)")
      .all()
      .map((c) => (c as { name: string }).name);
    if (!cols.includes("plan")) {
      _db.exec("ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'none'");
      console.log("[db] migrated: users.plan");
    }
    if (!cols.includes("plan_expiry")) {
      _db.exec("ALTER TABLE users ADD COLUMN plan_expiry INTEGER");
      console.log("[db] migrated: users.plan_expiry");
    }
    if (!cols.includes("balance_usd")) {
      _db.exec("ALTER TABLE users ADD COLUMN balance_usd REAL NOT NULL DEFAULT 0");
      console.log("[db] migrated: users.balance_usd");
    }
    if (!cols.includes("dodo_customer_id")) {
      _db.exec("ALTER TABLE users ADD COLUMN dodo_customer_id TEXT");
      console.log("[db] migrated: users.dodo_customer_id");
    }
    const dailyCols = _db
      .prepare("PRAGMA table_info(usage_daily)")
      .all()
      .map((c) => (c as { name: string }).name);
    if (dailyCols.length && !dailyCols.includes("compaction_cost_usd")) {
      _db.exec(
        "ALTER TABLE usage_daily ADD COLUMN compaction_cost_usd REAL NOT NULL DEFAULT 0"
      );
      console.log("[db] migrated: usage_daily.compaction_cost_usd");
    }
  } catch (err) {
    console.warn("[db] migrate skipped:", (err as Error).message);
  }
  return _db;
}

export default getDb;
