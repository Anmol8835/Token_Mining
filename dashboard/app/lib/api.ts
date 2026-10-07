// Types for the backend API (/metrics and /config/dashboard on the
// Express server) plus tiny fetch helpers. All requests go through the
// /api/server rewrite in next.config.ts.

export type RecordRow = {
  ts: number;
  prompt: string;
  primary_task: string | null;
  domain: string | null;
  complexity: string | null;
  risk: string | null;
  model_type: string | null;
  review: boolean;
  confidence: number | null;
  source: string | null;
  classifierMs: number | null;
  selectedModel: string | null;
  winnerScore: number | null;
  candidateCount: number;
  providerMs: number | null;
  costUsd: number | null;
  classifierCostUsd: number | null;
  cacheReadTokens: number | null;
  compactionDroppedMsgs: number | null;
  compactionCostUsd: number | null;
  tokens: number | null;
  ok: boolean | null;
  scores: [string, number][] | null;
  reason: string | null;
};

export type Baseline = {
  modelId: string;
  label: string;
  hypotheticalCost: number;
  actualCost: number;
  savedUsd: number;
  savedPct: number | null;
  requests?: number;
  inputPer1M?: number;
  outputPer1M?: number;
};

export type EvalSummary = {
  generatedAt?: string;
  total?: number;
  passed?: number;
  accuracy?: number | null;
  byField?: { field: string; passed: number; total: number; accuracy: number }[];
  failures?: {
    id?: string;
    prompt: string;
    expected: Record<string, unknown>;
    got: Record<string, unknown>;
    fails: { field: string; got: unknown; want: unknown }[];
  }[];
};

export type MetricsSnapshot = {
  startedAt: number;
  uptimeSec: number;
  counts: {
    requests: number;
    providerFallbacks: number;
    providerFailures: number;
    llmFallbacks: number;
    humanReviewFlags: number;
  };
  averages: {
    latencyMs: number;
    classifierMs: number;
    confidence: number;
  };
  totals: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    classifierCostUsd: number;
    classifierInputTokens: number;
    classifierOutputTokens: number;
    classifierCalls: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cacheSavingsUsd: number;
    compactionCostUsd: number;
    compactionCalls: number;
    compactionTokensSaved: number;
    totalCostUsd: number;
  };
  global: {
    since: string;
    requests: number;
    provider: {
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      cacheSavingsUsd: number;
    };
    classifier: { costUsd: number; inputTokens: number; outputTokens: number; calls: number };
    compaction: { costUsd: number; calls: number };
    totalCostUsd: number;
    inputTokens: number;
    outputTokens: number;
    baselines: Baseline[];
  };
  byTask: { key: string; value?: number; count?: number }[];
  byModel: { key: string; count?: number; costUsd?: number }[];
  byModelType: { key: string; value?: number; count?: number }[];
  byRisk: { key: string; value?: number; count?: number }[];
  byMode: { key: string; value?: number; count?: number }[];
  candidateScores: { model: string; avgScore: number; scored: number }[];
  costBaselines: Baseline[];
  eval: EvalSummary | null;
  recent: RecordRow[];
  allRecords: RecordRow[];
  /**
   * Who the backend resolved this snapshot for. "operator" = the
   * global console (all accounts); "user" = scoped to the signed-in
   * account. Operator-only actions (demo/reset/eval) are hidden from
   * plain users.
   */
  viewer?: { role: "user" | "operator"; userId?: string | null };
};

export type ModelCatalogEntry = {
  id: string;
  provider: string;
  apiModelId: string;
  cost: {
    inputPer1M: number;
    outputPer1M: number;
    peakMultiplier?: number;
    cacheHitInputPer1M?: number;
    cacheReadInputPer1M?: number;
    cacheWriteInputPer1M?: number;
  };
  capabilities: {
    maxInputTokens: number;
    maxOutputTokens: number;
    vision: boolean;
    toolUse: boolean;
    streaming: boolean;
  };
  profile: {
    complexity: "low" | "high";
    modelTypes: string[];
    tasks: string[];
    strengths: string[];
    costTier: "budget" | "low" | "standard" | "premium";
    latencyTier: "fast" | "normal" | "quality";
  };
  available: boolean;
  enabled: boolean;
};

export type BenchmarkReport = {
  generatedAt: string;
  evalPromptCount: number;
  sections: {
    category: string;
    n: number;
    routerQuality: number;
    qualityN: number;
    cost: number;
    flagshipCost: number;
    middleCost: number;
    errors: number;
  }[];
  totals: {
    routerCost: number;
    allFlagshipCost: number;
    allMiddleCost: number;
    savingsVsFlagshipPct: number;
    savingsVsMiddlePct: number;
  };
};

export type DashboardConfig = {
  models: ModelCatalogEntry[];
  prefs: { routingMode: string | null; disabledModels: string[] };
  // Models the operator disabled globally; locked for user accounts.
  // Optional: absent from older backends.
  adminDisabledModels?: string[];
  routingModes: string[];
  classifier: { mode: string; modes: string[] };
  policy: { version?: number; generatedAt?: string; rules: unknown[] } | null;
  benchmark: BenchmarkReport | null;
};

export type ApiKeyEntry = {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  lastUsedRoute: string | null;
};

export type ApiKeyList = { keys: ApiKeyEntry[] };

/**
 * Per-account durable totals from the dashboard's own /api/totals
 * route (reads usage_daily in the shared SQLite file — written by
 * the proxy's 30s persist tick).
 */
export type TotalsSnapshot = {
  ok: true;
  user: { id: string; email: string; name: string | null };
  totals: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
    classifierCostUsd: number;
    baselineCostUsd: number;
    actualCostUsd: number;
    savedUsd: number;
    savedPct: number | null;
  };
  daily: { day: string; requests: number; costUsd: number; savedUsd: number }[];
};

export async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`backend responded ${res.status}`);
  return res.json() as Promise<T>;
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((json as { error?: string }).error || `backend responded ${res.status}`);
  }
  return json as T;
}

export async function deleteJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { method: "DELETE" });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((json as { error?: string }).error || `backend responded ${res.status}`);
  }
  return json as T;
}

export type AuthUser = { id: string; email: string; name: string | null };

/** Shape of /api/billing/state (dashboard-local route). */
export type BillingState = {
  ok: true;
  status: "active" | "pending" | "suspended";
  planId: string;
  planExpiry: number | null;
  effective: boolean;
  plan: {
    id: string;
    name: string;
    priceUsd: number;
    monthlyQuotaUsd: number;
    tiers: string[];
  } | null;
  subscription: { id: string; status: string; currentPeriodEnd: number | null } | null;
  usage: { monthStart: string; usedUsd: number; quotaUsd: number; unlimited: boolean };
  checkoutConfigured: boolean;
};

export const getMetrics = () => fetchJson<MetricsSnapshot>("/api/server/metrics");
export const getConfig = () => fetchJson<DashboardConfig>("/api/server/config/dashboard");
export const getHealth = () =>
  fetchJson<{ status: string; models: { id: string }[] }>("/api/server/health");
export const getApiKeys = () => fetchJson<ApiKeyList>("/api/server/config/api-keys");
export const getTotals = () => fetchJson<TotalsSnapshot>("/api/totals");
export const getBillingState = () => fetchJson<BillingState>("/api/billing/state");
export const postCheckout = (planId?: string) =>
  postJson<{ ok: true; checkoutUrl: string; sessionId: string }>("/api/billing/checkout", {
    planId,
  });
export const getPortalUrl = () => fetchJson<{ ok: true; url: string }>("/api/billing/portal");
export const getMe = () => fetchJson<{ ok: true; user: AuthUser }>("/api/auth/me");
// The backend attributes the key to the signed-in session — no
// userId is sent from the client (a client-supplied one is ignored
// for non-operators; an unlinked key 402s key_not_linked once
// PLAN_ENFORCEMENT is on).
export const createApiKey = (name: string) =>
  postJson<{ ok: true; key: ApiKeyEntry; apiKey: string }>("/api/server/config/api-keys", {
    name,
  });
