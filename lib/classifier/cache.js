// ============================================================
// Classification cache — keyed by system + last N message hashes
// ============================================================

const crypto = require("crypto");
const { extractSystemText, hashMessages } = require("./text-utils");

class ClassificationCache {
  /**
   * @param {number} ttlMs - Cache entry lifetime in milliseconds
   * @param {number} maxEntries - Maximum cache size before LRU eviction
   */
  constructor(ttlMs = 3600000, maxEntries = 2000) {
    this.cache = new Map();
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  /**
   * Build a cache key from the request body.
   * Uses system prompt text + hashes of last 3 messages.
   * This captures conversation drift better than first-message-only.
   */
  _hash(requestBody) {
    const sysText = extractSystemText(requestBody.system);
    const msgHashes = hashMessages(requestBody.messages, 3);
    const payload = sysText + "|" + msgHashes.join("|");
    return crypto.createHash("md5").update(payload).digest("hex");
  }

  /**
   * Retrieve a cached classification result.
   * Returns null if not found or expired.
   */
  get(requestBody) {
    const key = this._hash(requestBody);
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    // Move to end for LRU tracking (delete + re-set)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.result;
  }

  /**
   * Store a classification result in the cache.
   */
  set(requestBody, result) {
    const key = this._hash(requestBody);
    const entry = { result, timestamp: Date.now() };

    // Evict oldest entry if at capacity (LRU: first inserted = oldest)
    if (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }

    this.cache.set(key, entry);

    // Periodic TTL sweep (every 1000 inserts, sweep expired entries)
    if (this.cache.size % 1000 === 0) {
      const now = Date.now();
      for (const [k, v] of this.cache) {
        if (now - v.timestamp > this.ttlMs) this.cache.delete(k);
      }
    }
  }

  /**
   * Clear all cached entries.
   */
  clear() {
    this.cache.clear();
  }

  /**
   * Return current cache size.
   */
  get size() {
    return this.cache.size;
  }
}

module.exports = ClassificationCache;
