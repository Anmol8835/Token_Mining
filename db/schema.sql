-- ============================================================
-- Steeros relay — durable store schema (data/app.db, gitignored)
--
-- One SQLite file shared by the Express proxy and the dashboard
-- container via the ./data bind mount. The proxy WRITES
-- (api_keys, usage_daily, request_events); the dashboard
-- reads/writes users + sessions (login) and reads the rest.
--
-- All statements are idempotent (CREATE TABLE IF NOT EXISTS) —
-- lib/db.js applies this file at every boot, and
-- dashboard/lib/db.ts applies its mirror copy. Fresh installs
-- get this whole file; pre-existing DBs are upgraded by the
-- migrate() step in lib/db.js and dashboard/lib/db.ts (PRAGMA
-- table_info + ALTER TABLE ADD COLUMN), so new COLUMNS on
-- existing tables must be added in BOTH places. New TABLES only
-- need this file.
-- ============================================================

-- Accounts. Created via db/create-user.js (operator) or open
-- signup in the dashboard (status starts 'pending'). The plan
-- columns are denormalized from the subscriptions table by the
-- webhook handler so the per-request plan check is one row read.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,          -- bcrypt (bcryptjs, cost 12)
  name          TEXT,
  created_at    INTEGER NOT NULL,       -- epoch ms
  status        TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'pending' | 'suspended'
  plan          TEXT NOT NULL DEFAULT 'none',    -- plan id from config/plans.json
  plan_expiry   INTEGER                          -- epoch ms; NULL = no active period
);

-- Opaque login sessions. The cookie holds the raw 32-byte token;
-- only its sha256 lives here, so a DB leak doesn't leak sessions.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,          -- epoch ms
  expires_at INTEGER NOT NULL           -- epoch ms (30 days)
);

-- Inbound API keys for /v1/* (was data/api-keys.json — rows are
-- migrated from there at boot when the file still exists). Keys
-- belong to a user (attribution for usage_daily); NULL = key
-- created before accounts existed.
CREATE TABLE IF NOT EXISTS api_keys (
  id             TEXT PRIMARY KEY,
  user_id        TEXT REFERENCES users(id),
  name           TEXT NOT NULL,
  hash           TEXT UNIQUE NOT NULL,  -- sha256 of the key; plaintext never stored
  prefix         TEXT NOT NULL,         -- "sk-relay-xxxxxxxx" for the UI
  created_at     TEXT NOT NULL,         -- ISO string (matches the old JSON shape)
  last_used_at   TEXT,
  last_used_route TEXT,
  revoked_at     TEXT                   -- soft revoke; NULL = active
);

-- THE totals table: one row per user per day. The proxy's 30s
-- persist tick upserts deltas accumulated in memory (restart-safe
-- because the UPSERT ADDS to the existing row). No prompt text,
-- no per-request detail — only aggregate money/tokens.
--   cost_usd          = provider spend
--   classifier_cost_usd = LLM-classifier spend (classified requests)
--   baseline_cost_usd = the same traffic priced on the PRIMARY
--     baseline model (pricing.baselines[0] — the flagship).
--   saved = baseline_cost_usd − (cost_usd + classifier_cost_usd),
--     derived at read time, never stored.
-- Compaction cost stays global-only (recordCompaction has no
-- user context). Unattributed traffic (zero-key bootstrap mode)
-- lands under user_id 'anonymous' (NULL would break the PK —
-- SQLite treats NULLs as distinct in primary keys).
CREATE TABLE IF NOT EXISTS usage_daily (
  user_id             TEXT NOT NULL,
  day                 TEXT NOT NULL,    -- 'YYYY-MM-DD' (UTC)
  requests            INTEGER NOT NULL DEFAULT 0,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
  cost_usd            REAL NOT NULL DEFAULT 0,
  classifier_cost_usd REAL NOT NULL DEFAULT 0,
  baseline_cost_usd   REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- Durable request history for the dashboard Activity page.
-- Metadata ONLY (no prompt text), ring-buffered: the persist tick
-- deletes rows older than 14 days or beyond the newest 20k.
CREATE TABLE IF NOT EXISTS request_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT,                   -- NULL = unauthenticated bootstrap traffic
  ts            INTEGER NOT NULL,       -- epoch ms
  model         TEXT,                   -- selected model id
  route         TEXT,                   -- classified routing.model_type
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cost_usd      REAL,
  ok            INTEGER                 -- 1/0 provider success, NULL = no provider call
);

CREATE INDEX IF NOT EXISTS idx_request_events_user_ts
  ON request_events(user_id, ts DESC);

-- Per-user auto-routing preferences set from the dashboard. One
-- row per user; a missing row means "all defaults" (no mode, no
-- exclusions). The router unions the user's disabledModels with
-- the operator's global list (data/dashboard-prefs.json) — global
-- exclusions always apply. routing_mode NULL = inherit the global
-- mode. Lib: lib/user-prefs.js.
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id         TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  routing_mode    TEXT,                 -- cheap|fast|balanced|quality; NULL = inherit global
  disabled_models TEXT NOT NULL DEFAULT '[]',  -- JSON array of model ids
  updated_at      INTEGER NOT NULL      -- epoch ms
);

-- ============================================================
-- Billing (Dodo Payments)
-- ============================================================

-- Checkout sessions created by the dashboard at Subscribe time.
-- Written BEFORE the user is sent to Dodo so webhook events can
-- be correlated (metadata echo from Dodo is not guaranteed).
CREATE TABLE IF NOT EXISTS checkout_sessions (
  session_id   TEXT PRIMARY KEY,        -- Dodo checkout session id
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id   TEXT NOT NULL,           -- pdt_xxx (per-environment)
  status       TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'completed'
  created_at   INTEGER NOT NULL,        -- epoch ms
  completed_at INTEGER
);

-- Dodo subscriptions — the webhook-written source of truth.
-- Enforcement reads users.plan/plan_expiry (denormalized by the
-- webhook handler in the same transaction); this table drives
-- the billing page and reconciliation.
CREATE TABLE IF NOT EXISTS subscriptions (
  id                 TEXT PRIMARY KEY,  -- Dodo subscription id
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dodo_customer_id   TEXT,              -- Dodo customer id (for the portal)
  product_id         TEXT,              -- pdt_xxx
  status             TEXT NOT NULL,     -- last known Dodo status
  plan               TEXT NOT NULL,     -- our plan id (mapped from product_id)
  current_period_end INTEGER,           -- epoch ms
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user
  ON subscriptions(user_id);

-- Every webhook delivery, keyed by the Standard Webhooks id
-- header. Idempotency gate (INSERT OR IGNORE) + manual
-- reconciliation for uncorrelatable events (user_id NULL).
CREATE TABLE IF NOT EXISTS payment_events (
  webhook_id TEXT PRIMARY KEY,          -- Dodo webhook-id header
  type       TEXT NOT NULL,             -- e.g. 'subscription.active'
  payload    TEXT NOT NULL,             -- full JSON envelope
  user_id    TEXT,                      -- correlated user (NULL = reconcile manually)
  processed  INTEGER NOT NULL DEFAULT 0, -- 0 = pending, 1 = handled
  error      TEXT,
  created_at INTEGER NOT NULL
);
