// ============================================================
// Top-ups — the enforcement side of Dodo Payments one-time
// purchases (prepaid credit). (The module/file name is a
// holdover from the subscription era; the catalog is now
// `topups`.)
//
// config/plans.json is the catalog (top-up id -> display
// amount in USD + the per-environment Dodo product ids). Dodo
// prices are entered in cents; the amount that lands in
// users.balance_usd is the payment amount Dodo reports on
// payment.succeeded — the catalog amountUsd is only what the
// dashboard shows, so keep the two aligned.
//
// The hot path is requireActivePlan in index.js: it calls
// getUserBalance(userId) — one indexed row read on users. No
// caching: the value changes on webhook credits and 30s usage
// flushes, and a cache would only ever stale money. The query is
// prepared once, better-sqlite3 sync reads are microseconds.
//
// Debits: metrics.js debits users.balance_usd inside the same
// 30s transaction that upserts usage_daily, so the balance can
// never diverge from the usage it bills. Enforcement can
// overshoot into the grace by up to ~30s of traffic — accepted
// (GRACE_USD absorbs it).
// ============================================================

const fs = require("fs");
const path = require("path");
const db = require("./db");

const PLANS_PATH = path.join(__dirname, "..", "config", "plans.json");

let topups = [];
try {
  topups = JSON.parse(fs.readFileSync(PLANS_PATH, "utf8")).topups || [];
} catch (err) {
  console.error(`[plans] failed to load ${PLANS_PATH}: ${err.message}`);
  process.exit(1);
}

// Dodo test and live product ids differ; the active set is chosen
// by the same env var the dashboard's Dodo client uses.
const environment =
  process.env.DODO_PAYMENTS_ENVIRONMENT === "test_mode" ? "test_mode" : "live_mode";

// Overage grace: requests keep working until the balance falls to
// (or below) -GRACE_USD, so a request in flight or a brief usage
// spike never gets hard-cut mid-work.
const GRACE_USD = 1.0;

const topupsById = new Map(topups.map((t) => [t.id, t]));
const topupsByProduct = new Map(
  topups.flatMap((t) => (t.products?.[environment] ? [[t.products[environment], t]] : []))
);

// Untagged models are treated as pro: a cheap plan must never be
// able to reach a model the catalog forgot to tag. (Tier gating is
// dormant while billing is balance-based — kept for revival.)
const DEFAULT_MODEL_TIER = "pro";

const stmts = {
  user: db.prepare("SELECT id, status, balance_usd FROM users WHERE id = ?"),
};

function getTopupById(topupId) {
  return topupsById.get(topupId) || null;
}

function getTopupByProductId(productId) {
  return topupsByProduct.get(productId) || null;
}

/** Dodo product id for a top-up in the active environment, or null. */
function getProductId(topupId) {
  const topup = topupsById.get(topupId);
  return topup?.products?.[environment] || null;
}

/** The catalog (the dashboard has its own mirror — dashboard/lib/plans.ts). */
function listTopups() {
  return topups;
}

function modelTier(model) {
  return model?.tier || DEFAULT_MODEL_TIER;
}

/**
 * A user's enforcement state: account status + prepaid balance.
 * A missing row returns null status (the caller's key-unlinked
 * path should already have caught it).
 */
function getUserBalance(userId) {
  const row = stmts.user.get(userId);
  return {
    userStatus: row?.status ?? null,
    balanceUsd: row?.balance_usd ?? 0,
  };
}

module.exports = {
  environment,
  listTopups,
  getTopupById,
  getTopupByProductId,
  getProductId,
  modelTier,
  getUserBalance,
  GRACE_USD,
  DEFAULT_MODEL_TIER,
};
