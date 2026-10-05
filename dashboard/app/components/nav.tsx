"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowsSplit, CreditCard, Cube, Gauge, Key, ListDashes, Shuffle, SignOut } from "@phosphor-icons/react";
import { usePoll } from "@/app/lib/use-poll";
import { ThemeToggle } from "@/app/components/theme-toggle";

const LINKS = [
  { href: "/", label: "Overview", icon: Gauge },
  { href: "/models", label: "Models", icon: Cube },
  { href: "/routing", label: "Routing", icon: Shuffle },
  { href: "/activity", label: "Activity", icon: ListDashes },
  { href: "/api-keys", label: "API Keys", icon: Key },
  { href: "/billing", label: "Billing", icon: CreditCard },
];

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

/**
 * Console navigation. Desktop: fixed 240px sidebar rail (surface fill,
 * hairline edge, links with icons, status + theme at the foot). Mobile:
 * the top bar collapses to a single sticky header with an inline link
 * row, status hidden below sm.
 */
export function Nav({ user = null }: { user?: { email: string; name: string | null } | null }) {
  const pathname = usePathname();
  const { data: health, stale } = usePoll<{ status: string }>("/api/server/health", 5000);
  const online = health?.status === "ok";
  const connecting = !health && !stale;

  // Session cookie is httpOnly — sign-out deletes it server-side,
  // then a full reload lands on /login (proxy.ts redirects).
  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.href = "/login";
  }

  return (
    <>
      {/* Mobile top bar */}
      <header className="sticky top-0 z-10 flex h-16 items-center gap-3 border-b border-line bg-page px-4 md:hidden">
        <Link href="/" className="flex shrink-0 items-center gap-2 text-ink">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-on-accent">
            <ArrowsSplit size={16} weight="bold" />
          </span>
          <span className="text-[15px] font-semibold tracking-tight">Relay</span>
        </Link>
        <nav aria-label="Primary" className="flex min-w-0 items-center gap-1 overflow-x-auto">
          {LINKS.map((l) => {
            const active = isActive(pathname, l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={`whitespace-nowrap rounded-lg px-2.5 py-1.5 text-sm ${
                  active
                    ? "bg-surface-2 font-medium text-ink"
                    : "text-ink-2 hover:bg-surface-2/60 hover:text-ink"
                }`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {user && (
            <button
              onClick={signOut}
              title="Sign out"
              className="rounded-lg p-2 text-ink-3 hover:bg-surface-2/60 hover:text-ink"
            >
              <SignOut size={16} />
            </button>
          )}
          <ThemeToggle />
        </div>
      </header>

      {/* Desktop sidebar rail */}
      <aside className="fixed inset-y-0 left-0 z-10 hidden w-60 flex-col border-r border-line bg-surface md:flex">
        <div className="flex items-center gap-2 px-5 pb-3 pt-5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-on-accent">
            <ArrowsSplit size={16} weight="bold" />
          </span>
          <span className="text-[15px] font-semibold tracking-tight text-ink">Relay</span>
        </div>

        <nav aria-label="Primary" className="flex flex-1 flex-col gap-1 px-3 pt-2">
          {LINKS.map((l) => {
            const active = isActive(pathname, l.href);
            const Icon = l.icon;
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
                  active
                    ? "bg-surface-2 font-medium text-ink"
                    : "text-ink-2 hover:bg-surface-2/60 hover:text-ink"
                }`}
              >
                <Icon size={16} weight={active ? "bold" : "regular"} className="shrink-0" />
                {l.label}
              </Link>
            );
          })}
        </nav>

        {user && (
          <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-[13px] font-medium text-ink">
                {user.name || user.email}
              </p>
              <p className="truncate text-xs text-ink-3">{user.email}</p>
            </div>
            <button
              onClick={signOut}
              title="Sign out"
              className="shrink-0 rounded-lg p-1.5 text-ink-3 hover:bg-surface-2/60 hover:text-ink"
            >
              <SignOut size={16} />
            </button>
          </div>
        )}

        <div className="flex items-center justify-between border-t border-line px-4 py-3">
          <span className="flex items-center gap-1.5 text-xs text-ink-3">
            <span
              className={`h-2 w-2 rounded-full ${
                online
                  ? "bg-good"
                  : stale
                    ? "bg-critical"
                    : "motion-safe:animate-pulse bg-warning"
              }`}
              aria-hidden="true"
            />
            {online ? "online" : stale ? "offline" : connecting ? "connecting" : "online"}
          </span>
          <ThemeToggle />
        </div>
      </aside>
    </>
  );
}
