"use client";

import { useState } from "react";
import { CheckCircle, WarningCircle } from "@phosphor-icons/react";
import type { DashboardConfig, MetricsSnapshot } from "@/app/lib/api";
import { postJson } from "@/app/lib/api";
import { usePoll } from "@/app/lib/use-poll";
import { fmtInt } from "@/app/lib/format";
import { BarList } from "@/app/components/bar-list";
import { ChartPanel } from "@/app/components/chart-panel";
import { DataTable } from "@/app/components/data-table";
import { Badge, Panel } from "@/app/components/ui";
import { RoutingSkeleton } from "@/app/components/skeletons";

// Weight remaps from lib/router.js MODE_WEIGHTS.
const MODES = [
  {
    value: "cheap",
    label: "Cost",
    quality: 35,
    cost: 65,
    body: "Favor the cheapest model that meets the request's requirements. The server's default.",
  },
  {
    value: "fast",
    label: "Fast",
    quality: 40,
    cost: 60,
    body: "Cost-first with a small bias toward low-latency tiers.",
  },
  {
    value: "balanced",
    label: "Balanced",
    quality: 60,
    cost: 40,
    body: "Split the difference: quality leads slightly, cost still matters.",
  },
  {
    value: "quality",
    label: "Quality",
    quality: 85,
    cost: 15,
    body: "Send most traffic to the strongest model, cost nearly ignored.",
  },
];

export default function RoutingPage() {
  const { data: cfg } = usePoll<DashboardConfig>("/api/server/config/dashboard", 5000);
  const { data: metrics } = usePoll<MetricsSnapshot>("/api/server/metrics", 5000);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Optimistic mode: highlight the pick instantly, clear it once the
  // next config poll reports the same value. Pruned during render
  // (React's state-adjustment-on-prop-change pattern), not in an effect.
  const serverMode = cfg?.prefs.routingMode ?? null;
  const [localMode, setLocalMode] = useState<string | null>(null);
  const [prevServerMode, setPrevServerMode] = useState(serverMode);
  if (serverMode !== prevServerMode) {
    setPrevServerMode(serverMode);
    if (localMode && localMode === serverMode) setLocalMode(null);
  }

  const current = localMode ?? serverMode;

  async function select(mode: string) {
    setPending(mode);
    setLocalMode(mode);
    setError(null);
    try {
      await postJson("/api/server/config/routing", { mode });
    } catch (err) {
      setLocalMode(null);
      setError(err instanceof Error ? err.message : "failed to set mode");
    } finally {
      setPending(null);
    }
  }

  const scoreRows = (metrics?.candidateScores ?? []).map((s) => ({
    key: s.model,
    label: s.model,
    value: s.avgScore,
  }));

  const policyRules = cfg?.policy?.rules ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Routing preference</h1>
        <p className="mt-0.5 text-[13px] text-ink-3">
          The default cost vs quality tradeoff for auto-routed requests. Applies when a request
          carries no X-Routing-Mode header.
        </p>
      </div>

      {!cfg ? (
        <RoutingSkeleton />
      ) : (
        <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" role="radiogroup" aria-label="Routing mode">
        {MODES.map((mode) => {
          const selected = current === mode.value;
          const busy = pending === mode.value;
          return (
            <button
              key={mode.value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={busy}
              onClick={() => select(mode.value)}
              className={`hover-lift flex flex-col gap-2 rounded-xl border p-4 text-left transition-colors ${
                selected
                  ? "border-accent bg-surface"
                  : "border-hairline bg-surface hover:border-line"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-[15px] font-semibold text-ink">{mode.label}</span>
                {selected && <CheckCircle size={18} weight="fill" className="text-accent" aria-label="selected" />}
              </div>
              <span className="text-xs text-ink-3">
                quality {mode.quality} / cost {mode.cost}
              </span>
              <span className="text-[13px] leading-relaxed text-ink-2">{mode.body}</span>
            </button>
          );
        })}
      </div>

      {error && (
        <p className="flex items-start gap-1.5 rounded-lg bg-critical/10 px-3 py-2 text-[13px] text-critical">
          <WarningCircle size={15} weight="bold" className="mt-0.5 shrink-0" />
          {error}
        </p>
      )}

      <Panel title="Effective default">
        <p className="text-[13px] leading-relaxed text-ink-2">
          {current ? (
            <>
              The router currently defaults to{" "}
              <Badge tone="accent">{MODES.find((x) => x.value === current)?.label ?? current}</Badge>{" "}
              when no header is present. A request header always wins, and the classifier can still
              push individual requests up or down: a prompt that reads as quality-first gets the
              quality mode regardless of this setting, and human-review recommendations always
              escalate.
            </>
          ) : (
            "No preference saved yet. The server defaults to cost mode until you pick one here."
          )}
        </p>
      </Panel>

      <Panel title="Router policy" note="config/router-policy.json">
        {policyRules.length === 0 ? (
          <p className="text-[13px] text-ink-3">
            No policy rules. The benchmark pipeline (benchmark/fit-policy.js) can emit
            cost-tier floors per task and complexity; until then only the mode and the
            classifier shape routing.
          </p>
        ) : (
          <DataTable
            columns={[
              {
                key: "if",
                label: "Matches",
                render: (r: Record<string, unknown>) => JSON.stringify(r.if ?? {}),
              },
              {
                key: "tier",
                label: "Minimum tier",
                render: (r: Record<string, unknown>) => String(r.minCostTier),
              },
            ]}
            rows={policyRules as Record<string, unknown>[]}
            rowKey={(r) => JSON.stringify(r)}
          />
        )}
      </Panel>

      <ChartPanel
        title="Model score averages"
        note="session, from router candidates"
        table={
          <DataTable
            columns={[
              { key: "m", label: "Model", render: (r) => r.label },
              { key: "s", label: "Avg score", align: "right", render: (r) => r.value.toFixed(3) },
            ]}
            rows={scoreRows}
            rowKey={(r) => r.key}
          />
        }
      >
        <BarList rows={scoreRows} formatValue={(v) => v.toFixed(3)} max={1} />
      </ChartPanel>

      <p className="text-xs text-ink-3">
        Candidate scores come from the quality and cost weighting the router applies per mode.
        Averages cover{" "}
        {fmtInt(metrics?.candidateScores.reduce((s, x) => s + x.scored, 0))} scoring runs this
        session.
      </p>
        </>
      )}
    </div>
  );
}
