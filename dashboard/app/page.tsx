"use client";

import { useMemo, useState } from "react";
import type { Baseline, DashboardConfig, MetricsSnapshot, RecordRow } from "@/app/lib/api";
import { postJson } from "@/app/lib/api";
import { usePoll } from "@/app/lib/use-poll";
import { bucketByTime } from "@/app/lib/charts";
import { fmtClock, fmtCompact, fmtDateTime, fmtInt, fmtPct, fmtUsd } from "@/app/lib/format";
import { LineChart } from "@/app/components/line-chart";
import { BarList, type BarRow } from "@/app/components/bar-list";
import { StackedBar, type StackSegment } from "@/app/components/stacked-bar";
import { GroupedBars } from "@/app/components/grouped-bars";
import { ChartPanel } from "@/app/components/chart-panel";
import { DataTable, type Column } from "@/app/components/data-table";
import { StatTile } from "@/app/components/stat-tile";
import { Button, EmptyState, Panel, Segmented, Badge } from "@/app/components/ui";
import { OverviewSkeleton } from "@/app/components/skeletons";

const MODE_LABEL: Record<string, string> = {
  cheap: "Cost",
  fast: "Fast",
  balanced: "Balanced",
  quality: "Quality",
};
const MODE_COLOR: Record<string, string> = {
  cheap: "var(--series-1)",
  fast: "var(--series-2)",
  balanced: "var(--series-3)",
  quality: "var(--series-4)",
};
const MODE_ORDER = ["cheap", "fast", "balanced", "quality"];

const recentColumns: Column<RecordRow>[] = [
  { key: "ts", label: "Time", mono: true, render: (r) => fmtClock(r.ts) },
  { key: "prompt", label: "Prompt", render: (r) => <span className="block max-w-64 truncate">{r.prompt || "-"}</span> },
  { key: "task", label: "Task", render: (r) => r.primary_task ?? "-" },
  { key: "model", label: "Model", render: (r) => r.selectedModel ?? "-" },
  { key: "conf", label: "Conf", align: "right", render: (r) => (r.confidence != null ? `${(r.confidence * 100).toFixed(0)}%` : "-") },
  { key: "classMs", label: "Classify", align: "right", render: (r) => (r.classifierMs != null ? `${r.classifierMs}ms` : "-") },
  { key: "provMs", label: "Provider", align: "right", render: (r) => (r.providerMs != null ? `${r.providerMs}ms` : "-") },
  { key: "tokens", label: "Tokens", align: "right", render: (r) => fmtInt(r.tokens) },
  { key: "cost", label: "Cost", align: "right", render: (r) => fmtUsd(r.costUsd) },
  { key: "ok", label: "Status", render: (r) => (r.ok == null ? "-" : r.ok ? <Badge tone="good">ok</Badge> : <Badge tone="critical">failed</Badge>) },
];

export default function Overview() {
  const [scope, setScope] = useState<"session" | "all">("session");
  const [busy, setBusy] = useState<string | null>(null);

  const { data: m, stale } = usePoll<MetricsSnapshot>("/api/server/metrics", 3000);
  const { data: cfg } = usePoll<DashboardConfig>("/api/server/config/dashboard", 10000);

  const records = useMemo(() => m?.allRecords ?? [], [m]);
  const timeBins = useMemo(() => bucketByTime(records, 24), [records]);
  const requestsSpark = useMemo(() => bucketByTime(records, 12).map((b) => b.value), [records]);
  const tokensSpark = useMemo(() => {
    const sorted = [...records].sort((a, b) => a.ts - b.ts);
    return sorted.map((r) => r.tokens ?? 0).slice(-12);
  }, [records]);
  const costSpark = useMemo(() => {
    const sorted = [...records].sort((a, b) => a.ts - b.ts);
    const costs = sorted.map((r) => r.costUsd ?? 0).slice(-12);
    return costs.map((_, i) => costs.slice(0, i + 1).reduce((s, c) => s + c, 0));
  }, [records]);
  const latencySpark = useMemo(() => {
    const sorted = [...records].sort((a, b) => a.ts - b.ts);
    return sorted.map((r) => r.providerMs ?? 0).slice(-12);
  }, [records]);

  const isAll = scope === "all";
  const hero = useMemo(() => {
    if (!m) return null;
    const baselines = isAll ? m.global.baselines : m.costBaselines;
    return baselines.find((b) => b.modelId === "claude-opus-4-8") ?? baselines[0] ?? null;
  }, [m, isAll]);

  const hasTraffic = (isAll ? m?.global.requests : m?.counts.requests) || 0;

  const modeSegments: StackSegment[] = useMemo(() => {
    if (!m) return [];
    return MODE_ORDER.map((mode) => ({
      key: mode,
      label: MODE_LABEL[mode],
      value: m.byMode.find((x) => x.key === mode)?.value ?? 0,
      color: MODE_COLOR[mode],
    })).filter((s) => s.value > 0);
  }, [m]);

  const byModelRows: BarRow[] = useMemo(
    () =>
      (m?.byModel ?? []).map((x) => ({
        key: x.key,
        label: x.key,
        value: x.count ?? 0,
      })),
    [m]
  );
  const byModelCostRows: BarRow[] = useMemo(
    () =>
      (m?.byModel ?? [])
        .map((x) => ({ key: x.key, label: x.key, value: x.costUsd ?? 0 }))
        .sort((a, b) => b.value - a.value),
    [m]
  );
  const byTaskRows: BarRow[] = useMemo(
    () =>
      (m?.byTask ?? []).map((x) => ({
        key: x.key,
        label: (x.key || "unlabeled").replace(/_/g, " "),
        value: x.value ?? 0,
      })),
    [m]
  );
  const byRiskRows: BarRow[] = useMemo(
    () =>
      (m?.byRisk ?? []).map((x) => ({
        key: x.key,
        label: x.key || "unknown",
        value: x.value ?? 0,
      })),
    [m]
  );

  async function runAction(kind: "demo" | "reset") {
    setBusy(kind);
    try {
      await postJson(`/api/server/metrics/${kind}`, {});
    } catch {
      /* error surfaces via stale indicator */
    } finally {
      setBusy(null);
    }
  }

  const baselines: Baseline[] = isAll ? (m?.global.baselines ?? []) : (m?.costBaselines ?? []);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">Overview</h1>
          <p className="mt-0.5 text-[13px] text-ink-3">
            Cost, tokens and routing for the LLM router.
            {stale && " Last fetch failed, showing cached values."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            ariaLabel="Stat scope"
            options={[
              { value: "session", label: "Session" },
              { value: "all", label: "All-time" },
            ]}
            value={scope}
            onChange={setScope}
          />
          <Button onClick={() => runAction("demo")} pending={busy === "demo"}>
            Generate demo traffic
          </Button>
          <Button onClick={() => runAction("reset")} pending={busy === "reset"}>
            Reset session
          </Button>
        </div>
      </div>

      {!m ? (
        <OverviewSkeleton />
      ) : (
        <>
      {hasTraffic === 0 && isAll ? (
        <EmptyState
          title="No all-time usage recorded yet"
          body="Traffic through the router accumulates in data/usage-stats.json. Demo traffic stays session-only, so generate some real requests to see all-time numbers."
        />
      ) : hasTraffic === 0 && (
        <EmptyState
          title="No traffic this session"
          body="The dashboard reads live session metrics from the router. Generate a demo burst to see every panel populate without calling any provider."
          action={<Button variant="primary" onClick={() => runAction("demo")}>Generate demo traffic</Button>}
        />
      )}

      {/* Hero: the one number this console leads with. */}
      {hero && hasTraffic > 0 && (
        <section className="rounded-xl border border-hairline bg-surface px-5 py-6 sm:px-7">
          <p className="text-[13px] text-ink-2">Cost saved vs {hero.label}</p>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="text-5xl font-semibold tracking-tight text-ink">{fmtUsd(hero.savedUsd)}</span>
            {hero.savedPct != null && (
              <Badge tone={hero.savedPct >= 0 ? "good" : "critical"}>
                {hero.savedPct >= 0 ? "saving" : "costing"} {fmtPct(Math.abs(hero.savedPct))}
              </Badge>
            )}
          </div>
          <p className="mt-2 text-xs text-ink-3">
            {isAll ? "All-time" : "This session"}, {fmtInt(hero.requests ?? 0)} requests, actual{" "}
            {fmtUsd(hero.actualCost)} vs {fmtUsd(hero.hypotheticalCost)} on a single fixed model.
          </p>
        </section>
      )}

      {/* KPI row */}
      {m && hasTraffic > 0 && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
          <StatTile
            label="Requests"
            value={fmtCompact(isAll ? m.global.requests : m.counts.requests)}
            sub={isAll ? `since ${fmtDateTime(m.global.since)}` : `${m.counts.providerFallbacks} provider fallbacks`}
            spark={isAll ? undefined : requestsSpark}
          />
          <StatTile
            label="Tokens in"
            value={fmtCompact(isAll ? m.global.inputTokens : m.totals.inputTokens)}
            sub={isAll ? "provider + classifier" : `${fmtCompact(m.totals.cacheReadTokens)} cached reads`}
            spark={isAll ? undefined : tokensSpark}
          />
          <StatTile
            label="Tokens out"
            value={fmtCompact(isAll ? m.global.outputTokens : m.totals.outputTokens)}
            sub={isAll ? "provider + classifier" : `${fmtCompact(m.totals.cacheWriteTokens)} cache writes`}
          />
          <StatTile
            label="Total cost"
            value={fmtUsd(isAll ? m.global.totalCostUsd : m.totals.totalCostUsd, { compact: true })}
            sub="providers + classifier + compaction"
            spark={isAll ? undefined : costSpark}
          />
          <StatTile
            label="Cache savings"
            value={fmtUsd(isAll ? m.global.provider.cacheSavingsUsd : m.totals.cacheSavingsUsd, { compact: true })}
            sub="vs no-caching baseline"
          />
          <StatTile
            label="Avg latency"
            value={m.averages.latencyMs > 0 ? `${Math.round(m.averages.latencyMs)}ms` : "-"}
            sub={`classifier ${Math.round(m.averages.classifierMs)}ms`}
            spark={isAll ? undefined : latencySpark}
          />
        </div>
      )}

      {/* Chart grid */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartPanel
          title="Requests over time"
          note="session"
          className="lg:col-span-2"
          table={
            <DataTable
              columns={[
                { key: "t", label: "Bucket", mono: true, render: (b) => fmtClock(b.ts) },
                { key: "v", label: "Requests", align: "right", render: (b) => fmtInt(b.value) },
              ]}
              rows={timeBins}
              rowKey={(b) => String(b.ts)}
              empty="No traffic yet."
            />
          }
        >
          <LineChart points={timeBins} formatValue={(v) => fmtInt(v)} />
        </ChartPanel>

        <ChartPanel
          title="Routing by mode"
          note="session"
          table={
            <DataTable
              columns={[
                { key: "m", label: "Mode", render: (s) => s.label },
                { key: "n", label: "Requests", align: "right", render: (s) => fmtInt(s.value) },
              ]}
              rows={modeSegments}
              rowKey={(s) => s.key}
            />
          }
        >
          <StackedBar segments={modeSegments} />
        </ChartPanel>

        <ChartPanel
          title="Cost vs fixed-model baselines"
          note={isAll ? "all-time" : "session"}
          table={
            <DataTable
              columns={[
                { key: "m", label: "Baseline", render: (b) => b.label },
                { key: "h", label: "Fixed-model cost", align: "right", render: (b) => fmtUsd(b.hypotheticalCost) },
                { key: "a", label: "Actual cost", align: "right", render: (b) => fmtUsd(b.actualCost) },
                { key: "s", label: "Saved", align: "right", render: (b) => `${fmtUsd(b.savedUsd)} (${b.savedPct != null ? fmtPct(b.savedPct) : "-"})` },
              ]}
              rows={baselines}
              rowKey={(b) => b.modelId}
            />
          }
        >
          <GroupedBars baselines={baselines} />
        </ChartPanel>

        <ChartPanel
          title="Requests by model"
          note="session"
          table={
            <DataTable
              columns={[
                { key: "m", label: "Model", render: (r) => r.label },
                { key: "n", label: "Requests", align: "right", render: (r) => fmtInt(r.value) },
              ]}
              rows={byModelRows}
              rowKey={(r) => r.key}
            />
          }
        >
          <BarList rows={byModelRows} formatValue={(v) => fmtInt(v)} />
        </ChartPanel>

        <ChartPanel
          title="Cost by model"
          note="session"
          table={
            <DataTable
              columns={[
                { key: "m", label: "Model", render: (r) => r.label },
                { key: "c", label: "Cost", align: "right", render: (r) => fmtUsd(r.value) },
              ]}
              rows={byModelCostRows}
              rowKey={(r) => r.key}
            />
          }
        >
          <BarList rows={byModelCostRows} formatValue={(v) => fmtUsd(v)} />
        </ChartPanel>

        <ChartPanel
          title="Requests by task"
          note="session"
          table={
            <DataTable
              columns={[
                { key: "t", label: "Task", render: (r) => r.label },
                { key: "n", label: "Requests", align: "right", render: (r) => fmtInt(r.value) },
              ]}
              rows={byTaskRows}
              rowKey={(r) => r.key}
            />
          }
        >
          <BarList rows={byTaskRows} formatValue={(v) => fmtInt(v)} />
        </ChartPanel>

        <ChartPanel
          title="Risk split"
          note="session"
          table={
            <DataTable
              columns={[
                { key: "t", label: "Risk", render: (r) => r.label },
                { key: "n", label: "Requests", align: "right", render: (r) => fmtInt(r.value) },
              ]}
              rows={byRiskRows}
              rowKey={(r) => r.key}
            />
          }
        >
          <BarList rows={byRiskRows} formatValue={(v) => fmtInt(v)} />
        </ChartPanel>
      </div>

      {/* Cache + compaction accounting */}
      {m && (
        <Panel title="Cache and compaction" note="session">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-[13px] sm:grid-cols-3">
            {[
              ["Cached reads", `${fmtCompact(m.totals.cacheReadTokens)} tokens`],
              ["Cache writes", `${fmtCompact(m.totals.cacheWriteTokens)} tokens`],
              ["Cache savings", fmtUsd(m.totals.cacheSavingsUsd)],
              ["Compaction runs", fmtInt(m.totals.compactionCalls)],
              ["Tokens dropped", `${fmtCompact(m.totals.compactionTokensSaved)} est.`],
              ["Compaction cost", fmtUsd(m.totals.compactionCostUsd)],
            ].map(([label, value]) => (
              <div key={label} className="flex flex-col gap-0.5">
                <dt className="text-ink-3">{label}</dt>
                <dd className="font-medium tnum text-ink">{value}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      )}

      {/* Benchmark summary from benchmark/data/report/report.json */}
      {cfg?.benchmark && (
        <Panel
          title="Router benchmark"
          note={`generated ${fmtDateTime(cfg.benchmark.generatedAt)}`}
        >
          <div className="mb-4 flex flex-wrap gap-x-8 gap-y-2 text-[13px]">
            <span className="text-ink-2">
              Cost savings vs all-flagship:{" "}
              <strong className="font-semibold tnum text-ink">
                {fmtPct(cfg.benchmark.totals.savingsVsFlagshipPct)}
              </strong>
            </span>
            <span className="text-ink-2">
              vs mid-tier:{" "}
              <strong className="font-semibold tnum text-ink">
                {fmtPct(cfg.benchmark.totals.savingsVsMiddlePct)}
              </strong>
            </span>
            <span className="text-ink-2">
              Router cost {fmtUsd(cfg.benchmark.totals.routerCost)} across{" "}
              {fmtInt(cfg.benchmark.evalPromptCount)} eval prompts
            </span>
          </div>
          <DataTable
            columns={[
              { key: "cat", label: "Category", render: (s) => s.category },
              { key: "n", label: "Prompts", align: "right", render: (s) => fmtInt(s.n) },
              { key: "q", label: "Router quality", align: "right", render: (s) => fmtPct(s.routerQuality, 0) },
              { key: "c", label: "Cost", align: "right", render: (s) => fmtUsd(s.cost) },
              { key: "e", label: "Errors", align: "right", render: (s) => fmtInt(s.errors) },
            ]}
            rows={cfg.benchmark.sections}
            rowKey={(s) => s.category}
          />
        </Panel>
      )}

      {/* Recent requests */}
      <Panel title="Recent requests" note={m ? `last ${m.recent.length} of ${fmtInt(records.length)}` : "session"}>
        <DataTable columns={recentColumns} rows={m?.recent ?? []} rowKey={(r) => String(r.ts) + (r.prompt || "")} empty="No requests yet." />
      </Panel>
        </>
      )}
    </div>
  );
}
