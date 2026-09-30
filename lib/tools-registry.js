// ============================================================
// ToolsRegistry — tools discovered via ToolSearch, per
// conversation family. Keyed by md5(systemText), same family
// convention as CompactionStore, so multi-turn conversations keep
// their discovered tool schemas inlined without re-fetching.
//
// TTL refreshed on read; entries expire after 60 min idle.
// ============================================================

const crypto = require("crypto");
const { extractSystemText } = require("./classifier/text-utils");

class ToolsRegistry {
  constructor({ ttlMs = 60 * 60 * 1000, maxFamilies = 500 } = {}) {
    this.ttlMs = ttlMs;
    this.maxFamilies = maxFamilies;
    this.families = new Map(); // familyKey -> { names: Set, at }
  }

  familyKey(requestBody) {
    const sysText = extractSystemText(requestBody.system);
    return crypto.createHash("md5").update(sysText).digest("hex");
  }

  _prune() {
    const now = Date.now();
    for (const [k, e] of this.families) {
      if (now - e.at > this.ttlMs) this.families.delete(k);
    }
    while (this.families.size >= this.maxFamilies) {
      const oldest = this.families.keys().next().value;
      this.families.delete(oldest);
    }
  }

  /** Names of tools already discovered for this conversation. */
  get(requestBody) {
    const e = this.families.get(this.familyKey(requestBody));
    if (!e) return new Set();
    if (Date.now() - e.at > this.ttlMs) {
      this.families.delete(this.familyKey(requestBody));
      return new Set();
    }
    e.at = Date.now(); // touch — reads refresh, like a cache
    return new Set(e.names);
  }

  /** Record a discovered tool so future turns inline it. */
  record(requestBody, toolName) {
    const key = this.familyKey(requestBody);
    const e = this.families.get(key);
    if (e) {
      e.names.add(toolName);
      e.at = Date.now();
      return;
    }
    this._prune();
    this.families.set(key, { names: new Set([toolName]), at: Date.now() });
  }
}

// Singleton for the server process.
module.exports = new ToolsRegistry();
