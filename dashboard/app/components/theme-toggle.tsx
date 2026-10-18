"use client";

import { MoonStars, Sun } from "@phosphor-icons/react";

/**
 * Light/dark switch. Theme state lives on <html data-theme> — resolved
 * pre-paint by the script in layout.tsx, persisted to localStorage here
 * — so this component is stateless and renders BOTH icons. The server
 * and client markup are identical (no hydration mismatch) and the
 * .theme-icon-* rules in globals.css show the one matching the current
 * data-theme attribute.
 */
export function ThemeToggle() {
  function toggle() {
    const next =
      document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("relay-theme", next);
    } catch {
      /* storage unavailable, system default next load */
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle color theme"
      className="hover-lift flex h-8 w-8 items-center justify-center rounded-lg border border-hairline text-ink-2 hover:text-ink"
    >
      <Sun size={16} weight="regular" className="theme-icon-sun" aria-hidden="true" />
      <MoonStars size={16} weight="regular" className="theme-icon-moon" aria-hidden="true" />
    </button>
  );
}
