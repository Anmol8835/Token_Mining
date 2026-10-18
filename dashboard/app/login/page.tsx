"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowsSplit } from "@phosphor-icons/react";
import { GoogleAuthLink } from "@/app/components/google-auth-link";

/**
 * Login — the only page reachable without a session (proxy.ts
 * redirects everything else here). Posts to /api/auth/login, which
 * sets the httpOnly session cookie; the reload lands on /.
 */
export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Google OAuth failures land back here as /login?error=google|suspended.
  // Read it once from the raw URL (useSearchParams would force a Suspense
  // boundary during prerender), then strip the param so a refresh doesn't
  // resurrect the banner.
  useEffect(() => {
    const reason = new URLSearchParams(window.location.search).get("error");
    if (!reason) return;
    setNotice(
      reason === "suspended"
        ? "This account is suspended. Contact support."
        : "Google sign-in failed. Please try again, or use email sign-in.",
    );
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) {
        setError(json.error || "Sign-in failed.");
        return;
      }
      router.replace("/");
      router.refresh();
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-full max-w-sm">
      <div className="mb-6 flex flex-col items-center gap-3 text-center">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-on-accent">
          <ArrowsSplit size={20} weight="bold" />
        </span>
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">
            Relay console
          </h1>
          <p className="mt-1 text-[13px] text-ink-3">
            Sign in to see usage, routing and cost savings.
          </p>
        </div>
      </div>

      <form
        onSubmit={onSubmit}
        className="rounded-xl border border-hairline bg-surface p-5 sm:p-6"
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-ink-2">Email</span>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@steerosai.com"
            className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
          />
        </label>

        <label className="mt-4 flex flex-col gap-1.5">
          <span className="text-xs font-medium text-ink-2">Password</span>
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
          />
        </label>

        {(error ?? notice) && (
          <p className="mt-4 rounded-lg border border-hairline bg-critical/10 px-3 py-2 text-[13px] text-critical">
            {error ?? notice}
          </p>
        )}

        {/* Shared Button is type="button" (action-only) — a form
            submit needs a real submit button, styled to match. */}
        <button
          type="submit"
          disabled={busy}
          className="hover-lift mt-5 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-on-accent disabled:pointer-events-none disabled:opacity-50"
        >
          {busy ? "Signing in..." : "Sign in"}
        </button>

        <GoogleAuthLink />

        <p className="mt-4 text-center text-xs text-ink-3">
          New here?{" "}
          <Link href="/signup" className="text-accent hover:underline">
            Create an account
          </Link>
        </p>
      </form>
    </div>
  );
}
