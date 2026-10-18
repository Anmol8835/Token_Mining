import DodoPayments from "dodopayments";

// ============================================================
// Dodo Payments client (server-only — imported from route
// handlers, never from client components; the API key must not
// ship to the browser).
//
// LAZY singleton: next build imports route modules without the
// runtime env, so the client is constructed on first use.
// DODO_PAYMENTS_API_KEY is env-specific (test vs live key), so a
// stale-cased environment value falls back to live_mode — the
// same default the proxy's lib/plans.js uses.
// ============================================================

export function dodoEnv(): "test_mode" | "live_mode" {
  return process.env.DODO_PAYMENTS_ENVIRONMENT === "test_mode" ? "test_mode" : "live_mode";
}

let _client: DodoPayments | null = null;

export function getDodo(): DodoPayments {
  if (_client) return _client;
  const bearerToken = process.env.DODO_PAYMENTS_API_KEY;
  if (!bearerToken) throw new Error("DODO_PAYMENTS_API_KEY is not set");
  _client = new DodoPayments({ bearerToken, environment: dodoEnv() });
  return _client;
}

/** Public base URL used for checkout return/cancel redirects. */
export function dashboardBaseUrl(): string {
  const raw = process.env.DODO_PAYMENTS_RETURN_URL; // e.g. https://api.steerosai.com
  return (raw || "http://localhost:3000").replace(/\/+$/, "");
}
