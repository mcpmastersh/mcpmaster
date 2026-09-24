import type { ToolCallOutcome } from "./openapi-call.ts";
import { SandboxToolError, type HostHandler } from "./sandbox.ts";

// "Code mode" — shared by every mcpmaster runtime's MCP endpoint (Cloud and
// the self-hosted packages/mcpmaster); see sandbox.ts for the why. list_tools
// advertises the single EXECUTE_TOOL below instead of every integration's
// tools, so the agent's context cost is constant no matter how many tools are
// connected. The snippet finds what it needs with
// `tools.search`/`tools.describe.tool` and calls it by path — the path is the
// tool's aggregated `fullName`, so blocking, prefix uniqueness and dispatch
// follow exactly the direct-call rules.
//
// No runtime-specific imports, so every runtime (and plain node:test) can load it.

export const EXECUTE_TOOL_NAME = "execute";

const SEARCH_DEFAULT_LIMIT = 10;
const SEARCH_MAX_LIMIT = 25;
const SEARCH_DESCRIPTION_CHARS = 200;

/** The fields code mode reads from an aggregated tool, in either runtime. */
export type CodeModeTool = {
  fullName: string;
  toolName: string;
  description: string;
  inputSchema: unknown;
  integrationName: string;
};
type Tool = CodeModeTool;

export function toolPrefix(fullName: string): string {
  // Prefixes are slugified (tool-naming.ts) and contain neither "." nor "_".
  // mcpmaster Cloud joins prefix and tool with "." ("github.list_issues"); the
  // self-hosted runtime uses "_" ("github_list_issues") because several model
  // APIs reject dots in tool names. Either way the first separator ends the
  // prefix, even if the tool's own name contains one.
  const dot = fullName.indexOf(".");
  if (dot !== -1) return fullName.slice(0, dot);
  const underscore = fullName.indexOf("_");
  return underscore === -1 ? fullName : fullName.slice(0, underscore);
}

/** The one tool list_tools advertises. Its size is O(integrations), not O(tools). */
export function buildExecuteTool(tools: Tool[]) {
  const connections = new Map<string, { name: string; count: number }>();
  for (const tool of tools) {
    const prefix = toolPrefix(tool.fullName);
    const entry = connections.get(prefix) ?? { name: tool.integrationName, count: 0 };
    entry.count += 1;
    connections.set(prefix, entry);
  }
  const connectionLines = [...connections.entries()]
    .map(([prefix, { name, count }]) => `- ${prefix}: ${name} (${count} tools)`)
    .join("\n");

  return {
    name: EXECUTE_TOOL_NAME,
    description: [
      "Execute TypeScript in a sandboxed runtime with access to configured API tools.",
      "",
      "## Workflow",
      "",
      "1. const { items } = await tools.search({ query });",
      "2. const path = items[0]?.path;",
      "3. const details = await tools.describe.tool({ path });",
      "4. const result = await tools[path](input);",
      "",
      "The code is an async function body: use await, and `return` the value you want back.",
      "Only the returned value (and console.log output) is sent back, so filter and",
      "summarize large API responses in code. `tools.search` accepts { query, prefix?, limit? }.",
      "There is no network, filesystem or fetch — only `tools`.",
      "",
      "## Available connection prefixes",
      "",
      connectionLines || "- (no integrations are connected yet)",
    ].join("\n"),
    inputSchema: {
      type: "object" as const,
      properties: {
        code: { type: "string", description: "TypeScript function body to run. Use `return` for the result." },
      },
      required: ["code"],
    },
  };
}

function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

export function searchTools(tools: Tool[], args: unknown) {
  const { query, prefix, limit } = (args ?? {}) as { query?: unknown; prefix?: unknown; limit?: unknown };
  const wanted = terms(typeof query === "string" ? query : "");
  const scoped = typeof prefix === "string" && prefix ? tools.filter((t) => toolPrefix(t.fullName) === prefix) : tools;
  const max = Math.min(
    SEARCH_MAX_LIMIT,
    Math.max(1, typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : SEARCH_DEFAULT_LIMIT),
  );

  const scored = scoped
    .map((tool) => {
      if (wanted.length === 0) return { tool, score: 1 };
      const name = tool.toolName.toLowerCase();
      const scope = `${toolPrefix(tool.fullName)} ${tool.integrationName}`.toLowerCase();
      const description = tool.description.toLowerCase();
      let score = 0;
      for (const term of wanted) {
        if (name === term) score += 5;
        else if (name.includes(term)) score += 3;
        if (scope.includes(term)) score += 2;
        if (description.includes(term)) score += 1;
      }
      return { tool, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.fullName.localeCompare(b.tool.fullName));

  return {
    total: scored.length,
    items: scored.slice(0, max).map(({ tool }) => ({
      path: tool.fullName,
      description:
        tool.description.length > SEARCH_DESCRIPTION_CHARS
          ? `${tool.description.slice(0, SEARCH_DESCRIPTION_CHARS)}…`
          : tool.description,
    })),
  };
}

function pathArg(args: unknown): string {
  const path = (args as { path?: unknown } | null)?.path;
  if (typeof path !== "string" || !path) throw new SandboxToolError("A tool `path` is required");
  return path;
}

export function describeTool(tools: Tool[], args: unknown) {
  const path = pathArg(args);
  const tool = tools.find((t) => t.fullName === path);
  if (!tool) throw new SandboxToolError(`Unknown tool: ${path}`);
  return { path: tool.fullName, description: tool.description, inputSchema: tool.inputSchema };
}

// A tool's text result, handed to the snippet as data when it is JSON (almost
// every integration returns JSON) so the snippet can filter it directly.
function parseToolText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export type CodeModeDeps<T extends Tool> = {
  tools: T[];
  /**
   * Runs once per tool invocation, before dispatch — rate limiting, usage
   * metering. Throw a SandboxToolError to refuse the call.
   */
  beforeCall: (tool: T) => Promise<void>;
  callTool: (tool: T, input: Record<string, unknown>) => Promise<ToolCallOutcome>;
  /** Runs after each invocation with its outcome — the audit trail. */
  afterCall: (tool: T, input: Record<string, unknown>, outcome: ToolCallOutcome, latencyMs: number) => void;
};

/** The sandbox bridge: `search`, `describe`, and `call` over the connected tools. */
export function createCodeModeHandler<T extends Tool>(deps: CodeModeDeps<T>): HostHandler {
  return async (op, args) => {
    if (op === "search") return searchTools(deps.tools, args);
    if (op === "describe") return describeTool(deps.tools, args);
    if (op !== "call") throw new SandboxToolError("Unsupported operation");

    const path = pathArg(args);
    const tool = deps.tools.find((t) => t.fullName === path);
    if (!tool) throw new SandboxToolError(`Unknown tool: ${path}. Use tools.search({ query }) to find tool paths.`);
    const rawInput = (args as { input?: unknown }).input;
    const input =
      rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) ? (rawInput as Record<string, unknown>) : {};

    await deps.beforeCall(tool);
    const startedAt = Date.now();
    const outcome = await deps.callTool(tool, input);
    deps.afterCall(tool, input, outcome, Date.now() - startedAt);
    // callTool's error copy is already translated for callers (dispatch.ts).
    if (!outcome.ok) throw new SandboxToolError(outcome.error);
    return parseToolText(outcome.text);
  };
}
