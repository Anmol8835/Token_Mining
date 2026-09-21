"use client";

import { useMemo, useState } from "react";
import type { Baseline } from "@/app/lib/api";
import { fmtUsd } from "@/app/lib/format";

/**
 * Cost vs fixed-model baselines. Two series per group: the baseline's
 * hypothetical cost (de-emphasis gray, context) and the router's actual
 * spend (accent, the point). Column caps carry the values directly;
 * group sublabels carry the savings. Emphasis, not categorical: the
 * story is one number per group, the gray bar is context.
 */
export function GroupedBars({ baselines }: { baselines: Baseline[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const max = useMemo(
    () => Math.max(...baselines.map((b) => Math.max(b.hypotheticalCost, b.actualCost)), 1),
    [baselines]
  );

  if (baselines.length === 0) {
    return <p className="py-6 text-center text-sm text-ink-3">No cost data yet.</p>;
  }

  const rowH = 196;

  return (
    <div className="flex flex-col gap-1">
      {baselines.map((b, i) => {
        const hypoH = Math.max(4, (b.hypotheticalCost / max) * rowH);
        const actualH = Math.max(4, (b.actualCost / max) * rowH);
        return (
          <div key={b.modelId} className="flex flex-col gap-1.5">
            <div
              className="flex items-end justify-center gap-2.5"
              style={{ height: rowH + 4 }}
              onMouseLeave={() => setHoverIdx(null)}
            >
              <div
                className="flex flex-col items-center"
                onMouseEnter={() => setHoverIdx(i)}
                role="img"
                aria-label={`${b.label}: hypothetical ${fmtUsd(b.hypotheticalCost)} vs actual ${fmtUsd(b.actualCost)}`}
              >
                <span className="mb-1 text-[11px] font-medium tnum text-ink-2">
                  {fmtUsd(b.hypotheticalCost, { compact: true })}
                </span>
                <span
                  className="w-[26px] rounded-t-md"
                  style={{
                    height: hypoH,
                    backgroundColor: "var(--ink-3)",
                    opacity: hoverIdx === i ? 0.9 : 0.6,
                  }}
                />
              </div>
              <div className="flex flex-col items-center" onMouseEnter={() => setHoverIdx(i)}>
                <span className="mb-1 text-[11px] font-semibold tnum text-ink">
                  {fmtUsd(b.actualCost, { compact: true })}
                </span>
                <span
                  className="w-[26px] rounded-t-md bg-accent"
                  style={{ height: actualH, opacity: hoverIdx === i ? 1 : 0.95 }}
                />
              </div>
            </div>
            <div className="flex flex-col items-center gap-0.5 pb-2 text-[13px]">
              <span className="text-ink-2">{b.label}</span>
              <span className="text-xs tnum text-ink-3">
                saved {fmtUsd(b.savedUsd)} {b.savedPct != null && `(${b.savedPct.toFixed(1)}%)`}
              </span>
            </div>
          </div>
        );
      })}
      <p className="mt-1 flex items-center gap-4 text-xs text-ink-3">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-accent" aria-hidden="true" />
          actual spend
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-ink-3/60" aria-hidden="true" />
          same traffic on that model
        </span>
      </p>
    </div>
  );
}
