import { validatedFetch, EgressBlockedError } from "./egress.ts";

// A remote `mcp` integration: connect as an MCP client to the server URL,
// call its own `tools/list` once (the result is cached by the caller), and
// proxy `tools/call` through 1:1. It's a pass-through, not a translation: no
// tool name or input-schema rewriting happens here (unlike `openapi`). The
// runtime namespaces the server's tools by integration name, the same way it
// does every other type.
//
// This speaks the MCP Streamable HTTP transport's JSON-RPC-over-HTTP wire
// format directly with validatedFetch, rather than pulling in
// `@modelcontextprotocol/sdk`'s own `Client`/transport: that SDK transport
// calls `fetch()` itself, which would bypass validatedFetch (egress.ts), the
// one SSRF-mitigated path every outbound call to a user-supplied URL must go
// through. A second, one-off egress path is exactly what that rule forbids.
//
// Both Streamable HTTP response shapes are accepted: a single JSON body, or a
// `text/event-stream` body carrying the JSON-RPC response as an SSE `data:`
// event (what most hosted MCP servers answer with). The SSE body is still read
// through validatedFetch, so it is bounded by the same byte cap and timeout as
// any other response — we never hold a stream open.

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "mcpmaster", version: "1.0.0" };

// Reading the tool list is one-time work when an integration is added or
// re-synced, not part of a live call, so a larger bound than the per-call
// default is an acceptable memory cost (same reasoning as openapi.ts's
// SPEC_FETCH_MAX_BYTES).
const LIST_TOOLS_MAX_BYTES = 16 * 1024 * 1024; // 16 MiB
// call_tool dispatch is live, in the hot path — keep validatedFetch's tight
// default (2 MiB) rather than overriding it here.

export type McpProxyTool = {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required: string[] };
};

const ACCEPT = "application/json, text/event-stream";

type JsonRpcResponse<T> =
  | { jsonrpc: "2.0"; id: number; result: T }
  | { jsonrpc: "2.0"; id: number; error: { code: number; message: string } };

/**
 * Extracts the JSON-RPC response with id `id` from either a plain JSON body or
 * an SSE body. Exported for tests. Returns null when nothing matching parses —
 * the caller turns that into a translated error, never the raw body.
 */
export function parseJsonRpcResponse<T>(text: string, contentType: string | null, id: number): JsonRpcResponse<T> | null {
  const isResponse = (value: unknown): value is JsonRpcResponse<T> =>
    typeof value === "object" && value !== null && (value as { id?: unknown }).id === id &&
    ("result" in value || "error" in value);

  if (!contentType?.toLowerCase().includes("text/event-stream")) {
    try {
      const parsed: unknown = JSON.parse(text);
      return isResponse(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  // SSE: events are separated by a blank line; an event's data is the
  // concatenation of its `data:` lines joined by "\n" (WHATWG SSE spec).
  for (const event of text.replace(/\r\n?/g, "\n").split("\n\n")) {
    const data = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      const parsed: unknown = JSON.parse(data);
      if (isResponse(parsed)) return parsed;
    } catch {
      // A non-JSON event (a keep-alive comment, a ping) — keep looking.
    }
  }
  return null;
}

async function jsonRpcCall<T>(
  serverUrl: string,
  method: string,
  params: Record<string, unknown>,
  opts: { id: number; sessionId?: string | null; headers?: Record<string, string>; maxBytes?: number },
): Promise<{ result: T; sessionId: string | null }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: ACCEPT,
    ...(opts.headers ?? {}),
  };
  if (opts.sessionId) headers["Mcp-Session-Id"] = opts.sessionId;

  const response = await validatedFetch(serverUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: opts.id, method, params }),
    maxBytes: opts.maxBytes,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new EgressBlockedError(`MCP server returned HTTP ${response.status}`);
  }

  const body = parseJsonRpcResponse<T>(response.text, response.headers.get("content-type"), opts.id);
  if (!body) {
    throw new EgressBlockedError("MCP server did not return a valid JSON-RPC response");
  }
  if ("error" in body) {
    // Never surface the remote server's own error text verbatim (same posture
    // as callOpenApiTool's HTTP-failure branch): it can carry internal URLs
    // or credential hints. This is a
    // transport/protocol-level failure, not the tool's own substantive
    // answer (unlike a `tools/call` result with `isError: true`, which is
    // passed through as-is since that IS the tool's designed response).
    throw new EgressBlockedError(`MCP server rejected that call (code ${body.error.code})`);
  }

  return { result: body.result, sessionId: response.headers.get("mcp-session-id") };
}

// Sends a JSON-RPC *notification* (no `id`, no response body expected) — used
// for `notifications/initialized`, which the MCP spec requires after a
// successful `initialize` and before any other request.
async function jsonRpcNotify(
  serverUrl: string,
  method: string,
  params: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<void> {
  await validatedFetch(serverUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: ACCEPT, ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", method, params }),
  }).catch(() => {
    // Best-effort — some servers don't require it for stateless tools/list
    // or tools/call, and we've already got what we need either way.
  });
}

// Runs the initialize handshake this transport requires before any other
// call, returning headers the caller should attach to subsequent requests
// (carrying the session id if the server assigned one). `maxBytes` is only
// ever raised above validatedFetch's tight hot-path default by the one-time
// translation caller below — callMcpProxyTool's live, per-request dispatch
// leaves it unset: never widen the bound for a live call.
async function initializeSession(
  serverUrl: string,
  authHeaders: Record<string, string>,
  maxBytes?: number,
): Promise<Record<string, string>> {
  const { sessionId } = await jsonRpcCall<{ protocolVersion: string }>(
    serverUrl,
    "initialize",
    {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    },
    { id: 1, headers: authHeaders, maxBytes },
  );

  const headers = { ...authHeaders, ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}) };
  await jsonRpcNotify(serverUrl, "notifications/initialized", {}, headers);
  return headers;
}

export type McpProxyTranslationResult =
  | { ok: true; tools: McpProxyTool[]; baseUrl: string }
  | { ok: false; error: string };

// Fetches the remote MCP server's own tool list through validatedFetch —
// never call fetch() on serverUrl directly. `authHeaders` carries the
// integration's stored credential (same bearer/api_key treatment as openapi),
// since some MCP servers gate even `tools/list` on it.
export async function fetchAndTranslateMcpServer(
  serverUrl: string,
  authHeaders: Record<string, string> = {},
): Promise<McpProxyTranslationResult> {
  try {
    const sessionHeaders = await initializeSession(serverUrl, authHeaders, LIST_TOOLS_MAX_BYTES);
    const { result } = await jsonRpcCall<{ tools: McpProxyTool[] }>(
      serverUrl,
      "tools/list",
      {},
      { id: 2, headers: sessionHeaders, maxBytes: LIST_TOOLS_MAX_BYTES },
    );

    const tools = result.tools ?? [];
    if (tools.length === 0) {
      return { ok: false, error: "That MCP server has no tools to offer" };
    }

    return { ok: true, tools, baseUrl: serverUrl };
  } catch (err) {
    return { ok: false, error: err instanceof EgressBlockedError ? err.message : "Could not reach that MCP server" };
  }
}

export type McpProxyCallOutcome =
  | { ok: true; text: string }
  | { ok: false; error: string };

// Live tool call: a 1:1 pass-through to the remote server's own tool of the
// same name. Re-runs the initialize handshake on every call rather than
// reusing a session, so the caller can be stateless (a serverless function,
// or a CLI process that exits after one call) with no connection to keep
// alive between calls.
export async function callMcpProxyTool(
  serverUrl: string,
  toolName: string,
  args: Record<string, unknown>,
  authHeaders: Record<string, string> = {},
): Promise<McpProxyCallOutcome> {
  try {
    const sessionHeaders = await initializeSession(serverUrl, authHeaders);
    const { result } = await jsonRpcCall<{
      content?: { type: string; text?: string }[];
      isError?: boolean;
    }>(serverUrl, "tools/call", { name: toolName, arguments: args }, { id: 2, headers: sessionHeaders });

    const text = (result.content ?? [])
      .map((part) => (part.type === "text" ? part.text ?? "" : ""))
      .filter(Boolean)
      .join("\n");

    if (result.isError) return { ok: false, error: text || "That tool call failed" };
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: err instanceof EgressBlockedError ? err.message : "Could not reach that MCP server" };
  }
}
