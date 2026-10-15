import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/db";
import { getSessionUser, SESSION_COOKIE } from "@/lib/auth";
import { GRACE_USD, getProductId, listTopups } from "@/lib/plans";

// ============================================================
// Billing state for the signed-in account. Reads SQLite directly
// (pattern of /api/totals): users.balance_usd is the prepaid
// credit the proxy's webhook handler writes and the metrics
// flush debits. No Dodo API call — the page polls this every
// few seconds while a checkout is processing.
// ============================================================

export async function GET() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const sessionUser = getSessionUser(token);
  if (!sessionUser) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const user = db
    .prepare("SELECT status, balance_usd FROM users WHERE id = ?")
    .get(sessionUser.id) as
    | { status: string; balance_usd: number }
    | undefined;
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  // Last credited top-up, parsed from the stored webhook payload —
  // the page shows it as confirmation while the balance poll
  // catches up.
  const lastEvent = db
    .prepare(
      `SELECT payload, created_at FROM payment_events
        WHERE type = 'payment.succeeded' AND user_id = ? AND processed = 1
        ORDER BY created_at DESC LIMIT 1`
    )
    .get(sessionUser.id) as { payload: string; created_at: number } | undefined;
  let lastTopup: { amountUsd: number; at: number } | null = null;
  if (lastEvent) {
    try {
      const data = JSON.parse(lastEvent.payload)?.data;
      // Pre-tax amount — the same base the proxy credits
      // (total_amount minus tax, which Dodo collects for the tax
      // authority).
      const cents =
        (data?.total_amount ?? 0) - (typeof data?.tax === "number" ? data.tax : 0);
      if (typeof cents === "number" && cents > 0) {
        lastTopup = { amountUsd: cents / 100, at: lastEvent.created_at };
      }
    } catch {
      /* malformed payload — leave lastTopup null */
    }
  }

  const topups = listTopups().map((t) => ({
    id: t.id,
    name: t.name,
    amountUsd: t.amountUsd,
    configured: !!getProductId(t.id),
  }));

  return NextResponse.json({
    ok: true,
    status: user.status, // 'active' | 'pending' | 'suspended'
    balanceUsd: Math.round(user.balance_usd * 10000) / 10000,
    graceUsd: GRACE_USD,
    topups,
    // False while plans.json still has REPLACE_ME product ids —
    // the page hides checkout and shows a config note instead.
    checkoutConfigured: topups.some((t) => t.configured),
    lastTopup,
  });
}
