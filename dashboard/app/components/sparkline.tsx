/**
 * 12-point trend line for stat tiles: thin accent stroke, small
 * end-dot with a surface ring. No axes, no gridlines at this size.
 */
export function Sparkline({ points, width = 96, height = 28 }: { points: number[]; width?: number; height?: number }) {
  const max = Math.max(...points, 0);
  const min = Math.min(...points, 0);
  const span = max - min || 1;
  const pad = 3;

  const coords = points.map((v, i) => {
    const x = pad + (i / Math.max(1, points.length - 1)) * (width - pad * 2);
    const y = pad + (1 - (v - min) / span) * (height - pad * 2);
    return [x, y] as const;
  });

  const path = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [ex, ey] = coords[coords.length - 1];

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      className="shrink-0"
    >
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.85" />
      <circle cx={ex} cy={ey} r="2.5" fill="var(--accent)" stroke="var(--surface)" strokeWidth="1.5" />
    </svg>
  );
}
