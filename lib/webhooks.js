// ============================================================
// Dodo Payments webhooks — the prepaid-credit source of truth.
//
// POST /webhooks/dodo (registered in index.js, authenticated by
// Dodo's Standard Webhooks signature — never by ADMIN_TOKEN).
// Every delivery is stored in payment_events keyed by the
// webhook-id header, which is the idempotency gate: a replayed
// event is a no-op 200.
//
// payment.succeeded credits users.balance_usd by the pre-tax
// amount (total_amount - tax, cents -> dollars) and flips a
// 'pending' account to 'active' — with subscriptions retired, the
// first top-up is the only activation trigger. Sales tax (an
// Indian test payment carried 18% GST) is collected by Dodo for
// the tax authority and is not credit. Non-USD or zero-amount
// payments are never credited (stored with an error for
// reconciliation instead).
//
// The subscription.* branch below is DORMANT (no subscription
// products are configured) but kept compiling for revival; it
// never resurrects a 'suspended' account.
//
// Correlation: Dodo's webhook payload schema is not fully
// documented, so user matching is a defensive chain —
// metadata.user_id (set at checkout creation) -> checkout
// session id -> subscription id -> customer email -> Dodo
// customer id. Unmatched events are stored with user_id NULL
// (processed=0) for manual reconciliation; the full payload is
// always kept.
// ============================================================

const { Webhook } = require("standardwebhooks");
const db = require("./db");
const plans = require("./plans");

const stmts = {
  insertEvent: db.prepare(
    `INSERT OR IGNORE INTO payment_events
       (webhook_id, type, payload, user_id, processed, created_at)
     VALUES (?, ?, ?, NULL, 0, ?)`
  ),
  markProcessed: db.prepare(
    `UPDATE payment_events SET processed = 1, user_id = ? WHERE webhook_id = ?`
  ),
  markProcessedWithError: db.prepare(
    `UPDATE payment_events SET processed = 1, user_id = ?, error = ? WHERE webhook_id = ?`
  ),
  markUncorrelated: db.prepare(
    `UPDATE payment_events SET error = ? WHERE webhook_id = ?`
  ),
  markError: db.prepare(
    `UPDATE payment_events SET error = ? WHERE webhook_id = ?`
  ),

  userById: db.prepare("SELECT id FROM users WHERE id = ?"),
  userByEmail: db.prepare("SELECT id, status FROM users WHERE email = ?"),
  checkoutBySession: db.prepare(
    "SELECT user_id FROM checkout_sessions WHERE session_id = ?"
  ),
  subById: db.prepare("SELECT * FROM subscriptions WHERE id = ?"),
  subByDodoCustomer: db.prepare(
    `SELECT user_id FROM subscriptions WHERE dodo_customer_id = ?
      ORDER BY updated_at DESC LIMIT 1`
  ),

  upsertSubscription: db.prepare(
    `INSERT INTO subscriptions
       (id, user_id, dodo_customer_id, product_id, status, plan,
        current_period_end, created_at, updated_at)
     VALUES (@id, @user_id, @dodo_customer_id, @product_id, @status, @plan,
             @current_period_end, @now, @now)
     ON CONFLICT(id) DO UPDATE SET
       user_id            = excluded.user_id,
       dodo_customer_id   = excluded.dodo_customer_id,
       product_id         = excluded.product_id,
       status             = excluded.status,
       plan               = excluded.plan,
       current_period_end = excluded.current_period_end,
       updated_at         = excluded.updated_at`
  ),
  setSubscriptionStatus: db.prepare(
    `UPDATE subscriptions SET status = ?, updated_at = ? WHERE id = ?`
  ),

  // The top-up credit: adds the paid amount and flips a 'pending'
  // account to 'active' on its first payment. Suspended users stay
  // suspended (webhooks never resurrect them) — the credit still
  // lands, enforcement keeps blocking.
  creditUser: db.prepare(
    `UPDATE users
        SET balance_usd = balance_usd + ?,
            dodo_customer_id = COALESCE(?, dodo_customer_id),
            status = CASE WHEN status = 'suspended' THEN 'suspended' ELSE 'active' END
      WHERE id = ?`
  ),

  // Dormant (subscription era): pending users became active on
  // their first live subscription.
  activateUser: db.prepare(
    `UPDATE users
        SET plan = ?,
            plan_expiry = ?,
            status = CASE WHEN status = 'suspended' THEN 'suspended' ELSE 'active' END
      WHERE id = ?`
  ),
  setUserPlanKeepStatus: db.prepare(
    "UPDATE users SET plan = ?, plan_expiry = ? WHERE id = ?"
  ),
  expireUser: db.prepare("UPDATE users SET plan_expiry = ? WHERE id = ?"),

  openCheckout: db.prepare(
    `SELECT session_id FROM checkout_sessions
      WHERE user_id = ? AND status = 'open'
      ORDER BY created_at DESC LIMIT 1`
  ),
  completeCheckout: db.prepare(
    `UPDATE checkout_sessions SET status = 'completed', completed_at = ?
      WHERE session_id = ?`
  ),
};

/**
 * Verify a delivery against DODO_PAYMENTS_WEBHOOK_KEY. Throws on
 * a bad signature/missing headers; returns the parsed event.
 * Takes the RAW body bytes (captured by express.json's verify hook
 * in index.js) — re-serializing would break the signature.
 */
function verify(rawBody, headers) {
  const webhook = new Webhook(process.env.DODO_PAYMENTS_WEBHOOK_KEY || "");
  return webhook.verify(rawBody, {
    "webhook-id": headers["webhook-id"],
    "webhook-timestamp": headers["webhook-timestamp"],
    "webhook-signature": headers["webhook-signature"],
  });
}

// ------------------------------------------------------------
// Defensive payload readers — the per-event schema is not fully
// documented, so each field is looked up under its plausible
// names. Verified against a real test-mode event before launch.
// ------------------------------------------------------------

function productIdOf(data) {
  return data.product_id ?? data.product?.product_id ?? null;
}

function subscriptionIdOf(data) {
  return data.subscription_id ?? null;
}

function customerIdOf(data) {
  return data.customer_id ?? data.customer?.customer_id ?? null;
}

function customerEmailOf(data) {
  const email = data.customer?.email ?? data.customer_email ?? data.email ?? null;
  return typeof email === "string" ? email.trim().toLowerCase() : null;
}

/**
 * Epoch ms for the subscription period end. Dodo field name is
 * unverified: accept several, numbers as seconds or ms, strings as
 * ISO. Events that don't carry a period (e.g. cancelled) keep the
 * existing row's value; a brand-new row without one falls back to
 * now + 30 days with a loud warning.
 */
function periodEndMs(data, existing) {
  const raw =
    data.current_period_end ??
    data.next_billing_date ??
    data.period_end ??
    data.renewal_date ??
    null;
  if (raw == null) {
    if (existing?.current_period_end) return existing.current_period_end;
    console.warn("[webhooks] no period-end field in payload; defaulting to now+30d");
    return Date.now() + 30 * 24 * 3600 * 1000;
  }
  let t;
  if (typeof raw === "number") {
    t = raw < 1e12 ? raw * 1000 : raw; // seconds vs ms
  } else {
    t = Date.parse(raw);
  }
  if (!Number.isFinite(t)) {
    console.warn(`[webhooks] unparseable period end ${JSON.stringify(raw)}; defaulting to now+30d`);
    return Date.now() + 30 * 24 * 3600 * 1000;
  }
  return t;
}

function correlateUser(data) {
  const metaUserId = data.metadata?.user_id;
  if (typeof metaUserId === "string" && metaUserId) {
    const user = stmts.userById.get(metaUserId);
    if (user) return user.id;
  }
  // Top-up checkouts: the dashboard writes the checkout_sessions
  // row before sending the user to Dodo, so the session id echoed
  // in the payload resolves the account even if metadata is lost.
  const checkoutSessionId = data.checkout_session_id;
  if (typeof checkoutSessionId === "string" && checkoutSessionId) {
    const cs = stmts.checkoutBySession.get(checkoutSessionId);
    if (cs?.user_id) return cs.user_id;
  }
  const subId = subscriptionIdOf(data);
  if (subId) {
    const sub = stmts.subById.get(subId);
    if (sub?.user_id) return sub.user_id;
  }
  const email = customerEmailOf(data);
  if (email) {
    const user = stmts.userByEmail.get(email);
    if (user) return user.id;
  }
  const customerId = customerIdOf(data);
  if (customerId) {
    const sub = stmts.subByDodoCustomer.get(customerId);
    if (sub?.user_id) return sub.user_id;
  }
  return null;
}

/**
 * Map a Dodo product id to a catalog id, falling back to the
 * existing subscription row's plan (dormant subscription events
 * for a removed product still land on the right row). null =
 * unknown product.
 */
function resolveTopupId(productId, subId) {
  const topup = plans.getTopupByProductId(productId);
  if (topup) return topup.id;
  const existing = subId ? stmts.subById.get(subId) : null;
  return existing?.plan ?? null;
}

function completeNewestCheckout(userId) {
  const open = stmts.openCheckout.get(userId);
  if (open) stmts.completeCheckout.run(Date.now(), open.session_id);
}

/**
 * Apply one event to the DB. Runs inside a transaction (see
 * processEvent). Returns { applied, error, userId } — `applied`
 * false means nothing mutated (unknown product / uncorrelated).
 */
function applyEvent(event, userId) {
  const data = event.data || {};
  const now = Date.now();
  const type = event.type;

  const subPrefix = String(type).split(".")[0];

  // Non-subscription families: payment.succeeded is the top-up
  // credit; everything else (processing/failed/cancelled) is
  // logged only.
  if (subPrefix !== "subscription") {
    if (type !== "payment.succeeded") {
      return { applied: true, status: "applied", userId, error: null };
    }
    if (!userId) {
      // No credit without a correlated account — keep processed=0
      // for manual reconciliation.
      return { applied: false, status: "uncorrelated", userId: null, error: "uncorrelated user" };
    }
    const currency = String(data.currency ?? "USD").toUpperCase();
    if (currency !== "USD") {
      // Checkout pins billing_currency USD; anything else is
      // misconfiguration — never credit a wrong amount.
      return { applied: false, status: "non_usd", userId, error: `non-USD currency ${currency}` };
    }
    // Credit the pre-tax amount: total_amount includes sales tax
    // (Dodo reports it separately as `tax`, cents — 90 on a 590
    // total for an Indian card), which the tax authority takes.
    // The customer is credited the price of the product they
    // bought, matching the catalog's "$5 credit" wording.
    const taxCents = typeof data.tax === "number" ? data.tax : 0;
    const creditCents = (data.total_amount ?? 0) - taxCents;
    const amountUsd = Math.round((creditCents / 100) * 10000) / 10000;
    if (!(amountUsd > 0)) {
      return { applied: false, status: "zero_amount", userId, error: "zero credit amount (total_amount - tax)" };
    }
    stmts.creditUser.run(amountUsd, customerIdOf(data), userId);
    completeNewestCheckout(userId);
    return { applied: true, status: "applied", userId, error: null };
  }

  const subId = subscriptionIdOf(data);
  if (!subId) {
    return { applied: false, status: "unknown_product", userId, error: "no subscription_id in payload" };
  }

  // No correlated user => don't write the subscriptions row at all
  // (user_id is NOT NULL). The full payload stays in payment_events
  // (processed=0) for manual reconciliation; Dodo's next event for
  // the same subscription will correlate via the subscription id
  // once a row exists, or needs the same manual fix.
  if (!userId) {
    return { applied: false, status: "uncorrelated", userId: null, error: "uncorrelated user" };
  }

  const productId = productIdOf(data);
  const planId = resolveTopupId(productId, subId);
  if (!planId) {
    return { applied: false, status: "unknown_product", userId, error: `unknown product ${productId ?? "(missing)"}` };
  }

  const existing = stmts.subById.get(subId);
  const dodoCustomerId = customerIdOf(data) ?? existing?.dodo_customer_id ?? null;
  const periodEnd = periodEndMs(data, existing);
  const dodoStatus = data.status ?? existing?.status ?? String(type).replace("subscription.", "");

  // Every subscription event upserts the row (overwrite semantics).
  stmts.upsertSubscription.run({
    id: subId,
    user_id: userId,
    dodo_customer_id: dodoCustomerId,
    product_id: productId ?? existing?.product_id ?? null,
    status: dodoStatus,
    plan: planId,
    current_period_end: periodEnd,
    now,
  });

  switch (type) {
    case "subscription.active":
      stmts.activateUser.run(planId, periodEnd, userId);
      completeNewestCheckout(userId);
      break;
    case "subscription.renewed":
      stmts.activateUser.run(planId, periodEnd, userId);
      break;
    case "subscription.plan_changed":
    case "subscription.updated":
      stmts.setUserPlanKeepStatus.run(planId, periodEnd, userId);
      break;
    case "subscription.failed":
    case "subscription.expired":
      // Immediate block: lapse the expiry rather than waiting for
      // the date to pass.
      stmts.expireUser.run(now, userId);
      break;
    // paused / on_hold / past_due / unpaused /
    // update_payment_method / cancelled: subscription row only.
    // cancelled keeps access until current_period_end (billing
    // page shows "cancels at ..."); expired/failed shorten it
    // above.
    default:
      break;
  }
  return { applied: true, status: "applied", userId, error: null };
}

/**
 * Idempotency gate + dispatch. Returns { status } where status is
 * one of: 'ok' | 'duplicate' | 'uncorrelated' | 'unknown_product'.
 * Throws only on DB failure (caller returns 500 so Dodo retries).
 */
function processEvent(event, webhookId) {
  const inserted = stmts.insertEvent.run(
    webhookId,
    String(event.type || "unknown"),
    JSON.stringify(event),
    Date.now()
  );
  if (inserted.changes === 0) return { status: "duplicate" };

  let userId = null;
  try {
    userId = correlateUser(event.data || {});
    const result = db.transaction(() => applyEvent(event, userId))();

    if (!result.applied) {
      if (result.status === "uncorrelated") {
        // Keep processed=0 — a human (or a later correlated event)
        // still needs to resolve this one.
        stmts.markUncorrelated.run(result.error || "uncorrelated user", webhookId);
        return { status: "uncorrelated" };
      }
      // Unknown product / malformed: stored, flagged, no retry
      // storm from Dodo (respond 200), reconcile from the payload.
      stmts.markProcessedWithError.run(result.userId, result.error, webhookId);
      return { status: result.status || "unknown_product", error: result.error };
    }
    stmts.markProcessed.run(result.userId, webhookId);
    return { status: "ok", userId: result.userId };
  } catch (err) {
    stmts.markError.run(err.message, webhookId);
    throw err;
  }
}

module.exports = { verify, processEvent };
