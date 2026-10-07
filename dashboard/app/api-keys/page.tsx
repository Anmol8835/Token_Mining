"use client";

import { useEffect, useState } from "react";
import { Check, WarningCircle, X } from "@phosphor-icons/react";
import type { ApiKeyEntry, ApiKeyList } from "@/app/lib/api";
import { createApiKey, deleteJson } from "@/app/lib/api";
import { usePoll } from "@/app/lib/use-poll";
import { fmtDateTime } from "@/app/lib/format";
import { Badge, Button, EmptyState, Panel, Skeleton } from "@/app/components/ui";

const LIST_POLL_MS = 5000;

/**
 * API key management. Keys gate POST /v1/messages and /v1/classify:
 * with zero keys the server stays open (bootstrap), and from the
 * first key on every request must carry one. The plaintext key is
 * returned exactly once, at creation — held only in the one-shot
 * banner state below and never polled back from the server.
 */
export default function ApiKeysPage() {
  const { data } = usePoll<ApiKeyList>("/api/server/config/api-keys", LIST_POLL_MS);

  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [newSecret, setNewSecret] = useState<{ apiKey: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeErrors, setRevokeErrors] = useState<Record<string, string>>({});

  // A revoke confirm arms for 4s, then falls back to the plain button.
  useEffect(() => {
    if (!confirmRevokeId) return;
    const t = setTimeout(() => setConfirmRevokeId(null), 4000);
    return () => clearTimeout(t);
  }, [confirmRevokeId]);

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      // The backend links the key to the signed-in account itself
      // (from the session) — an unlinked key is rejected (402
      // key_not_linked) once plan enforcement is on.
      const res = await createApiKey(trimmed);
      setNewSecret({ apiKey: res.apiKey, name: res.key.name });
      setName("");
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "create failed");
    } finally {
      setCreating(false);
    }
  }

  async function handleCopy() {
    if (!newSecret) return;
    try {
      await navigator.clipboard.writeText(newSecret.apiKey);
      setCopied(true);
      setCopyError(null);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopyError("copy failed — select the key manually");
    }
  }

  async function handleRevoke(entry: ApiKeyEntry) {
    setRevoking(entry.id);
    setRevokeErrors((e) => {
      const next = { ...e };
      delete next[entry.id];
      return next;
    });
    try {
      await deleteJson(`/api/server/config/api-keys/${entry.id}`);
      setConfirmRevokeId(null);
    } catch (err) {
      setRevokeErrors((e) => ({
        ...e,
        [entry.id]: err instanceof Error ? err.message : "revoke failed",
      }));
    } finally {
      setRevoking(null);
    }
  }

  const keyCount = data?.keys.length ?? 0;

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">API Keys</h1>
        <p className="mt-0.5 text-[13px] text-ink-3">
          {data
            ? keyCount > 0
              ? `${keyCount} key${keyCount === 1 ? "" : "s"} — /v1/messages and /v1/classify require one.`
              : "No keys yet — the API is open until the first key is created."
            : "Loading keys."}
        </p>
      </div>

      <Panel title="Create a key" note="plaintext shown once">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleCreate();
          }}
          className="flex flex-col gap-3 sm:flex-row"
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.form?.requestSubmit();
            }}
            placeholder="Key name, e.g. claude-code"
            maxLength={60}
            aria-label="Key name"
            className="w-full max-w-xs rounded-lg border border-hairline bg-page px-3 py-1.5 text-sm text-ink placeholder:text-ink-3 focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <Button variant="primary" pending={creating} onClick={handleCreate}>
            Create key
          </Button>
        </form>
        {createError && (
          <p className="mt-3 flex items-start gap-1.5 rounded-lg bg-critical/10 px-2.5 py-1.5 text-xs text-critical">
            <WarningCircle size={13} weight="bold" className="mt-0.5 shrink-0" />
            {createError}
          </p>
        )}
      </Panel>

      {newSecret && (
        <section className="rounded-xl border border-warning/40 bg-warning/10 p-4 sm:p-5">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight text-ink">
              <WarningCircle size={16} weight="bold" className="shrink-0 text-warning" />
              Key created — copy it now
            </h2>
            <button
              type="button"
              onClick={() => {
                setNewSecret(null);
                setCopyError(null);
              }}
              aria-label="Dismiss"
              className="shrink-0 rounded-md p-1 text-ink-3 hover:bg-surface-2 hover:text-ink"
            >
              <X size={14} weight="bold" />
            </button>
          </div>
          <p className="mb-3 text-[13px] leading-relaxed text-ink-2">
            &ldquo;{newSecret.name}&rdquo; — this is the only time the full key is shown. It
            cannot be recovered later; revoke and recreate if it is lost.
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-surface px-3 py-2 font-mono text-xs text-ink">
              {newSecret.apiKey}
            </code>
            <Button variant="primary" onClick={handleCopy}>
              {copied ? (
                <>
                  <Check size={14} weight="bold" /> Copied
                </>
              ) : (
                "Copy"
              )}
            </Button>
          </div>
          {copyError && <p className="mt-2 text-xs text-critical">{copyError}</p>}
        </section>
      )}

      {!data ? (
        <Panel title="Keys">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-2/3" />
          </div>
        </Panel>
      ) : keyCount === 0 ? (
        <EmptyState
          title="No API keys"
          body="Until the first key is created, /v1/messages and /v1/classify accept unauthenticated requests. Creating a key turns enforcement on immediately. To revoke every key without the dashboard, delete data/api-keys.json and restart the server."
        />
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-hairline bg-surface">
          {data.keys.map((k) => {
            const busy = revoking === k.id;
            const error = revokeErrors[k.id];
            const armed = confirmRevokeId === k.id;
            return (
              <li
                key={k.id}
                className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-sm font-medium text-ink">{k.name}</span>
                    <code className="font-mono text-[11px] text-ink-3">{k.prefix}…</code>
                    {k.lastUsedAt && <Badge tone="good">active</Badge>}
                  </div>
                  <div className="mt-0.5 text-xs text-ink-3">
                    created {fmtDateTime(k.createdAt)} · last used {fmtDateTime(k.lastUsedAt)}
                    {k.lastUsedRoute ? ` · ${k.lastUsedRoute}` : ""}
                  </div>
                  {error && (
                    <p className="mt-1.5 flex items-start gap-1.5 rounded-lg bg-critical/10 px-2.5 py-1.5 text-xs text-critical">
                      <WarningCircle size={13} weight="bold" className="mt-0.5 shrink-0" />
                      {error}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {armed ? (
                    <>
                      <Button variant="ghost" disabled={busy} onClick={() => setConfirmRevokeId(null)}>
                        Keep
                      </Button>
                      <Button
                        variant="ghost"
                        pending={busy}
                        className="border-critical/40 text-critical hover:bg-critical/10"
                        onClick={() => handleRevoke(k)}
                      >
                        Confirm revoke
                      </Button>
                    </>
                  ) : (
                    <Button variant="ghost" disabled={revoking !== null} onClick={() => setConfirmRevokeId(k.id)}>
                      Revoke
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Panel title="Using a key" note="either header works">
        <div className="flex flex-col gap-4">
          <div>
            <p className="mb-1.5 text-xs font-medium text-ink-2">
              Authorization: Bearer — recommended
            </p>
            <pre className="overflow-x-auto rounded-lg bg-surface-2 px-3 py-2 font-mono text-[11px] leading-relaxed text-ink-2">{`curl http://localhost:8002/v1/messages \\
  -H "Authorization: Bearer sk-relay-..." \\
  -H "Content-Type: application/json" \\
  -d '{"model":"auto","messages":[{"role":"user","content":"hi"}]}'`}</pre>
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium text-ink-2">x-api-key</p>
            <pre className="overflow-x-auto rounded-lg bg-surface-2 px-3 py-2 font-mono text-[11px] leading-relaxed text-ink-2">{`curl http://localhost:8002/v1/messages \\
  -H "x-api-key: sk-relay-..." \\
  -H "Content-Type: application/json" \\
  -d '{"model":"auto","messages":[{"role":"user","content":"hi"}]}'`}</pre>
          </div>
          <p className="text-[13px] leading-relaxed text-ink-2">
            POST /v1/classify accepts the same headers. Invalid or missing keys get a 401{" "}
            <code className="font-mono text-[11px]">authentication_error</code>. Dashboard
            endpoints (/config, /metrics, /health) are never gated.
          </p>
        </div>
      </Panel>
    </div>
  );
}
