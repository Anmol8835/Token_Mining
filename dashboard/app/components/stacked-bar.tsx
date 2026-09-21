"use client";

import { useState } from "react";

export type StackSegment = { key: string; label: string; value: number; color: string };

/**
 * Horizontal stacked bar: the part-to-whole form for a handful of
 * categories. Segments take categorical slots in fixed order with a
 * 2px surface gap between them; the legend always carries identity
 * (with values), direct labels sit inside segments only when they fit.
 */
export function StackedBar({ segments, height = 22 }: { segments: StackSegment[]; height?: number }) {
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const total = segments.reduce((s, x) => s + x.value, 0);

  if (total === 0 || segments.length === 0) {
    return <p className="py-6 text-center text-sm text-ink-3">No routed requests in this session yet.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div
        role="img"
        aria-label={`Routing mode split: ${segments.map((s) => `${s.label} ${s.value}`).join(", ")}`}
        className="flex w-full overflow-hidden rounded-md"
        style={{ height, gap: 2, backgroundColor: "var(--surface-2)" }}
        onMouseLeave={() => setHoverKey(null)}
      >
        {segments.map((s) => {
          const pct = (s.value / total) * 100;
          return (
            <div
              key={s.key}
              role="button"
              tabIndex={0}
              aria-label={`${s.label}: ${s.value} (${pct.toFixed(0)}%)`}
              onMouseEnter={() => setHoverKey(s.key)}
              onFocus={() => setHoverKey(s.key)}
              style={{
                width: `${pct}%`,
                backgroundColor: s.color,
                opacity: hoverKey && hoverKey !== s.key ? 0.55 : 1,
              }}
              className="h-full rounded-sm transition-opacity duration-150"
            />
          );
        })}
      </div>
      <ul className="flex flex-wrap gap-x-6 gap-y-2">
        {segments.map((s) => (
          <li key={s.key} className="flex items-center gap-2 text-[13px]">
            <span
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: s.color }}
              aria-hidden="true"
            />
            <span className="text-ink-2">{s.label}</span>
            <span className="font-medium tnum text-ink">{s.value}</span>
            <span className="tnum text-ink-3">{((s.value / total) * 100).toFixed(0)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
