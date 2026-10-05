import fs from "node:fs";
import path from "node:path";

// ============================================================
// Plan catalog for the dashboard billing UI. Mirror of the
// proxy's lib/plans.js — the file itself is a mirror of
// config/plans.json (the dashboard build context can't reach
// ../config). Read lazily (next build collects routes without a
// guarantee about cwd contents) and cached for the process.
// ============================================================

export type PlanConfig = {
  id: string;
  name: string;
  priceUsd: number;
  monthlyQuotaUsd: number;
  tiers: string[];
  products: { test_mode?: string; live_mode?: string };
};

const PLANS_PATH = path.join(process.cwd(), "lib", "plans.json");

let _plans: PlanConfig[] | null = null;

function load(): PlanConfig[] {
  if (_plans) return _plans;
  try {
    _plans = (JSON.parse(fs.readFileSync(PLANS_PATH, "utf8")).plans as PlanConfig[]) || [];
  } catch (err) {
    console.warn("[plans] failed to load", PLANS_PATH, (err as Error).message);
    _plans = [];
  }
  return _plans;
}

export function listPlans(): PlanConfig[] {
  return load();
}

export function getPlanById(id: string | null | undefined): PlanConfig | null {
  if (!id) return null;
  return load().find((p) => p.id === id) || null;
}

/** Dodo product id for the active environment (test vs live), or null. */
export function getProductId(planId: string): string | null {
  const plan = getPlanById(planId);
  if (!plan) return null;
  const env =
    process.env.DODO_PAYMENTS_ENVIRONMENT === "test_mode" ? "test_mode" : "live_mode";
  const id = plan.products?.[env];
  // The placeholder in plans.json means "not configured yet" — treat
  // it as missing so the UI shows a config error instead of sending
  // Dodo a bogus product id.
  return id && !id.includes("REPLACE_ME") ? id : null;
}
