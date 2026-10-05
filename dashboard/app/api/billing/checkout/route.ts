import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/db";
import { getSessionUser, SESSION_COOKIE } from "@/lib/auth";
import { getPlanById, getProductId } from "@/lib/plans";
import { dashboardBaseUrl, getDodo } from "@/lib/dodo";

// ============================================================
// Create a Dodo checkout session for the signed-in user.
//
// The metadata.user_id is what the Express webhook handler uses
// to correlate the subscription back to this account (its primary
// correlation signal) — the user id is derived from the session
// cookie, never trusted from the request body.
//
// The session URL is one-time and expires in 24h; each click
// creates a fresh one (and a checkout_sessions row, so
// payment.succeeded can close it and support can reconcile).
// ============================================================

export async function POST(req: NextRequest) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const sessionUser = getSessionUser(token);
  if (!sessionUser) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: { planId?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine — planId defaults below */
  }

  const db = getDb();
  const user = db
    .prepare("SELECT status, plan, plan_expiry FROM users WHERE id = ?")
    .get(sessionUser.id) as
    | { status: string; plan: string; plan_expiry: number | null }
    | undefined;
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const effective =
    user.status === "active" &&
    user.plan !== "none" &&
    typeof user.plan_expiry === "number" &&
    user.plan_expiry > Date.now();
  if (effective) {
    return NextResponse.json(
      { ok: false, error: "You already have an active subscription. Use Manage billing to change it." },
      { status: 409 }
    );
  }

  const planId = typeof body.planId === "string" && body.planId ? body.planId : "monthly";
  const plan = getPlanById(planId);
  if (!plan) {
    return NextResponse.json({ ok: false, error: "Unknown plan" }, { status: 400 });
  }
  const productId = getProductId(plan.id);
  if (!productId) {
    return NextResponse.json(
      { ok: false, error: "Billing is not configured yet (missing Dodo product id)." },
      { status: 503 }
    );
  }

  const base = dashboardBaseUrl();
  try {
    const session = await getDodo().checkoutSessions.create({
      product_cart: [{ product_id: productId, quantity: 1 }],
      customer: {
        email: sessionUser.email,
        name: sessionUser.name ?? undefined,
      },
      metadata: { user_id: sessionUser.id, plan_id: plan.id },
      return_url: `${base}/billing?status=processing`,
      cancel_url: `${base}/billing?status=cancelled`,
      billing_currency: "USD",
    });
    if (!session.checkout_url) {
      throw new Error("Dodo returned no checkout_url");
    }
    db.prepare(
      `INSERT INTO checkout_sessions (session_id, user_id, product_id, status, created_at)
       VALUES (?, ?, ?, 'open', ?)`
    ).run(session.session_id, sessionUser.id, productId, Date.now());
    return NextResponse.json({
      ok: true,
      checkoutUrl: session.checkout_url,
      sessionId: session.session_id,
    });
  } catch (err) {
    console.error("[billing] checkout creation failed:", (err as Error).message);
    return NextResponse.json(
      { ok: false, error: "Could not start checkout — try again." },
      { status: 502 }
    );
  }
}
