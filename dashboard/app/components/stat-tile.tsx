import { TrendDown, TrendUp } from "@phosphor-icons/react";
import { Sparkline } from "@/app/components/sparkline";

type Delta = {
  text: string;
  /** direction × whether "up is good" decides the hue */
  upIsGood?: boolean;
  direction?: "up" | "down";
};

/**
 * Stat tile: label, value (proportional figures), optional delta and a
 * 12-point sparkline in the accent. No card chrome needed at this
 * density; the panel grid provides the grouping.
 */
export function StatTile({
  label,
  value,
  sub,
  delta,
  spark,
}: {
  label: string;
  value: string;
  sub?: string;
  delta?: Delta;
  spark?: number[];
}) {
  const direction = delta?.direction ?? "up";
  const good = (delta?.upIsGood ?? true) === (direction === "up");
  const TrendIcon = direction === "up" ? TrendUp : TrendDown;

  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-hairline bg-surface p-4">
      <span className="text-[13px] text-ink-2">{label}</span>
      <div className="flex items-end justify-between gap-3">
        <span className="text-2xl font-semibold tracking-tight text-ink">{value}</span>
        {spark && spark.length > 1 && <Sparkline points={spark} />}
      </div>
      <div className="flex items-center gap-2 text-xs">
        {delta && (
          <span
            className={`flex items-center gap-1 ${good ? "text-good" : "text-critical"}`}
          >
            <TrendIcon size={14} weight="bold" />
            {delta.text}
          </span>
        )}
        {sub && <span className="text-ink-3">{sub}</span>}
      </div>
    </div>
  );
}
