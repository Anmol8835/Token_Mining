import fs from "node:fs";
import path from "node:path";

// ============================================================
// Top-up catalog for the dashboard billing UI. Mirror of the
// proxy's lib/plans.js — the file itself is a mirror of
// config/plans.json (the dashboard build context can't reach
// ../config). Read lazily (next build collects routes without a
// guarantee about cwd contents) and cached for the process.
// ============================================================

export type TopupConfig = {
  id: string;
  name: string;
  amountUsd: number;
  products: { test_mode?: string; live_mode?: string };
};

/** Overage grace (USD) — mirrors lib/plans.js GRACE_USD. */
export const GRACE_USD = 1.0;

const PLANS_PATH = path.join(process.cwd(), "lib", "plans.json");

let _topups: TopupConfig[] | null = null;

function load(): TopupConfig[] {
  if (_topups) return _topups;
  try {
    _topups =
      (JSON.parse(fs.readFileSync(PLANS_PATH, "utf8")).topups as TopupConfig[]) || [];
  } catch (err) {
    console.warn("[plans] failed to load", PLANS_PATH, (err as Error).message);
    _topups = [];
  }
  return _topups;
}

export function listTopups(): TopupConfig[] {
  return load();
}

export function getTopupById(id: string | null | undefined): TopupConfig | null {
  if (!id) return null;
  return load().find((t) => t.id === id) || null;
}

/** Dodo product id for the active environment (test vs live), or null. */
export function getProductId(topupId: string): string | null {
  const topup = getTopupById(topupId);
  if (!topup) return null;
  const env =
    process.env.DODO_PAYMENTS_ENVIRONMENT === "test_mode" ? "test_mode" : "live_mode";
  const id = topup.products?.[env];
  // The placeholder in plans.json means "not configured yet" — treat
  // it as missing so the UI shows a config error instead of sending
  // Dodo a bogus product id.
  return id && !id.includes("REPLACE_ME") ? id : null;
}
