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
  routingModes: string[];
  policy: { version?: number; generatedAt?: string; rules: unknown[] } | null;
  benchmark: BenchmarkReport | null;
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

export const getMetrics = () => fetchJson<MetricsSnapshot>("/api/server/metrics");
export const getConfig = () => fetchJson<DashboardConfig>("/api/server/config/dashboard");
export const getHealth = () =>
  fetchJson<{ status: string; models: { id: string }[] }>("/api/server/health");
