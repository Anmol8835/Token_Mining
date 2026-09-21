"use client";

import { ReactNode, useState } from "react";
import { ListNumbers, ChartBar } from "@phosphor-icons/react";
import { Panel } from "@/app/components/ui";

/**
 * Chart wrapper with the WCAG twin: every chart ships a table view.
 * The toggle sits in the panel header; switching views never moves the
 * panel itself, so the layout stays put.
 */
export function ChartPanel({
  title,
  note,
  children,
  table,
  defaultView = "chart",
  actions,
  className = "",
}: {
  title: string;
  note?: string;
  children: ReactNode;
  table: ReactNode;
  defaultView?: "chart" | "table";
  actions?: ReactNode;
  className?: string;
}) {
  const [view, setView] = useState<"chart" | "table">(defaultView);

  return (
    <Panel
      title={title}
      note={note}
      className={className}
      actions={
        <>
          {actions}
          <div className="flex rounded-lg border border-hairline p-0.5" role="group" aria-label={`${title} view`}>
            <button
              type="button"
              onClick={() => setView("chart")}
              aria-pressed={view === "chart"}
              aria-label="Chart view"
              className={`rounded-md p-1.5 ${view === "chart" ? "bg-surface-2 text-ink" : "text-ink-3 hover:text-ink"}`}
            >
              <ChartBar size={14} weight={view === "chart" ? "bold" : "regular"} />
            </button>
            <button
              type="button"
              onClick={() => setView("table")}
              aria-pressed={view === "table"}
              aria-label="Table view"
              className={`rounded-md p-1.5 ${view === "table" ? "bg-surface-2 text-ink" : "text-ink-3 hover:text-ink"}`}
            >
              <ListNumbers size={14} weight={view === "table" ? "bold" : "regular"} />
            </button>
          </div>
        </>
      }
    >
      {view === "chart" ? children : table}
    </Panel>
  );
}
