"use client";

import { ReactNode } from "react";

/**
 * Skeleton block: a surface-2 placeholder that shimmers while the
 * first load runs. Matches the final layout's shape exactly (the
 * surrounding components supply the geometry). Shimmer is disabled
 * under prefers-reduced-motion.
 */
export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`motion-safe:animate-pulse rounded-md bg-surface-2 ${className}`}
    />
  );
}

/** Panel: the console's card. 12px radius, hairline ring, solid fill. */
export function Panel({
  title,
  note,
  actions,
  children,
  className = "",
}: {
  title: string;
  note?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-xl border border-hairline bg-surface p-4 sm:p-5 ${className}`}>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-[15px] font-semibold tracking-tight text-ink">{title}</h2>
        <div className="flex items-center gap-2">
          {note && <span className="text-xs text-ink-3">{note}</span>}
          {actions}
        </div>
      </div>
      {children}
    </section>
  );
}

/** Primary / ghost buttons. Labels are short enough to never wrap. */
export function Button({
  children,
  onClick,
  variant = "ghost",
  disabled,
  pending,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost";
  disabled?: boolean;
  pending?: boolean;
  className?: string;
}) {
  const base =
    "hover-lift inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50 disabled:pointer-events-none";
  const styles =
    variant === "primary"
      ? "bg-accent text-on-accent"
      : "border border-hairline text-ink-2 hover:text-ink";
  return (
    <button type="button" onClick={onClick} disabled={disabled || pending} className={`${base} ${styles} ${className}`}>
      {pending ? "Working..." : children}
    </button>
  );
}

/** Small status pill: text + icon color only, never color alone. */
export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warning" | "critical" | "accent";
}) {
  const tones: Record<string, string> = {
    neutral: "bg-surface-2 text-ink-2",
    good: "bg-good/15 text-good",
    warning: "bg-warning/15 text-warning",
    critical: "bg-critical/15 text-critical",
    accent: "bg-accent/15 text-accent-ink",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

/** Switch control. Instant-apply; the parent handles persistence. */
export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5.5 w-9 shrink-0 rounded-full transition-colors duration-200 disabled:opacity-40 ${
        checked ? "bg-accent" : "bg-ink-3/50"
      }`}
    >
      <span
        className={`absolute top-0.5 h-4.5 w-4.5 rounded-full bg-white shadow-sm transition-transform duration-200 ${
          checked ? "translate-x-[17px]" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

/** Segmented control for a small set of exclusive options. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex rounded-lg border border-hairline bg-surface p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={`rounded-md px-2.5 py-1 text-[13px] font-medium transition-colors ${
            o.value === value ? "bg-accent text-on-accent" : "text-ink-2 hover:text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Composed empty state: explains what is missing and how to fix it. */
export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line bg-surface px-6 py-10 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      <p className="max-w-sm text-[13px] text-ink-3">{body}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
