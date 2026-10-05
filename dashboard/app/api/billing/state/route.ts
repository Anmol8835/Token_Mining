import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/db";
import { getSessionUser, SESSION_COOKIE } from "@/lib/auth";
import { getPlanById, getProductId, listPlans } from "@/lib/plans";

// ============================================================
// Billing state for the signed-in account. Reads SQLite directly
// (pattern of /api/totals): users holds the denormalized plan
// state the proxy enforces on, subscriptions is the webhook-
// written source of truth. No Dodo API call — the page polls
// this every few seconds while a checkout is processing.
// ============================================================

export async function GET() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const sessionUser = getSessionUser(token);
  if (!sessionUser) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const user = db
    .prepare("SELECT status, plan, plan_expiry FROM users WHERE id = ?")
    .get(sessionUser.id) as
    | { status: string; plan: string; plan_expiry: number | null }
    | undefined;
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  // The plan the Subscribe button would buy: their current one (to
  // renew/extend) or the catalog default.
  const targetPlan = getPlanById(user.plan) ?? listPlans()[0] ?? null;
  const effective =
    user.status === "active" &&
    user.plan !== "none" &&
    typeof user.plan_expiry === "number" &&
    user.plan_expiry > Date.now();

  const subscription = db
    .prepare(
      `SELECT id, status, current_period_end, product_id
       FROM subscriptions WHERE user_id = ?
       ORDER BY updated_at DESC LIMIT 1`
    )
    .get(sessionUser.id) as
    | {
        id: string;
        status: string;
        current_period_end: number | null;
        product_id: string | null;
      }
    | undefined;

  // Calendar-month (UTC) spend — the same sum the proxy's quota
  // gate enforces against.
  const monthStart = new Date().toISOString().slice(0, 7) + "-01";
  const { used } = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd + classifier_cost_usd), 0) AS used
       FROM usage_daily WHERE user_id = ? AND day >= ?`
    )
    .get(sessionUser.id, monthStart) as { used: number };

  return NextResponse.json({
    ok: true,
    status: user.status, // 'active' | 'pending' | 'suspended'
    planId: user.plan,
    planExpiry: user.plan_expiry,
    effective,
    plan: targetPlan
      ? {
          id: targetPlan.id,
          name: targetPlan.name,
          priceUsd: targetPlan.priceUsd,
          monthlyQuotaUsd: targetPlan.monthlyQuotaUsd,
          tiers: targetPlan.tiers,
        }
      : null,
    subscription: subscription
      ? {
          id: subscription.id,
          status: subscription.status,
          currentPeriodEnd: subscription.current_period_end,
        }
      : null,
    usage: {
      monthStart,
      usedUsd: used,
      quotaUsd: targetPlan?.monthlyQuotaUsd ?? 0,
      unlimited: !targetPlan || targetPlan.monthlyQuotaUsd <= 0,
    },
    // False while plans.json still has REPLACE_ME product ids —
    // the page hides Subscribe and shows a config note instead.
    checkoutConfigured: !!targetPlan && !!getProductId(targetPlan.id),
  });
}
