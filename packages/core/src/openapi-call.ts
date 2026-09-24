import { validatedFetch, EgressBlockedError } from "./egress.ts";
import { redactSecrets } from "./redact.ts";
import { resolveToolParams, routeOpenApiArgs, type RoutableSchema } from "./openapi-params.ts";
import type { ToolParam } from "./tool-param.ts";

// Live tool call for an `openapi` tool — the one implementation every
// runtime (mcpmaster Cloud and the self-hosted packages/mcpmaster) dispatches
// through, so no two of them can route the same arguments differently.
//
// Interpolates path/query/header/body parameters into a real HTTP request
// against the spec's servers[0].url + operation path, using the routing the
// translator pre-resolved (openapi.ts) or, for a tool cached before that
// existed, the schema's "x-in" tags. Every outbound call goes through
// validatedFetch — the one shared SSRF-mitigated egress path — never a
// one-off fetch().

export type ToolCallOutcome =
  | { ok: true; text: string }
  | { ok: false; error: string };

/** Headers to inject on an outbound call, plus the raw secret values used to build them. */
export type OutboundAuth = { headers: Record<string, string>; secrets: string[]; error?: string };

export type OpenApiCallTarget = {
  baseUrl: string | null | undefined;
  method: string | null | undefined;
  path: string | null | undefined;
  params?: ToolParam[] | null;
  inputSchema: RoutableSchema;
};

/**
 * `loadAuth` is lazy on purpose: a tool missing its call details fails before
 * any credential is loaded/decrypted, so a broken cached row never costs a
 * decrypt (or an OAuth token refresh) for a request that can't be sent anyway.
 */
export async function callOpenApiTool(
  tool: OpenApiCallTarget,
  args: Record<string, unknown>,
  loadAuth: () => Promise<OutboundAuth>,
): Promise<ToolCallOutcome> {
  const { method, path, baseUrl } = tool;
  if (!baseUrl || !method || !path) {
    return { ok: false, error: "This integration is missing its call details — try re-syncing it" };
  }

  const params = resolveToolParams(tool.params, tool.inputSchema);
  const { resolvedPath, query, headers, body } = routeOpenApiArgs(params, args, path);

  const { headers: injectedHeaders, secrets, error: authError } = await loadAuth();
  if (authError) return { ok: false, error: authError };
  Object.assign(headers, injectedHeaders);

  const url = new URL(resolvedPath.replace(/^\//, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  new URLSearchParams(query).forEach((value, key) => url.searchParams.set(key, value));

  try {
    const response = await validatedFetch(url.toString(), { method, headers, body });
    if (response.status >= 400) {
      // Never surface the downstream body/status detail verbatim — just
      // enough for the caller to know the call didn't work.
      return { ok: false, error: `That call failed (HTTP ${response.status})` };
    }
    // Scrub the exact credential string(s) we just injected before this ever
    // reaches the MCP caller (redact.ts).
    return { ok: true, text: redactSecrets(response.text, secrets) };
  } catch (err) {
    return { ok: false, error: err instanceof EgressBlockedError ? err.message : "Could not reach that integration" };
  }
}
