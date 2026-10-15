import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/db";
import { getSessionUser, SESSION_COOKIE } from "@/lib/auth";
import { dashboardBaseUrl, getDodo } from "@/lib/dodo";

// ============================================================
// Dodo customer portal link (payment history, invoices). Dodo's
// portal does NOT authenticate the visitor — anyone with the link
// sees that customer's billing — so it must only ever be minted
// for the customer id on the signed-in user's OWN row, never
// from a client-supplied id. The id lands on users.dodo_customer_id
// with the first top-up; the subscriptions fallback covers
// accounts that got one before top-ups existed.
// ============================================================

export async function GET() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const sessionUser = getSessionUser(token);
  if (!sessionUser) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const own = db
    .prepare("SELECT dodo_customer_id FROM users WHERE id = ?")
    .get(sessionUser.id) as { dodo_customer_id: string | null } | undefined;
  let customerId = own?.dodo_customer_id ?? null;
  if (!customerId) {
    const sub = db
      .prepare(
        `SELECT dodo_customer_id FROM subscriptions
         WHERE user_id = ? AND dodo_customer_id IS NOT NULL
         ORDER BY updated_at DESC LIMIT 1`
      )
      .get(sessionUser.id) as { dodo_customer_id: string } | undefined;
    customerId = sub?.dodo_customer_id ?? null;
  }
  if (!customerId) {
    return NextResponse.json(
      { ok: false, error: "No billing profile yet — add credit first." },
      { status: 404 }
    );
  }

  try {
    const session = await getDodo().customers.customerPortal.create(customerId, {
      return_url: `${dashboardBaseUrl()}/billing`,
    });
    return NextResponse.json({ ok: true, url: session.link });
  } catch (err) {
    console.error("[billing] portal link failed:", (err as Error).message);
    return NextResponse.json(
      { ok: false, error: "Could not open the billing portal — try again." },
      { status: 502 }
    );
  }
}
