-- MIRROR of ../db/schema.sql (the proxy's copy — keep them in sync).
-- The dashboard applies it too, so the dashboard can boot and serve
-- login even when the proxy container hasn't created the tables yet.
-- Copied into the standalone image by dashboard/Dockerfile (Next's
-- output tracing doesn't pick up non-code assets).
--
-- New COLUMNS on existing tables also need the ALTER migration in
-- lib/db.ts (mirroring lib/db.js) — this file alone only covers
-- fresh installs.
-- ============================================================

-- Accounts. Created via db/create-user.js (operator) or open
-- signup in the dashboard (status starts 'pending'; the first
-- top-up payment flips it to 'active'). balance_usd is prepaid
-- credit (webhook credits, metrics debits). plan/plan_expiry are
-- legacy subscription columns, dormant.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,          -- bcrypt (bcryptjs, cost 12)
  name          TEXT,
  created_at    INTEGER NOT NULL,       -- epoch ms
  status        TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'pending' | 'suspended'
  plan          TEXT NOT NULL DEFAULT 'none',    -- legacy; unused
  plan_expiry   INTEGER,                         -- legacy; unused
  balance_usd   REAL NOT NULL DEFAULT 0,         -- prepaid credit; negative = overage into the $1 grace
  dodo_customer_id TEXT                          -- Dodo customer id (for the billing portal)
);

-- Opaque login sessions. The cookie holds the raw 32-byte token;
-- only its sha256 lives here, so a DB leak doesn't leak sessions.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,          -- epoch ms
  expires_at INTEGER NOT NULL           -- epoch ms (30 days)
);

-- Inbound API keys for /v1/*. Rows are migrated from the old
-- data/api-keys.json by the proxy's lib/db.js.
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
-- persist tick upserts deltas accumulated in memory. No prompt
-- text, no per-request detail — only aggregate money/tokens.
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
  compaction_cost_usd REAL NOT NULL DEFAULT 0,
  baseline_cost_usd   REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- Durable request history for the dashboard Activity page.
-- Metadata ONLY (no prompt text), ring-buffered by the proxy.
CREATE TABLE IF NOT EXISTS request_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT,
  ts            INTEGER NOT NULL,       -- epoch ms
  model         TEXT,                   -- selected model id
  route         TEXT,                   -- classified routing.model_type
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cost_usd      REAL,
  ok            INTEGER
);

CREATE INDEX IF NOT EXISTS idx_request_events_user_ts
  ON request_events(user_id, ts DESC);

-- Per-user auto-routing preferences set from the dashboard. One
-- row per user; a missing row means "all defaults". Written by
-- the proxy (lib/user-prefs.js); read-only here. See the proxy's
-- db/schema.sql for the full comment.
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
