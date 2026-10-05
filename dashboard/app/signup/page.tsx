"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowsSplit } from "@phosphor-icons/react";

/**
 * Signup — open registration, exempt from the proxy.ts session
 * gate like /login. Creates a 'pending' account (no plan yet),
 * signs it in, and lands on /billing to subscribe.
 */
export default function Signup() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, name, password }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) {
        setError(json.error || "Sign-up failed.");
        return;
      }
      router.replace("/billing");
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
            Create your account
          </h1>
          <p className="mt-1 text-[13px] text-ink-3">
            Sign up, then pick a plan to start using the API.
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
            placeholder="you@example.com"
            className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
          />
        </label>

        <label className="mt-4 flex flex-col gap-1.5">
          <span className="text-xs font-medium text-ink-2">
            Name <span className="font-normal text-ink-3">(optional)</span>
          </span>
          <input
            type="text"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            maxLength={80}
            className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
          />
        </label>

        <label className="mt-4 flex flex-col gap-1.5">
          <span className="text-xs font-medium text-ink-2">Password</span>
          <input
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 8 characters"
            className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
          />
        </label>

        <label className="mt-4 flex flex-col gap-1.5">
          <span className="text-xs font-medium text-ink-2">Confirm password</span>
          <input
            type="password"
            required
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="••••••••"
            className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
          />
        </label>

        {error && (
          <p className="mt-4 rounded-lg border border-hairline bg-critical/10 px-3 py-2 text-[13px] text-critical">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="hover-lift mt-5 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-on-accent disabled:pointer-events-none disabled:opacity-50"
        >
          {busy ? "Creating account..." : "Create account"}
        </button>

        <p className="mt-4 text-center text-xs text-ink-3">
          Already have an account?{" "}
          <Link href="/login" className="text-accent hover:underline">
            Sign in
          </Link>
        </p>
      </form>
    </div>
  );
}
