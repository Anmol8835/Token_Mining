// ============================================================
// Dashboard preferences — user-tunable routing knobs, persisted
// outside the repo-tracked config (data/ is gitignored).
//
// Two knobs:
//   - routingMode: the default mode for auto-routing when a request
//     carries no X-Routing-Mode header (cheap|fast|balanced|quality)
//   - disabledModels: model IDs excluded from auto-routing candidates
//     (explicit model requests still work — this only shapes the
//     router's candidate pool)
// ============================================================

const fs = require("fs");
const path = require("path");

const PREFS_PATH = path.join(__dirname, "..", "data", "dashboard-prefs.json");
const VALID_MODES = ["cheap", "fast", "balanced", "quality"];

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(PREFS_PATH, "utf8"));
    return {
      routingMode: VALID_MODES.includes(raw.routingMode) ? raw.routingMode : null,
      disabledModels: Array.isArray(raw.disabledModels) ? raw.disabledModels : [],
    };
  } catch (_) {
    return { routingMode: null, disabledModels: [] };
  }
}

let state = load();

function save() {
  fs.mkdirSync(path.dirname(PREFS_PATH), { recursive: true });
  fs.writeFileSync(PREFS_PATH, JSON.stringify(state, null, 2));
}

function getRoutingMode() {
  return state.routingMode;
}

function getDisabledModels() {
  return state.disabledModels.slice();
}

function isModelEnabled(id) {
  return !state.disabledModels.includes(id);
}

function setRoutingMode(mode) {
  if (!VALID_MODES.includes(mode)) return null;
  state.routingMode = mode;
  save();
  return state.routingMode;
}

/**
 * Toggle a model in/out of the auto-routing candidate pool.
 * `availableModelIds` is the list of models that could actually serve
 * traffic; the last one of those can never be disabled.
 */
function setModelEnabled(id, enabled, availableModelIds) {
  const disabled = new Set(state.disabledModels);
  if (enabled) {
    disabled.delete(id);
  } else {
    const wouldEmpty = availableModelIds.every(
      (mid) => mid === id || disabled.has(mid)
    );
    if (wouldEmpty) {
      return { ok: false, error: "Cannot disable the last available model" };
    }
    disabled.add(id);
  }
  state.disabledModels = [...disabled];
  save();
  return { ok: true, disabledModels: state.disabledModels };
}

module.exports = {
  VALID_MODES,
  getRoutingMode,
  getDisabledModels,
  isModelEnabled,
  setRoutingMode,
  setModelEnabled,
};
