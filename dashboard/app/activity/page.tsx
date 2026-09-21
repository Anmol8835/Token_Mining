"use client";

import { useState } from "react";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import type { MetricsSnapshot, RecordRow } from "@/app/lib/api";
import { postJson } from "@/app/lib/api";
import { usePoll } from "@/app/lib/use-poll";
import { fmtClock, fmtDateTime, fmtInt, fmtPct, fmtUsd } from "@/app/lib/format";
import { DataTable, type Column } from "@/app/components/data-table";
import { Badge, Button, EmptyState, Panel } from "@/app/components/ui";
import { ActivitySkeleton } from "@/app/components/skeletons";
import { BarList } from "@/app/components/bar-list";
import { ChartPanel } from "@/app/components/chart-panel";

const PAGE_SIZE = 50;

const allColumns: Column<RecordRow>[] = [
  { key: "ts", label: "Time", mono: true, render: (r) => fmtClock(r.ts) },
  { key: "prompt", label: "Prompt", render: (r) => <span className="block max-w-72 truncate">{r.prompt || "-"}</span> },
  { key: "task", label: "Task", render: (r) => r.primary_task ?? "-" },
  { key: "domain", label: "Domain", render: (r) => r.domain ?? "-" },
  { key: "risk", label: "Risk", render: (r) => (r.risk ? <Badge tone={r.risk === "restricted" ? "critical" : "neutral"}>{r.risk}</Badge> : "-") },
  { key: "type", label: "Type", render: (r) => r.model_type ?? "-" },
  { key: "model", label: "Model", render: (r) => r.selectedModel ?? "-" },
  { key: "score", label: "Score", align: "right", render: (r) => (r.winnerScore != null ? r.winnerScore.toFixed(3) : "-") },
  { key: "conf", label: "Conf", align: "right", render: (r) => (r.confidence != null ? `${(r.confidence * 100).toFixed(0)}%` : "-") },
  { key: "source", label: "Source", render: (r) => r.source ?? "-" },
  { key: "classMs", label: "Classify", align: "right", render: (r) => (r.classifierMs != null ? `${r.classifierMs}ms` : "-") },
  { key: "provMs", label: "Provider", align: "right", render: (r) => (r.providerMs != null ? `${r.providerMs}ms` : "-") },
  { key: "tokens", label: "Tokens", align: "right", render: (r) => fmtInt(r.tokens) },
  { key: "cache", label: "Cache in", align: "right", render: (r) => fmtInt(r.cacheReadTokens) },
  { key: "compact", label: "Dropped", align: "right", render: (r) => fmtInt(r.compactionDroppedMsgs) },
  { key: "cost", label: "Cost", align: "right", render: (r) => fmtUsd(r.costUsd) },
  { key: "ok", label: "Status", render: (r) => (r.ok == null ? "-" : r.ok ? <Badge tone="good">ok</Badge> : <Badge tone="critical">failed</Badge>) },
];

export default function ActivityPage() {
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const { data: m } = usePoll<MetricsSnapshot>("/api/server/metrics", 3000);

  const records = m?.allRecords ?? [];
  const pages = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
  const pageRows = records.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  async function runAction(kind: "demo" | "reset" | "eval") {
    setBusy(kind);
    try {
      await postJson(`/api/server/metrics/${kind}`, {});
    } catch {
      /* error surfaces via the stale indicator in the nav */
    } finally {
      setBusy(null);
    }
  }

  const evalRows = m?.eval?.byField ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">Activity</h1>
          <p className="mt-0.5 text-[13px] text-ink-3">
            Every routed request this session, plus the classifier eval set.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => runAction("demo")} pending={busy === "demo"}>
            Generate demo traffic
          </Button>
          <Button onClick={() => runAction("eval")} pending={busy === "eval"}>
            Run eval set
          </Button>
          <Button onClick={() => runAction("reset")} pending={busy === "reset"}>
            Reset session
          </Button>
        </div>
      </div>

      {!m ? (
        <ActivitySkeleton />
      ) : (
        <>
      {records.length === 0 ? (
        <EmptyState
          title="No requests yet"
          body="Generate demo traffic or send requests to POST /v1/messages on the router. This table holds up to 250 records per session."
          action={<Button variant="primary" onClick={() => runAction("demo")}>Generate demo traffic</Button>}
        />
      ) : (
        <Panel title="Requests" note={`${fmtInt(records.length)} total, page ${page + 1} of ${pages}`}>
          <DataTable columns={allColumns} rows={pageRows} rowKey={(r) => String(r.ts) + (r.prompt || "")} />
          <div className="mt-3 flex items-center justify-between">
            <span className="text-xs text-ink-3">
              Showing {fmtInt(pageRows.length)} rows. The ring buffer keeps the latest 250 per session.
            </span>
            <div className="flex items-center gap-1">
              <Button disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                <CaretLeft size={14} weight="bold" /> Newer
              </Button>
              <Button disabled={page >= pages - 1} onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}>
                Older <CaretRight size={14} weight="bold" />
              </Button>
            </div>
          </div>
        </Panel>
      )}

      {/* Classifier eval */}
      {m?.eval ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ChartPanel
            title="Eval accuracy by field"
            note={`${fmtPct(m.eval.accuracy)} overall, ${fmtInt(m.eval.total)} prompts`}
            table={
              <DataTable
                columns={[
                  { key: "f", label: "Field", render: (r) => r.label },
                  { key: "a", label: "Accuracy", align: "right", render: (r) => fmtPct(r.value) },
                ]}
                rows={evalRows.map((f) => ({ key: f.field, label: f.field, value: f.accuracy }))}
                rowKey={(r) => r.key}
              />
            }
          >
            <BarList
              rows={evalRows.map((f) => ({ key: f.field, label: f.field, value: f.accuracy }))}
              formatValue={(v) => `${v.toFixed(0)}%`}
              max={100}
            />
          </ChartPanel>

          <Panel title="Eval failures" note={`${fmtInt(m.eval.failures?.length ?? 0)} failing prompts`}>
            {m.eval.failures && m.eval.failures.length > 0 ? (
              <DataTable
                columns={[
                  { key: "p", label: "Prompt", render: (f) => <span className="block max-w-64 truncate">{f.prompt}</span> },
                  {
                    key: "f",
                    label: "Mismatches",
                    render: (f) =>
                      f.fails
                        .map((x) => `${x.field}: got ${String(x.got)} wanted ${String(x.want)}`)
                        .join("; "),
                  },
                ]}
                rows={m.eval.failures}
                rowKey={(f) => f.id ?? f.prompt}
              />
            ) : (
              <p className="py-4 text-center text-sm text-ink-3">Every labeled prompt classified correctly.</p>
            )}
          </Panel>
        </div>
      ) : (
        <Panel title="Classifier eval" note="config/eval-prompts.json">
          <p className="text-[13px] text-ink-3">
            Not run this session. Run the eval set to score the classifier against the labeled
            prompts. Last run: {m?.eval?.generatedAt ? fmtDateTime(m.eval.generatedAt) : "never"}.
          </p>
        </Panel>
      )}
        </>
      )}
    </div>
  );
}
