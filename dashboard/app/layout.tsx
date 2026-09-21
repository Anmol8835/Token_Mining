import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Nav } from "@/app/components/nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Relay | LLM router console",
  description: "Cost, tokens and routing for the LLM API server.",
};

/**
 * Sets data-theme before first paint: localStorage, then the system
 * preference. The CSS token blocks in globals.css key off this.
 */
const themeScript = `
(function () {
  try {
    var stored = localStorage.getItem("relay-theme");
    var theme = stored || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.dataset.theme = theme;
  } catch (e) {
    document.documentElement.dataset.theme = "dark";
  }
})();
`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="flex min-h-full flex-col bg-page text-ink">
        <Nav />
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 sm:py-8 md:pl-[calc(15rem+1.5rem)]">
          {children}
        </main>
        <footer className="border-t border-line md:pl-60">
          <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 text-xs text-ink-3 sm:px-6">
            <span>Relay console for the LLM router.</span>
            <span className="tnum">Port 8002 proxy</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
