import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getSessionUser, SESSION_COOKIE } from "@/lib/auth";

/**
 * Next 16 request proxy (the renamed middleware.ts convention —
 * exports a function named `proxy`). Runs on the Node.js runtime
 * (the Next 16 default), so it can reach the shared SQLite file.
 *
 * Two jobs:
 *
 * 1. Auth chokepoint — every request except /login, /signup and
 *    /api/auth/* needs a valid session cookie. Anonymous page loads
 *    redirect to /login; a logged-in visitor hitting /login or
 *    /signup bounces to /.
 *
 * 2. Admin-token injection — /api/server/* requests are rewritten
 *    to the Express backend by next.config.ts. The token is set
 *    server-side (AFTER the session check) so it never ships in
 *    browser JS and never reaches a logged-out client.
 *
 * Client fetches that outlive a session (30 days) get a redirect
 * to /login; pages then bounce through login anyway. Acceptable —
 * the fetch fails and the page shows its stale-state note.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Auth endpoints manage their own session handling (login sets
  // the cookie, logout deletes it) — gating them here would loop.
  if (pathname.startsWith("/api/auth/")) return NextResponse.next();

  // The container healthcheck probes this to verify dashboard→backend
  // reachability. /health is deliberately public on the backend
  // (status + model ids only), so exempt it here.
  if (pathname === "/api/server/health") return NextResponse.next();

  const user = getSessionUser(request.cookies.get(SESSION_COOKIE)?.value);

  if (!user) {
    if (pathname === "/login" || pathname === "/signup") return NextResponse.next();
    return NextResponse.redirect(new URL("/login", request.url));
  }
  if (pathname === "/login" || pathname === "/signup") {
    return NextResponse.redirect(new URL("/", request.url));
  }

  const headers = new Headers(request.headers);
  const token = process.env.ADMIN_TOKEN;
  if (token) headers.set("x-admin-token", token); // overwrites client-supplied
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Everything except the login page, the auth endpoints and static
  // assets (without exclusions the proxy would also run for
  // _next/static and public/ files). /signup is NOT excluded here —
  // the proxy lets anonymous visitors through to it and bounces
  // logged-in ones to /.
  matcher:
    "/((?!login|api/auth|_next/static|_next/image|favicon\\.ico|.*\\.(?:png|svg|ico|webmanifest|txt)$).*)",
};
