// ============================================================
// Per-user dashboard preferences — each account's own auto-routing
// knobs, stored in the shared SQLite (user_prefs; one row per user,
// missing row = all defaults). Operator-wide prefs live separately
// in lib/prefs.js (data/dashboard-prefs.json) and ALWAYS apply:
//
//   - effective routing mode (auto-routing, no explicit model):
//       X-Routing-Mode header  ->  user's routing_mode
//       ->  operator's global mode  ->  "cheap"
//   - effective excluded models = union(operator disabledModels,
//     this user's disabledModels). Enabling a model the operator
//     has disabled is a silent no-op from a user account — the
//     model is simply not in their available set.
//   - explicit model requests bypass ALL prefs (they only face the
//     plan tier gate) — the prefs shape the auto-routing pool only.
//
// The dashboard's models/routing pages read + write these via
// index.js when the actor is a scoped user (cookie session). The
// classifier mode is server-wide and stays operator-only.
// ============================================================

const db = require("./db");
const { VALID_MODES } = require("./prefs");

const selectRow = db.prepare("SELECT routing_mode, disabled_models FROM user_prefs WHERE user_id = ?");

// Column-scoped upserts: a routing write must never clobber the
// disabled list (and vice versa), so each statement updates only
// its own column on conflict.
const upsertRoutingStmt = db.prepare(
  `INSERT INTO user_prefs (user_id, routing_mode, disabled_models, updated_at)
   VALUES (@userId, @mode, '[]', @now)
   ON CONFLICT(user_id) DO UPDATE SET routing_mode = @mode, updated_at = @now`
);
const upsertDisabledStmt = db.prepare(
  `INSERT INTO user_prefs (user_id, routing_mode, disabled_models, updated_at)
   VALUES (@userId, NULL, @disabled, @now)
   ON CONFLICT(user_id) DO UPDATE SET disabled_models = @disabled, updated_at = @now`
);

/** One-row read; absent/garbled row degrades to defaults. */
function get(userId) {
  const row = selectRow.get(userId);
  if (!row) return { routingMode: null, disabledModels: [] };
  let disabledModels = [];
  try {
    const parsed = JSON.parse(row.disabled_models);
    if (Array.isArray(parsed)) disabledModels = parsed.filter((id) => typeof id === "string");
  } catch (_) {
    // Falls back to [] — a garbled list must not lock a user out.
  }
  return {
    routingMode: VALID_MODES.includes(row.routing_mode) ? row.routing_mode : null,
    disabledModels,
  };
}

/** Stored mode, or null when the user inherits the global mode. */
function getRoutingMode(userId) {
  return get(userId).routingMode;
}

/** The user's own exclusions (NOT unioned with the operator's). */
function getDisabledModels(userId) {
  return get(userId).disabledModels;
}

function setRoutingMode(userId, mode) {
  if (!VALID_MODES.includes(mode)) return null;
  upsertRoutingStmt.run({ userId, mode, now: Date.now() });
  return mode;
}

/**
 * Toggle a model in/out of THIS user's auto-routing pool.
 * `userAvailableIds` is the set of models that could actually serve
 * this user's auto-routed traffic (registry models minus the
 * operator's global exclusions); the last one of those can never
 * be disabled. Enabling a model the operator disabled is a no-op
 * that still reports ok — the caller's UI locks it via
 * adminDisabledModels.
 */
function setModelEnabled(userId, id, enabled, userAvailableIds) {
  const current = new Set(get(userId).disabledModels);
  if (enabled) {
    if (!current.has(id)) return { ok: true, disabledModels: [...current] };
    current.delete(id);
  } else {
    if (current.has(id)) return { ok: true, disabledModels: [...current] };
    const wouldEmpty = userAvailableIds.every((mid) => mid === id || current.has(mid));
    if (wouldEmpty) {
      return { ok: false, error: "Cannot disable the last available model" };
    }
    current.add(id);
  }
  const disabledModels = [...current];
  upsertDisabledStmt.run({ userId, disabled: JSON.stringify(disabledModels), now: Date.now() });
  return { ok: true, disabledModels };
}

module.exports = {
  get,
  getRoutingMode,
  getDisabledModels,
  setRoutingMode,
  setModelEnabled,
};
