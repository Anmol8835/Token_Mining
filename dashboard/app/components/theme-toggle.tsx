"use client";

import { useState } from "react";
import { MoonStars, Sun } from "@phosphor-icons/react";

/**
 * Light/dark switch. The <html data-theme> attribute is what the CSS
 * tokens key off; the pre-paint script in layout.tsx already resolved
 * the initial value (localStorage, then system preference), so the
 * lazy initializer just reads the attribute during hydration.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    typeof document !== "undefined" &&
    document.documentElement.dataset.theme === "light"
      ? "light"
      : "dark"
  );

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("relay-theme", next);
    } catch {
      /* storage unavailable, system default next load */
    }
    setTheme(next);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      suppressHydrationWarning
      className="hover-lift flex h-8 w-8 items-center justify-center rounded-lg border border-hairline text-ink-2 hover:text-ink"
    >
      {theme === "dark" ? <Sun size={16} weight="regular" /> : <MoonStars size={16} weight="regular" />}
    </button>
  );
}
