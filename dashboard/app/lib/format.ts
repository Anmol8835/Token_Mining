// Number formatting shared across the console. Big standalone values
// keep proportional figures; table columns opt into .tnum instead.

export function fmtInt(n: number | null | undefined): string {
  if (n == null) return "-"; // placeholder only, value never shown
  return n.toLocaleString("en-US");
}

export function fmtCompact(n: number | null | undefined): string {
  if (n == null) return "-";
  return Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(n);
}

export function fmtUsd(n: number | null | undefined, opts: { compact?: boolean } = {}): string {
  if (n == null) return "-";
  if (opts.compact) {
    return (
      "$" +
      Intl.NumberFormat("en-US", {
        notation: "compact",
        maximumFractionDigits: 2,
      }).format(n)
    );
  }
  if (Math.abs(n) < 0.01 && n !== 0) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null) return "-";
  return `${n.toFixed(digits)}%`;
}

export function fmtDuration(sec: number | null | undefined): string {
  if (sec == null) return "-";
  if (sec < 60) return `${Math.round(sec)}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
