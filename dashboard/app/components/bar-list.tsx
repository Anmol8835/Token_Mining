"use client";

import { useState } from "react";

export type BarRow = { key: string; label: string; value: number; sub?: string };

/**
 * Horizontal bar list for nominal categories: one series, so every bar
 * wears the same accent (never a value ramp on unordered names). Bars
 * are thin with a rounded data-end, values ride the tips in text ink.
 * Hover reveals the share; the hit area is the whole row.
 */
export function BarList({
  rows,
  formatValue = (v: number) => String(v),
  max = 0,
}: {
  rows: BarRow[];
  formatValue?: (v: number) => string;
  max?: number;
}) {
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const top = max || Math.max(...rows.map((r) => r.value), 1);
  const total = rows.reduce((s, r) => s + r.value, 0);

  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-ink-3">No data in this session yet.</p>;
  }

  return (
    <ul className="flex flex-col gap-2.5">
      {rows.map((r) => {
        const hovered = hoverKey === r.key;
        return (
          <li
            key={r.key}
            onMouseEnter={() => setHoverKey(r.key)}
            onMouseLeave={() => setHoverKey(null)}
            className="group flex items-center gap-3"
          >
            <span className="w-36 shrink-0 truncate text-[13px] text-ink-2">{r.label}</span>
            <span className="relative h-5 min-w-0 flex-1" aria-hidden="true">
              <span
                className="absolute inset-y-0 left-0 rounded-r-md bg-accent transition-[opacity] duration-200"
                style={{ width: `${Math.max(2, (r.value / top) * 100)}%`, opacity: hovered ? 1 : 0.9 }}
              />
            </span>
            <span className="w-20 shrink-0 text-right text-[13px] font-medium tnum text-ink">
              {formatValue(r.value)}
            </span>
            <span className="w-14 shrink-0 text-right text-xs tnum text-ink-3">
              {total > 0 ? `${((r.value / total) * 100).toFixed(0)}%` : "-"}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
