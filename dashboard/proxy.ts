import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

/**
 * Next 16 request proxy (the renamed middleware.ts convention —
 * exports a function named `proxy`).
 *
 * Every /api/server/* request is rewritten to the Express backend by
 * next.config.ts. This proxy injects the admin token server-side so
 * it never ships in browser JS: clients talk to the dashboard, the
 * dashboard talks to the backend.
 *
 * The dashboard is PUBLIC for now. When auth is added later, gate on
 * a session cookie here — this is the single chokepoint every
 * backend call passes through.
 *
 * `headers.set` overwrites any client-supplied x-admin-token too.
 */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  const token = process.env.ADMIN_TOKEN;
  if (token) headers.set("x-admin-token", token);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: "/api/server/:path*",
};
