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
 * Billing — plan state for the signed-in account. The page is a
 * read-model of what the webhook handler wrote to SQLite
 * (/api/billing/state); Subscribe hands off to a Dodo checkout and
 * the 4s poll flips the page to active once Dodo's webhook lands
 * (the redirect-before-webhook race — fulfillment is never taken
 * from the redirect itself).
 */
export default function BillingPage() {
  const { data, stale } = usePoll<BillingState>("/api/billing/state", POLL_MS);

  // `?status=processing|cancelled` comes back from Dodo's
  // return/cancel URLs.
  const returnStatus = useSearchParams().get("status");

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function subscribe() {
    if (busy || !data) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await postCheckout(data.plan?.id);
      window.location.href = res.checkoutUrl;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Checkout failed");
      setBusy(false);
    }
  }

  async function manageBilling() {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await getPortalUrl();
      window.location.href = res.url;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not open the portal");
      setBusy(false);
    }
  }

  if (!data) {
    return (
      <div className="flex max-w-3xl flex-col gap-6">
        <h1 className="text-xl font-semibold tracking-tight text-ink">Billing</h1>
        <Panel title="Plan">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-2/3" />
          </div>
        </Panel>
      </div>
    );
  }

  const { plan, usage, subscription, effective } = data;
  const cancelling = effective && subscription?.status === "cancelled";
  const usedPct =
    usage.unlimited || usage.quotaUsd <= 0
      ? 0
      : Math.min(100, (usage.usedUsd / usage.quotaUsd) * 100);
  const fmtDate = (ms: number | null | undefined) =>
    ms ? fmtDateTime(new Date(ms).toISOString()) : "-";

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Billing</h1>
        <p className="mt-0.5 text-[13px] text-ink-3">
          {effective
            ? `${plan?.name ?? data.planId} plan · renews ${fmtDate(data.planExpiry)}`
            : "No active subscription — the API is blocked until you subscribe."}
        </p>
      </div>

      {returnStatus === "cancelled" && (
        <Banner tone="warn" title="Checkout cancelled">
          You haven&apos;t been charged. You can subscribe whenever you&apos;re ready.
        </Banner>
      )}
      {returnStatus === "processing" &&
        (effective ? (
          <Banner tone="good" title="Subscription active">
            Your plan is live — the API is unlocked.
          </Banner>
        ) : (
          <Banner tone="info" title="Finishing up…">
            Payment received. Your plan activates as soon as the payment provider confirms it —
            this page updates automatically.
          </Banner>
        ))}

      {data.status === "suspended" && (
        <Banner tone="warn" title="Account suspended">
          Contact support if you believe this is a mistake.
        </Banner>
      )}

      {!effective && (
        <Panel title="Subscribe" note={plan ? `${fmtUsd(plan.priceUsd)} / month` : undefined}>
          {plan ? (
            <div className="flex flex-col gap-4">
              <ul className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                <li className="flex items-center gap-2">
                  <CheckCircle size={15} weight="bold" className="shrink-0 text-good" />
                  {plan.name} plan — every {plan.tiers.includes("pro") ? "model" : "cheap-tier model"}{" "}
                  via the API
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle size={15} weight="bold" className="shrink-0 text-good" />
                  {usage.quotaUsd > 0
                    ? `${fmtUsd(usage.quotaUsd)} of usage included each month`
                    : "Unlimited monthly usage"}
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle size={15} weight="bold" className="shrink-0 text-good" />
                  Cancel anytime — access runs to the end of the paid period
                </li>
              </ul>
              {plan.tiers.length === 1 && (
                <p className="text-xs text-ink-3">
                  This plan is limited to {plan.tiers.join(", ")}-tier models.
                </p>
              )}
              {data.checkoutConfigured ? (
                <div>
                  <Button variant="primary" pending={busy} onClick={subscribe}>
                    <CreditCard size={15} weight="bold" />
                    Subscribe — {fmtUsd(plan.priceUsd)}/mo
                  </Button>
                </div>
              ) : (
                <p className="flex items-start gap-1.5 rounded-lg bg-warning/10 px-2.5 py-1.5 text-xs text-warning">
                  <WarningCircle size={13} weight="bold" className="mt-0.5 shrink-0" />
                  Billing isn&apos;t configured yet — the operator still needs to paste the Dodo
                  product id into config/plans.json.
                </p>
              )}
              {actionError && (
                <p className="flex items-start gap-1.5 rounded-lg bg-critical/10 px-2.5 py-1.5 text-xs text-critical">
                  <WarningCircle size={13} weight="bold" className="mt-0.5 shrink-0" />
                  {actionError}
                </p>
              )}
            </div>
          ) : (
            <EmptyState
              title="No plan available"
              body="The plan catalog is empty — the operator needs to configure config/plans.json."
            />
          )}
        </Panel>
      )}

      {effective && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatTile
              label="Plan"
              value={plan?.name ?? data.planId}
              sub={cancelling ? "cancelling" : "active"}
            />
            <StatTile
              label={cancelling ? "Access until" : "Renews"}
              value={fmtDate(data.planExpiry)}
              sub={cancelling ? "then the API blocks" : "auto-renews via Dodo"}
            />
            <StatTile
              label="This month"
              value={usage.unlimited ? "Unlimited" : fmtUsd(usage.usedUsd)}
              sub={
                usage.unlimited
                  ? `since ${usage.monthStart}`
                  : `of ${fmtUsd(usage.quotaUsd)} · resets the 1st`
              }
            />
          </div>

          {!usage.unlimited && usage.quotaUsd > 0 && (
            <Panel title="Monthly usage" note={`${usedPct.toFixed(1)}% of quota`}>
              <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
                <div
                  className={`h-full rounded-full ${usedPct >= 90 ? "bg-critical" : usedPct >= 70 ? "bg-warning" : "bg-accent"}`}
                  style={{ width: `${usedPct}%` }}
                />
              </div>
              <p className="mt-2 text-xs text-ink-3">
                {fmtUsd(usage.usedUsd)} of {fmtUsd(usage.quotaUsd)} used since {usage.monthStart} (UTC).
                Requests are blocked once the quota is reached.
              </p>
            </Panel>
          )}

          {cancelling && (
            <Banner tone="warn" title="Subscription cancelled">
              Your plan stays active until {fmtDate(data.planExpiry)}. After that the API blocks
              until you resubscribe.
            </Banner>
          )}

          <Panel title="Manage" note="payments, invoices, cancellation">
            <div className="flex flex-col gap-3">
              <div>
                <Button variant="ghost" pending={busy} onClick={manageBilling}>
                  Manage billing
                </Button>
              </div>
              {actionError && (
                <p className="flex items-start gap-1.5 rounded-lg bg-critical/10 px-2.5 py-1.5 text-xs text-critical">
                  <WarningCircle size={13} weight="bold" className="mt-0.5 shrink-0" />
                  {actionError}
                </p>
              )}
              <p className="text-xs text-ink-3">
                Opens the payment provider&apos;s secure portal in a new page.
              </p>
            </div>
          </Panel>
        </>
      )}

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
