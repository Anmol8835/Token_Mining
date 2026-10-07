"use client";

import { siGoogle } from "simple-icons";

/**
 * "Continue with Google" — a plain <a> into the proxy's OAuth start
 * endpoint (the whole dance runs server-side on the VPS, then 302s
 * back into the dashboard). Same-origin by default, which is correct
 * in production: Caddy routes /auth/* to llm-proxy. In local dev,
 * set NEXT_PUBLIC_OAUTH_BASE=http://localhost:8002 and rebuild/restart.
 *
 * Deliberately an <a>, not the shared Button (which is type="button"),
 * and secondary styling so the email submit keeps visual weight.
 */
export function GoogleAuthLink() {
  const base = process.env.NEXT_PUBLIC_OAUTH_BASE ?? "";
  return (
    <a
      href={`${base}/auth/google/start`}
      className="hover-lift mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-sm font-medium text-ink"
    >
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="currentColor" aria-hidden="true">
        <path d={siGoogle.path} />
      </svg>
      Continue with Google
    </a>
  );
}
