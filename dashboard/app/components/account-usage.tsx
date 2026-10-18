"use client";

import { useMemo } from "react";
import { usePoll } from "@/app/lib/use-poll";
import type { TotalsSnapshot } from "@/app/lib/api";
import { fmtCompact, fmtInt, fmtUsd } from "@/app/lib/format";
import { LineChart } from "@/app/components/line-chart";
import { ChartPanel } from "@/app/components/chart-panel";
import { DataTable } from "@/app/components/data-table";
import { StatTile } from "@/app/components/stat-tile";

/**
 * The logged-in account's durable usage totals — read from the
 * shared SQLite (usage_daily) via /api/totals, not from the live
 * session metrics. This is the "cost saved" store: money and
 * tokens only, no prompts. Survives restarts and resets.
 */
export function AccountUsage() {
  const { data: t } = usePoll<TotalsSnapshot>("/api/totals", 15000);

  // Cumulative savings across the 30-day window — the headline line.
  // Floored at 0 for the chart: LineChart's y-scale starts at zero,
  // so a negative dip would draw below the plot. The table below
  // keeps the true signed per-day values.
  const points = useMemo(() => {
    const out: { ts: number; value: number }[] = [];
    let acc = 0;
    for (const d of t?.daily ?? []) {
      acc += d.savedUsd;
      out.push({ ts: Date.parse(d.day + "T00:00:00Z"), value: Math.max(0, acc) });
    }
    return out;
  }, [t]);

  if (!t) return null;

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-[15px] font-semibold tracking-tight text-ink">
          Account usage
        </h2>
        <p className="mt-0.5 text-[13px] text-ink-3">
          Durable per-account totals — cost and tokens only, never prompt
          content. Written by the proxy, kept across restarts.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Cost saved"
          value={fmtUsd(t.totals.savedUsd, { compact: true })}
          sub={
            t.totals.savedPct != null
              ? `${t.totals.savedPct >= 0 ? "saving" : "costing"} ${Math.abs(t.totals.savedPct).toFixed(1)}% vs flagship baseline`
              : "vs flagship baseline"
          }
        />
        <StatTile
          label="Total cost"
          value={fmtUsd(t.totals.actualCostUsd, { compact: true })}
          sub="providers + classifier"
        />
        <StatTile
          label="Requests"
          value={fmtCompact(t.totals.requests)}
          sub={`${fmtCompact(t.totals.cacheReadTokens)} cached reads`}
        />
        <StatTile
          label="Tokens"
          value={fmtCompact(t.totals.inputTokens + t.totals.outputTokens)}
          sub={`${fmtCompact(t.totals.inputTokens)} in / ${fmtCompact(t.totals.outputTokens)} out`}
        />
      </div>

      <ChartPanel
        title="Savings over 30 days"
        note="cumulative saved vs flagship baseline"
        className="lg:col-span-2"
        table={
          <DataTable
            columns={[
              { key: "d", label: "Day", mono: true, render: (r) => r.day },
              { key: "n", label: "Requests", align: "right", render: (r) => fmtInt(r.requests) },
              { key: "c", label: "Cost", align: "right", render: (r) => fmtUsd(r.costUsd) },
              { key: "s", label: "Saved", align: "right", render: (r) => fmtUsd(r.savedUsd) },
            ]}
            rows={t.daily}
            rowKey={(r) => r.day}
          />
        }
      >
        <LineChart points={points} formatValue={(v) => fmtUsd(v)} />
      </ChartPanel>
    </section>
  );
}
