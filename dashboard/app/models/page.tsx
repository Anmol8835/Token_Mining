"use client";

import { useEffect, useMemo, useState } from "react";
import { CaretRight, Eye, WarningCircle, Wrench, Waves } from "@phosphor-icons/react";
import { siAnthropic, siDeepseek, siGooglegemini } from "simple-icons";
import type { DashboardConfig, MetricsSnapshot } from "@/app/lib/api";
import { postJson } from "@/app/lib/api";
import { usePoll } from "@/app/lib/use-poll";
import { fmtUsd } from "@/app/lib/format";
import { Badge, EmptyState, Panel } from "@/app/components/ui";
import { ModelsSkeleton } from "@/app/components/skeletons";

/**
 * Real brand marks in theme ink so they read on both surfaces. Three
 * come from the simple-icons package; OpenAI removed its mark from
 * simple-icons in v11 over brand guidelines, so the real knot mark is
 * vendored below from simple-icons v10.4.0 (the last version that
 * shipped it) to keep the logo self-hosted.
 */
const OPENAI_PATH =
  "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";

function ProviderLogo({ provider }: { provider: string }) {
  const paths: Record<string, string> = {
    anthropic: siAnthropic.path,
    deepseek: siDeepseek.path,
    gemini: siGooglegemini.path,
    openai: OPENAI_PATH,
  };
  const path = paths[provider];
  if (!path) return null;
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4 shrink-0 text-ink"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

function CapabilityChips({ m }: { m: DashboardConfig["models"][number] }) {
  const ctx = `${(m.capabilities.maxInputTokens / 1024).toFixed(0)}K ctx`;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-2">{ctx}</span>
      {m.capabilities.vision && (
        <span className="flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-2">
          <Eye size={11} weight="bold" /> vision
        </span>
      )}
      {m.capabilities.toolUse && (
        <span className="flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-2">
          <Wrench size={11} weight="bold" /> tools
        </span>
      )}
      {m.capabilities.streaming && (
        <span className="flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-2">
          <Waves size={11} weight="bold" /> streaming
        </span>
      )}
    </span>
  );
}

export default function ModelsPage() {
  const { data: cfg } = usePoll<DashboardConfig>("/api/server/config/dashboard", 5000);
  const { data: metrics } = usePoll<MetricsSnapshot>("/api/server/metrics", 5000);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const models = useMemo(() => cfg?.models ?? [], [cfg]);

  // Optimistic overrides: apply the click instantly instead of waiting
  // for the next config poll (up to 5s). Pruned once the polled
  // catalog agrees with them.
  const [localEnabled, setLocalEnabled] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setLocalEnabled((prev) => {
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const [id, val] of Object.entries(prev)) {
        const model = models.find((m) => m.id === id);
        if (model && model.enabled === val) {
          changed = true;
          continue;
        }
        next[id] = val;
      }
      return changed ? next : prev;
    });
  }, [models]);

  const enabledOf = (id: string, fallback: boolean) => localEnabled[id] ?? fallback;
  const enabledCount = models.filter((m) => enabledOf(m.id, m.enabled)).length;

  // Provider groups, alphabetical, with per-provider session totals.
  const groups = useMemo(() => {
    const byProvider = new Map<string, typeof models>();
    for (const m of models) {
      const list = byProvider.get(m.provider) ?? [];
      list.push(m);
      byProvider.set(m.provider, list);
    }
    return [...byProvider.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, groupModels]) => {
        const costUsd = groupModels.reduce((acc, m) => {
          const u = metrics?.byModel.find((x) => x.key === m.id);
          return acc + (u?.costUsd ?? 0);
        }, 0);
        return { provider, models: groupModels, costUsd };
      });
  }, [models, metrics]);

  function toggleProvider(provider: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(provider)) next.delete(provider);
      else next.add(provider);
      return next;
    });
  }

  async function toggleModel(id: string, enabled: boolean) {
    setPending(id);
    setLocalEnabled((prev) => ({ ...prev, [id]: enabled }));
    setErrors((e) => {
      const next = { ...e };
      delete next[id];
      return next;
    });
    try {
      await postJson("/api/server/config/models", { id, enabled });
    } catch (err) {
      // Revert the optimistic state; the next poll re-syncs the row.
      setLocalEnabled((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setErrors((e) => ({
        ...e,
        [id]: err instanceof Error ? err.message : "toggle failed",
      }));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Models</h1>
        <p className="mt-0.5 text-[13px] text-ink-3">
          {cfg
            ? `${enabledCount} of ${models.length} models selected for auto-routing. Explicit requests still work regardless of the selection.`
            : "Loading model catalog."}
        </p>
      </div>

      {cfg && models.length === 0 && (
        <EmptyState
          title="No models configured"
          body="config/models.json is empty, or no provider has a valid API key. Add models and keys, then restart the server."
        />
      )}

      {!cfg ? (
        <ModelsSkeleton />
      ) : (
        <>
      <div className="divide-y divide-line overflow-hidden rounded-xl border border-hairline bg-surface">
        {groups.map(({ provider, models: groupModels, costUsd }) => {
          const isOpen = open.has(provider);
          const groupEnabled = groupModels.filter((m) => enabledOf(m.id, m.enabled)).length;
          return (
            <div key={provider}>
              <button
                type="button"
                onClick={() => toggleProvider(provider)}
                aria-expanded={isOpen}
                className="flex w-full items-center gap-3 px-4 py-3.5 text-left"
              >
                <CaretRight
                  size={14}
                  weight="bold"
                  className={`shrink-0 text-ink-3 transition-transform duration-200 ${
                    isOpen ? "rotate-90" : ""
                  }`}
                />
                <ProviderLogo provider={provider} />
                <span className="text-[15px] font-medium capitalize text-ink">{provider}</span>
                <Badge tone={groupEnabled > 0 ? "accent" : "neutral"}>
                  {groupEnabled} of {groupModels.length} selected
                </Badge>
                <span className="ml-auto text-xs tnum text-ink-3">
                  {costUsd > 0 ? fmtUsd(costUsd) : ""}
                </span>
              </button>

              {isOpen && (
                <ul className="flex flex-col gap-1 px-4 pb-3 pl-12">
                  {groupModels.map((m) => {
                    const usage = metrics?.byModel.find((x) => x.key === m.id);
                    const busy = pending === m.id;
                    const error = errors[m.id];
                    return (
                      <li
                        key={m.id}
                        className="rounded-lg px-2 py-2 transition-colors hover:bg-surface-2/50"
                      >
                        <label
                          className={`flex items-center gap-3 ${
                            m.available && !busy ? "cursor-pointer" : "cursor-default opacity-70"
                          }`}
                        >
                          <span className="flex min-w-0 flex-1 flex-col gap-1">
                            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span className="text-sm font-medium text-ink">{m.id}</span>
                              {!m.available && <Badge tone="warning">no api key</Badge>}
                              <Badge>{m.profile.costTier} tier</Badge>
                              <Badge>{m.profile.latencyTier} latency</Badge>
                            </span>
                            <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
                              <span className="tnum">
                                {fmtUsd(m.cost.inputPer1M)} / {fmtUsd(m.cost.outputPer1M)} per 1M
                              </span>
                              <CapabilityChips m={m} />
                              {m.apiModelId !== m.id && (
                                <span className="font-mono text-[11px]">api: {m.apiModelId}</span>
                              )}
                            </span>
                            {error && (
                              <span className="flex items-start gap-1.5 rounded-lg bg-critical/10 px-2.5 py-1.5 text-xs text-critical">
                                <WarningCircle size={13} weight="bold" className="mt-0.5 shrink-0" />
                                {error}
                              </span>
                            )}
                          </span>
                          <span className="shrink-0 text-xs tnum text-ink-3">
                            {usage ? fmtUsd(usage.costUsd) : ""}
                          </span>
                          <input
                            type="checkbox"
                            className="h-4 w-4 shrink-0"
                            style={{ accentColor: "var(--accent)" }}
                            checked={enabledOf(m.id, m.enabled)}
                            disabled={!m.available || busy}
                            onChange={(e) => toggleModel(m.id, e.target.checked)}
                          />
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      <Panel title="How selection works" note="routing only">
        <p className="max-w-3xl text-[13px] leading-relaxed text-ink-2">
          Unchecked models drop out of the router candidate pool, so auto-routed requests never
          land on them. The selection is stored in data/dashboard-prefs.json and survives
          restarts. If a request needs a capability only an unchecked model has (or you uncheck
          every eligible model), the router ignores the exclusion rather than fail the request.
          Requests that name a model explicitly always go through.
        </p>
      </Panel>
        </>
      )}
    </div>
  );
}
