import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/db";
import { getSessionUser, SESSION_COOKIE } from "@/lib/auth";

// ============================================================
// The logged-in account's durable usage totals, read straight
// from usage_daily (written by the proxy's 30s persist tick).
// Totals + a 30-day daily series for the savings chart.
// saved = baseline hypothetical − (provider + classifier spend).
// ============================================================

const DAY_MS = 24 * 60 * 60 * 1000;
const SERIES_DAYS = 30;

type DailyRow = {
  day: string;
  requests: number;
  cost_usd: number;
  classifier_cost_usd: number;
  baseline_cost_usd: number;
};

export async function GET() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const user = getSessionUser(token);
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const totals = getDb()
    .prepare(
      `SELECT
         COALESCE(SUM(requests), 0)            AS requests,
         COALESCE(SUM(input_tokens), 0)        AS inputTokens,
         COALESCE(SUM(output_tokens), 0)       AS outputTokens,
         COALESCE(SUM(cache_read_tokens), 0)   AS cacheReadTokens,
         COALESCE(SUM(cache_write_tokens), 0)  AS cacheWriteTokens,
         COALESCE(SUM(cost_usd), 0)            AS costUsd,
         COALESCE(SUM(classifier_cost_usd), 0) AS classifierCostUsd,
         COALESCE(SUM(baseline_cost_usd), 0)   AS baselineCostUsd
       FROM usage_daily WHERE user_id = ?`
    )
    .get(user.id) as Record<string, number>;

  const actualCostUsd = totals.costUsd + totals.classifierCostUsd;
  const savedUsd = totals.baselineCostUsd - actualCostUsd;

  // Last 30 days, gaps filled with zeros so the chart axis is clean.
  const cutoff = new Date(Date.now() - (SERIES_DAYS - 1) * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const rows = getDb()
    .prepare(
      `SELECT day, requests, cost_usd, classifier_cost_usd, baseline_cost_usd
       FROM usage_daily
       WHERE user_id = ? AND day >= ?
       ORDER BY day ASC`
    )
    .all(user.id, cutoff) as DailyRow[];
  const byDay = new Map(rows.map((r) => [r.day, r]));

  const daily = [] as {
    day: string;
    requests: number;
    costUsd: number;
    savedUsd: number;
  }[];
  for (let i = SERIES_DAYS - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * DAY_MS).toISOString().slice(0, 10);
    const r = byDay.get(day);
    const cost = r ? r.cost_usd + r.classifier_cost_usd : 0;
    daily.push({
      day,
      requests: r?.requests ?? 0,
      costUsd: cost,
      savedUsd: r ? r.baseline_cost_usd - cost : 0,
    });
  }

  return NextResponse.json({
    ok: true,
    user,
    totals: {
      requests: totals.requests,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens,
      costUsd: totals.costUsd,
      classifierCostUsd: totals.classifierCostUsd,
      baselineCostUsd: totals.baselineCostUsd,
      actualCostUsd,
      savedUsd,
      savedPct:
        totals.baselineCostUsd > 0
          ? (savedUsd / totals.baselineCostUsd) * 100
          : null,
    },
    daily,
  });
}
