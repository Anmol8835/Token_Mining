// ============================================================
// Tool pruning + deferred loading (Claude Code-style)
//
// Providers enforce hard caps on the `tools` array length (OpenAI
// 128, DeepSeek 128, Gemini 128; Anthropic 512). When a request
// carries more tools than the serving provider accepts:
//
//   1. Only an ACTIVE WORKING SET stays inline: essential built-ins
//      (Bash/Read/Edit/Write/Glob/Grep/Agent), tools already
//      discovered this conversation, plus one ToolSearch meta-tool.
//   2. The rest are compressed into a deferred catalog appended to
//      the system text (<available-deferred-tools> — bare names +
//      one-line descriptions).
//   3. When the model needs a deferred tool it calls ToolSearch;
//      index.js intercepts that call server-side, resolves the full
//      schema from the ORIGINAL tool list, records the discovery,
//      and re-drives the model — the client never sees the exchange.
//
// If the client already sends its own ToolSearch tool (client-side
// deferred loading), the proxy passes everything through untouched.
// ============================================================

const META_TOOL_NAME = "ToolSearch";

const ESSENTIAL_TOOLS = new Set([
  "Bash",
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "Agent",
]);

const META_TOOL = {
  name: META_TOOL_NAME,
  description:
    "Search deferred tools by name or description and retrieve a full definition. " +
    "Use when you need a tool that is not in your tool list but might exist.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Tool name or keywords, e.g. 'select:mcp__neon__execute_sql' or 'database query'",
      },
    },
    required: ["query"],
  },
};

/** True when the client manages deferred loading itself. */
function hasClientToolSearch(body) {
  return !!(body.tools && body.tools.some((t) => t.name === META_TOOL_NAME));
}

/** Truncate a tool description to one short line for the catalog. */
function oneLineDescription(tool) {
  const desc = (tool.description || "").split("\n")[0].trim();
  return desc ? `: ${desc.slice(0, 100)}` : "";
}

/**
 * Build the compact deferred catalog block for the system text.
 * Bare names + one-line descriptions, hard-truncated.
 */
function buildDeferredCatalog(deferred, limit = 4000) {
  const lines = deferred.map((t) => `- ${t.name}${oneLineDescription(t)}`);
  let text = "<available-deferred-tools>\n" + lines.join("\n") + "\n</available-deferred-tools>";
  if (text.length > limit) {
    text = text.slice(0, limit) + "\n…" + `(${deferred.length} deferred tools total)`;
  }
  return text;
}

/** Append a text block to an Anthropic-format system field. */
function appendSystemText(system, text) {
  if (typeof system === "string") {
    return `${system}\n\n${text}`;
  }
  const blocks = Array.isArray(system) ? [...system] : [];
  return [...blocks, { type: "text", text }];
}

/**
 * Prune a request body for a capped provider.
 *
 * @param {object} body - original Anthropic-format request body
 * @param {object} caps - per-provider max tool counts (router.maxTools)
 * @param {string} provider - serving provider name
 * @param {Set<string>} discovered - tools already fetched this conversation
 * @returns {object|null} { prunedBody, deferredCount } or null when the
 *   request fits the cap (or the client manages pruning itself).
 */
function buildPrunedBody(body, caps, provider, discovered) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  if (tools.length === 0) return null;
  if (hasClientToolSearch(body)) return null; // client handles it

  const cap = caps?.[provider];
  if (!cap || tools.length <= cap) return null; // fits; meta-tool needs no slot

  const inlineLimit = cap - 1; // reserve one slot for ToolSearch

  const essential = tools.filter((t) => ESSENTIAL_TOOLS.has(t.name));
  const discoveredTools = tools.filter((t) => discovered.has(t.name));
  const rest = tools.filter(
    (t) => !ESSENTIAL_TOOLS.has(t.name) && !discovered.has(t.name)
  );

  const inline = [];
  const seen = new Set();
  for (const t of [...essential, ...discoveredTools, ...rest]) {
    if (seen.has(t.name)) continue;
    if (inline.length >= inlineLimit) break;
    inline.push(t);
    seen.add(t.name);
  }

  const inlineNames = new Set(inline.map((t) => t.name));
  const deferred = tools.filter((t) => !inlineNames.has(t.name));
  if (deferred.length === 0) return null; // nothing actually deferred

  const prunedBody = {
    ...body,
    tools: [...inline, META_TOOL],
    system: appendSystemText(body.system, buildDeferredCatalog(deferred)),
  };

  console.log(
    `  ✂️ tool pruning: ${tools.length} → ${inline.length} inline + ToolSearch ` +
    `(${deferred.length} deferred; provider ${provider} cap ${cap})`
  );

  return { prunedBody, deferredCount: deferred.length };
}

/** Extract the search query from a ToolSearch tool_use input. */
function searchQuery(toolUse) {
  const input = toolUse?.input;
  if (!input) return "";
  const raw = typeof input === "string" ? input : input.query || "";
  return String(raw).replace(/^select:/, "").trim().toLowerCase();
}

/**
 * Resolve a ToolSearch query against the ORIGINAL tool list.
 * Exact name match wins, then name-contains, then description scan.
 * @returns {object|null} the full tool definition
 */
function resolveToolSearch(body, toolUse) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const q = searchQuery(toolUse);
  if (!q) return null;

  const exact = tools.find((t) => t.name.toLowerCase() === q);
  if (exact) return exact;

  const contains = tools.find((t) => t.name.toLowerCase().includes(q));
  if (contains) return contains;

  const byDesc = tools.find((t) =>
    (t.description || "").toLowerCase().includes(q)
  );
  return byDesc || null;
}

/**
 * The synthetic tool_result handed back to the model: the resolved
 * tool's full definition, compact JSON, so the model can call it
 * with correct arguments on the next pass.
 */
function buildToolResultBlock(toolUse, toolDef) {
  return {
    type: "tool_result",
    tool_use_id: toolUse.id,
    content: [
      {
        type: "text",
        text:
          "Full definition for " + toolDef.name + ":\n" +
          JSON.stringify(toolDef, null, 1),
      },
    ],
  };
}

module.exports = {
  META_TOOL_NAME,
  META_TOOL,
  buildPrunedBody,
  resolveToolSearch,
  buildToolResultBlock,
  hasClientToolSearch,
};
