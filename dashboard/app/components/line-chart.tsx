"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Point } from "@/app/lib/charts";
import { linearScale, niceTicks } from "@/app/lib/charts";
import { fmtClock } from "@/app/lib/format";

/**
 * Single-series time line. Mark specs: 2px round line, 10% area wash,
 * 8px end-dot with a 2px surface ring, hairline solid gridlines, clean
 * y ticks. Crosshair snaps to the nearest bucket and one tooltip lists
 * the value there (a single series needs no legend: the panel title
 * names it).
 */
export function LineChart({
  points,
  formatValue = (v: number) => String(v),
  height = 220,
}: {
  points: Point[];
  formatValue?: (v: number) => string;
  height?: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? el.clientWidth;
      setWidth(w);
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const pad = useMemo(
    () => ({ top: 12, right: 14, bottom: 28, left: 48 }),
    []
  );

  const ready = points.length >= 2 && width > 0;
  const max = points.length > 0 ? Math.max(...points.map((p) => p.value), 1) : 1;
  const ticks = niceTicks(max);
  const yMax = ticks[ticks.length - 1];
  const plotW = Math.max(0, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;
  const first = points[0]?.ts ?? 0;
  const last = points[points.length - 1]?.ts ?? first + 1;
  const xScale = linearScale([first, last], [pad.left, pad.left + plotW]);
  const yScale = linearScale([0, yMax], [pad.top + plotH, pad.top]);

  const linePath = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${xScale(p.ts).toFixed(1)},${yScale(p.value).toFixed(1)}`)
    .join(" ");
  const areaPath = ready
    ? `${linePath} L${xScale(points[points.length - 1].ts).toFixed(1)},${(pad.top + plotH).toFixed(1)} L${xScale(points[0].ts).toFixed(1)},${(pad.top + plotH).toFixed(1)} Z`
    : "";

  const xTickCount = 4;
  const xTicks = Array.from({ length: xTickCount + 1 }, (_, i) =>
    points[Math.round((i / xTickCount) * (points.length - 1))]
  );

  const hover = hoverIdx != null && points[hoverIdx] ? points[hoverIdx] : null;
  const tooltipFlip = hover && xScale(hover.ts) > width - 140;

  function onMove(e: React.MouseEvent<SVGElement>) {
    if (!ready) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const t = (px - pad.left) / plotW;
    const idx = Math.round(t * (points.length - 1));
    setHoverIdx(Math.max(0, Math.min(points.length - 1, idx)));
  }

  return (
    <div ref={wrapRef} className="relative w-full" style={{ height }}>
      {ready && (
        <>
          <svg
            width={width}
            height={height}
            role="img"
            aria-label="Requests over the session"
            onMouseMove={onMove}
            onMouseLeave={() => setHoverIdx(null)}
            className="block"
          >
            {ticks.map((t) => (
              <g key={t}>
                <line
                  x1={pad.left}
                  x2={width - pad.right}
                  y1={yScale(t)}
                  y2={yScale(t)}
                  stroke="var(--line)"
                  strokeWidth="1"
                />
                <text
                  x={pad.left - 8}
                  y={yScale(t) + 3.5}
                  textAnchor="end"
                  fontSize="11"
                  fill="var(--ink-3)"
                  className="tnum"
                >
                  {formatValue(t)}
                </text>
              </g>
            ))}
            <line
              x1={pad.left}
              x2={width - pad.right}
              y1={pad.top + plotH}
              y2={pad.top + plotH}
              stroke="var(--baseline)"
              strokeWidth="1"
            />
            {xTicks.map((p) => (
              <text
                key={p.ts}
                x={xScale(p.ts)}
                y={height - 8}
                textAnchor="middle"
                fontSize="11"
                fill="var(--ink-3)"
                className="tnum"
              >
                {fmtClock(p.ts)}
              </text>
            ))}
            <path d={areaPath} fill="var(--accent)" opacity="0.1" />
            <path
              d={linePath}
              fill="none"
              stroke="var(--accent)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {hover && (
              <g>
                <line
                  x1={xScale(hover.ts)}
                  x2={xScale(hover.ts)}
                  y1={pad.top}
                  y2={pad.top + plotH}
                  stroke="var(--ink-3)"
                  strokeWidth="1"
                />
                <circle
                  cx={xScale(hover.ts)}
                  cy={yScale(hover.value)}
                  r="4"
                  fill="var(--accent)"
                  stroke="var(--surface)"
                  strokeWidth="2"
                />
              </g>
            )}
            {(() => {
              const last = points[points.length - 1];
              return (
                <circle
                  cx={xScale(last.ts)}
                  cy={yScale(last.value)}
                  r="4"
                  fill="var(--accent)"
                  stroke="var(--surface)"
                  strokeWidth="2"
                />
              );
            })()}
            {/* full-plot hit area, so the crosshair never misses */}
            <rect
              x={pad.left}
              y={pad.top}
              width={plotW}
              height={plotH}
              fill="transparent"
              onMouseMove={onMove}
              onMouseLeave={() => setHoverIdx(null)}
            />
          </svg>
          {hover && (
            <div
              role="status"
              className="pointer-events-none absolute top-2 z-10 rounded-lg border border-hairline bg-surface px-3 py-2 text-xs shadow-sm"
              style={{
                left: tooltipFlip ? xScale(hover.ts) - 132 : xScale(hover.ts) + 12,
              }}
            >
              <span className="font-semibold text-ink">{formatValue(hover.value)}</span>
              <span className="ml-1.5 text-ink-3">{fmtClock(hover.ts)}</span>
            </div>
          )}
        </>
      )}
      {!ready && (
        <p className="flex h-full items-center justify-center text-sm text-ink-3">
          No traffic in this session yet.
        </p>
      )}
    </div>
  );
}
