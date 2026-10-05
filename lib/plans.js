// ============================================================
// Plans — the enforcement side of Dodo Payments subscriptions.
//
// config/plans.json is the catalog (plan id -> price, monthly
// quota in USD, allowed model tiers, and the per-environment
// Dodo product ids). Model tiers live in config/models.json
// (`tier`: "cheap" | "pro"; untagged models fail closed to pro).
//
// The hot path is requireActivePlan in index.js: it calls
// getUserPlanState(userId) — one indexed row read on users (the
// webhook handler denormalizes plan/plan_expiry there) — plus
// one SUM over at most 31 usage_daily rows. No caching: the
// values change on webhook events and a cache would only stale
// cancellations. Both queries are prepared once, better-sqlite3
// sync reads are microseconds.
//
// Queue: monthly quota is calendar-month UTC spend (cost_usd +
// classifier_cost_usd, matching the dashboard's totals). metrics
// flushes usage_daily on a 30s gate, so enforcement can overshoot
// by up to ~30s of traffic — accepted.
// ============================================================

const fs = require("fs");
const path = require("path");
const db = require("./db");

const PLANS_PATH = path.join(__dirname, "..", "config", "plans.json");

let plans = [];
try {
  plans = JSON.parse(fs.readFileSync(PLANS_PATH, "utf8")).plans || [];
} catch (err) {
  console.error(`[plans] failed to load ${PLANS_PATH}: ${err.message}`);
  process.exit(1);
}

// Dodo test and live product ids differ; the active set is chosen
// by the same env var the dashboard's Dodo client uses.
const environment =
  process.env.DODO_PAYMENTS_ENVIRONMENT === "test_mode" ? "test_mode" : "live_mode";

const plansById = new Map(plans.map((p) => [p.id, p]));
const plansByProduct = new Map(
  plans.flatMap((p) => (p.products?.[environment] ? [[p.products[environment], p]] : []))
);

// Untagged models are treated as pro: a cheap plan must never be
// able to reach a model the catalog forgot to tag.
const DEFAULT_MODEL_TIER = "pro";

const stmts = {
  user: db.prepare("SELECT id, status, plan, plan_expiry FROM users WHERE id = ?"),
  quota: db.prepare(
    `SELECT COALESCE(SUM(cost_usd + classifier_cost_usd), 0) AS used
       FROM usage_daily WHERE user_id = ? AND day >= ?`
  ),
};

function getPlanById(planId) {
  return plansById.get(planId) || null;
}

function getPlanByProductId(productId) {
  return plansByProduct.get(productId) || null;
}

/** Dodo product id for a plan in the active environment, or null. */
function getProductId(planId) {
  const plan = plansById.get(planId);
  return plan?.products?.[environment] || null;
}

/** The catalog (for the dashboard's mirror is separate — this is the proxy's copy). */
function listPlans() {
  return plans;
}

function modelTier(model) {
  return model?.tier || DEFAULT_MODEL_TIER;
}

/**
 * Resolve a user's enforcement state. `effectivePlan` is the plan
 * config iff the account is active, has a non-'none' plan, and the
 * period hasn't lapsed — null otherwise (cancelled subscriptions
 * keep access until plan_expiry; failed/expired ones have it
 * shortened by the webhook handler).
 */
function getUserPlanState(userId) {
  const row = stmts.user.get(userId);
  const state = {
    userStatus: row?.status ?? null,
    planId: row?.plan ?? "none",
    planExpiry: row?.plan_expiry ?? null,
    plan: row ? plansById.get(row.plan) || null : null,
    effectivePlan: null,
  };
  if (
    row &&
    row.status === "active" &&
    row.plan !== "none" &&
    typeof row.plan_expiry === "number" &&
    row.plan_expiry > Date.now()
  ) {
    state.effectivePlan = state.plan;
  }
  return state;
}

/**
 * Calendar-month (UTC) quota check for a plan. Returns
 * { ok, usedUsd, quotaUsd }; a 0/missing quota means unlimited.
 */
function checkQuota(userId, planId) {
  const plan = plansById.get(planId);
  const quotaUsd = plan?.monthlyQuotaUsd || 0;
  if (quotaUsd <= 0) return { ok: true, usedUsd: 0, quotaUsd: 0 };

  const monthStart = new Date().toISOString().slice(0, 7) + "-01"; // 'YYYY-MM-01' (UTC)
  const { used } = stmts.quota.get(userId, monthStart);
  return { ok: used < quotaUsd, usedUsd: used, quotaUsd };
}

module.exports = {
  environment,
  listPlans,
  getPlanById,
  getPlanByProductId,
  getProductId,
  modelTier,
  getUserPlanState,
  checkQuota,
  DEFAULT_MODEL_TIER,
};
