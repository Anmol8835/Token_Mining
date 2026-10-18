"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { CheckCircle, CreditCard, WarningCircle } from "@phosphor-icons/react";
import type { BillingState } from "@/app/lib/api";
import { getPortalUrl, postCheckout } from "@/app/lib/api";
import { usePoll } from "@/app/lib/use-poll";
import { fmtDateTime, fmtUsd } from "@/app/lib/format";
import { Button, EmptyState, Panel, Skeleton } from "@/app/components/ui";
import { StatTile } from "@/app/components/stat-tile";

const POLL_MS = 4000;

/**
 * Billing — prepaid credit for the signed-in account. The page is
 * a read-model of users.balance_usd (webhook credits, metrics
 * debits); Add credit hands off to a Dodo one-time checkout and
 * the 4s poll flips the balance once the payment webhook lands
 * (the redirect-before-webhook race — fulfillment is never taken
 * from the redirect itself).
 */
export default function BillingPage() {
  const { data, stale } = usePoll<BillingState>("/api/billing/state", POLL_MS);

  // `?status=processing|cancelled` comes back from Dodo's
  // return/cancel URLs.
  const returnStatus = useSearchParams().get("status");

  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function addCredit(topupId: string) {
    if (busy || !data) return;
    setBusy(topupId);
    setActionError(null);
    try {
      const res = await postCheckout(topupId);
      // External redirect (Dodo hosted checkout) — not router.push.
      window.location.assign(res.checkoutUrl);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Checkout failed");
      setBusy(null);
    }
  }

  async function manageBilling() {
    if (busy) return;
    setBusy("portal");
    setActionError(null);
    try {
      const res = await getPortalUrl();
      // External redirect (Dodo customer portal) — not router.push.
      window.location.assign(res.url);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not open the portal");
      setBusy(null);
    }
  }

  if (!data) {
    return (
      <div className="flex max-w-3xl flex-col gap-6">
        <h1 className="text-xl font-semibold tracking-tight text-ink">Billing</h1>
        <Panel title="Balance">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-2/3" />
          </div>
        </Panel>
      </div>
    );
  }

  const fmtDate = (ms: number | null | undefined) =>
    ms ? fmtDateTime(new Date(ms).toISOString()) : "-";
  const configured = data.topups.filter((t) => t.configured);

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Billing</h1>
        <p className="mt-0.5 text-[13px] text-ink-3">
          Prepaid credit — pay as you go. The API keeps working up to{" "}
          {fmtUsd(data.graceUsd)} below zero.
        </p>
      </div>

      {returnStatus === "cancelled" && (
        <Banner tone="warn" title="Checkout cancelled">
          You haven&apos;t been charged. You can add credit whenever you&apos;re ready.
        </Banner>
      )}
      {returnStatus === "processing" &&
        (data.balanceUsd > 0 ? (
          <Banner tone="good" title="Credit added">
            Your balance is up to date — the API is unlocked.
          </Banner>
        ) : (
          <Banner tone="info" title="Finishing up…">
            Payment received. Your credit appears as soon as the payment provider confirms it —
            this page updates automatically.
          </Banner>
        ))}

      {data.status === "suspended" && (
        <Banner tone="warn" title="Account suspended">
          Contact support if you believe this is a mistake.
        </Banner>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile
          label="Balance"
          value={fmtUsd(data.balanceUsd)}
          sub={`blocks at -${fmtUsd(data.graceUsd)}`}
        />
        <StatTile
          label="Last top-up"
          value={data.lastTopup ? fmtUsd(data.lastTopup.amountUsd) : "—"}
          sub={data.lastTopup ? fmtDate(data.lastTopup.at) : "no top-ups yet"}
        />
        <StatTile
          label="Account"
          value={data.status}
          sub={data.status === "pending" ? "activates with your first top-up" : undefined}
        />
      </div>

      {data.balanceUsd < 0 && data.status === "active" && (
        <Banner tone="warn" title="Using the grace window">
          Your balance is negative. The API blocks once it reaches -{fmtUsd(data.graceUsd)} — add
          credit to keep requests flowing.
        </Banner>
      )}

      <Panel title="Add credit" note="one-time payment">
        {configured.length > 0 ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              {configured.map((t) => (
                <Button
                  key={t.id}
                  variant="primary"
                  pending={busy === t.id}
                  disabled={busy !== null && busy !== t.id}
                  onClick={() => addCredit(t.id)}
                >
                  <CreditCard size={15} weight="bold" />
                  Add {t.name}
                </Button>
              ))}
            </div>
            <p className="text-[13px] leading-relaxed text-ink-2">
              Credit never expires. Usage is deducted per request — cheap-tier models stretch it
              much further than pro-tier ones, and auto-routing always picks the cheapest model
              that can do the job.
            </p>
            {actionError && (
              <p className="flex items-start gap-1.5 rounded-lg bg-critical/10 px-2.5 py-1.5 text-xs text-critical">
                <WarningCircle size={13} weight="bold" className="mt-0.5 shrink-0" />
                {actionError}
              </p>
            )}
          </div>
        ) : (
          <EmptyState
            title="Top-ups not configured"
            body={
              data.topups.length > 0
                ? "The operator still needs to paste the Dodo product ids into config/plans.json."
                : "The top-up catalog is empty — the operator needs to configure config/plans.json."
            }
          />
        )}
      </Panel>

      <Panel title="Manage" note="payment history, invoices">
        <div className="flex flex-col gap-3">
          <div>
            <Button variant="ghost" pending={busy === "portal"} onClick={manageBilling}>
              Manage billing
            </Button>
          </div>
          {configured.length === 0 && actionError && (
            <p className="flex items-start gap-1.5 rounded-lg bg-critical/10 px-2.5 py-1.5 text-xs text-critical">
              <WarningCircle size={13} weight="bold" className="mt-0.5 shrink-0" />
              {actionError}
            </p>
          )}
          <p className="text-xs text-ink-3">
            Opens the payment provider&apos;s secure portal in a new page — available after your
            first top-up.
          </p>
        </div>
      </Panel>

      {stale && (
        <p className="text-xs text-ink-3">
          Reconnecting… showing the last known state.
        </p>
      )}
    </div>
  );
}

function Banner({
  tone,
  title,
  children,
}: {
  tone: "good" | "warn" | "info";
  title: string;
  children: React.ReactNode;
}) {
  const styles = {
    good: "border-good/40 bg-good/10 text-good",
    warn: "border-warning/40 bg-warning/10 text-warning",
    info: "border-accent/40 bg-accent/10 text-accent",
  }[tone];
  const Icon = tone === "good" ? CheckCircle : WarningCircle;
  return (
    <section className={`rounded-xl border p-3.5 sm:p-4 ${styles}`}>
      <h2 className="flex items-center gap-2 text-[13px] font-semibold">
        <Icon size={15} weight="bold" className="shrink-0" />
        {title}
      </h2>
      <p className="mt-1 text-[13px] leading-relaxed opacity-90">{children}</p>
    </section>
  );
}
