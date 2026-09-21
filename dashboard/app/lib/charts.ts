// Chart plumbing: bucketing, scales, tick math. Kept separate from the
// components so the mark specs stay readable.

export type Point = { ts: number; value: number };

/**
 * Bucket records into `bins` equal time buckets spanning the session.
 * Returns one Point per bucket, left edge timestamp.
 */
export function bucketByTime(records: { ts: number }[], bins: number): Point[] {
  if (records.length === 0) return [];
  const sorted = [...records].sort((a, b) => a.ts - b.ts);
  const start = sorted[0].ts;
  const end = Math.max(sorted[sorted.length - 1].ts, start + 1);
  const width = Math.max(1, (end - start) / bins);
  const out: Point[] = [];
  for (let i = 0; i < bins; i++) {
    out.push({ ts: start + i * width, value: 0 });
  }
  for (const r of sorted) {
    const idx = Math.min(bins - 1, Math.floor((r.ts - start) / width));
    out[idx].value += 1;
  }
  return out;
}

/** Map a value onto a pixel range with a padded headroom. */
export function linearScale(domain: [number, number], range: [number, number]) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (v: number) => r0 + ((v - d0) / span) * (r1 - r0);
}

/**
 * Clean y-axis ticks: 0, 1/2 max, max, rounded up to a nice step
 * (1/2/5 × 10^n). Charts share this so tick labels never repeat or
 * collide.
 */
export function niceTicks(max: number, count = 3): number[] {
  if (max <= 0) return [0];
  const raw = max / (count - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  if (ticks.length < 2) ticks.push(max);
  return ticks;
}

export function maxOf(rows: { value: number }[]): number {
  return rows.reduce((m, r) => Math.max(m, r.value), 0);
}
