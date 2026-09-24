import { validatedFetch, EgressBlockedError } from "./egress.ts";
import { parse as parseYaml } from "yaml";
import type { ToolParam } from "./tool-param.ts";

// Translates an `openapi` integration's spec into the tool list the MCP
// endpoint serves: fetch and parse the spec once, then turn each operation
// into one MCP tool (name, description, and a JSON-schema input from the
// operation's parameters and request body). OpenAPI 3.x, in JSON or YAML.

export type IntegrationTool = {
  name: string;
  description: string;
  method: string;
  path: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
  /**
   * Which part of the HTTP request each argument belongs to, resolved ONCE
   * here at translation time.
   *
   * This is the same information the `"x-in"` tag carries on each property,
   * but pre-extracted into a plain list: dispatch used to re-walk
   * `inputSchema.properties` and re-read that tag on every single tool call —
   * a full pass over the same cached payload per call, on the hot path. The
   * tag is immutable for the life of the integration, so deriving it per call
   * bought nothing.
   *
   * OPTIONAL ON PURPOSE. Tool lists cached before this field existed are read
   * back verbatim — a required field would type-check while silently leaving
   * every already-stored integration with `params: undefined` and no parameter
   * interpolation at all. Dispatch therefore falls back to walking the schema
   * whenever this is absent, so older and newer caches both work; a re-sync
   * (or any new integration) gets the fast path.
   */
  params?: ToolParam[];
};

type OpenApiParameter = {
  name: string;
  in: "query" | "path" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: Record<string, unknown>;
};

type OpenApiOperation = {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: OpenApiParameter[];
  requestBody?: {
    content?: Record<string, { schema?: Record<string, unknown> }>;
  };
};

type OpenApiDocument = {
  openapi?: string;
  servers?: { url: string }[];
  paths?: Record<string, Record<string, OpenApiOperation>>;
};

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

// Two MCP tools can't collide on a name within one integration (they're
// namespaced by integration name on top of this at aggregation time) —
// operationId is used when present, otherwise a
// deterministic slug from the method+path so every operation still gets a
// stable, unique name across re-syncs.
function toolName(method: string, path: string, operationId?: string): string {
  if (operationId) return operationId;
  return `${method}_${path}`
    .replace(/[{}]/g, "")
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function operationToTool(method: string, path: string, op: OpenApiOperation): IntegrationTool {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  // The pre-resolved routing list dispatch consumes. Only the locations
  // dispatch actually interpolates are recorded — a `cookie` parameter is
  // still exposed in the schema (it's part of the operation's real
  // signature) but has no request slot in callOpenApiTool, so listing it here
  // would imply a handling that doesn't exist.
  const params: ToolParam[] = [];

  for (const param of op.parameters ?? []) {
    properties[param.name] = {
      ...(param.schema ?? { type: "string" }),
      description: param.description,
      "x-in": param.in,
    };
    if (param.required) required.push(param.name);
    if (param.in === "path" || param.in === "query" || param.in === "header") {
      params.push({ name: param.name, in: param.in });
    }
  }

  const bodySchema = op.requestBody?.content?.["application/json"]?.schema;
  if (bodySchema && typeof bodySchema === "object") {
    properties.body = { ...bodySchema, "x-in": "body" };
    params.push({ name: "body", in: "body" });
  }

  return {
    name: toolName(method, path, op.operationId),
    description: op.description || op.summary || `${method.toUpperCase()} ${path}`,
    method: method.toUpperCase(),
    path,
    inputSchema: { type: "object", properties, required },
    params,
  };
}

export type OpenApiTranslationResult =
  | { ok: true; tools: IntegrationTool[]; baseUrl: string }
  | { ok: false; error: string };

// Real-world OpenAPI documents (e.g. openai/openai-openapi's ~4 MiB spec) can
// comfortably exceed validatedFetch's default 2 MiB per-call bound. This
// fetch only runs as one-time work when an integration is added or re-synced
// — never during a live tool call — so a larger bound here costs a few extra
// megabytes of memory once, not added latency or attack surface on the hot
// path. Still bounded, still going through the same SSRF-mitigated helper.
const SPEC_FETCH_MAX_BYTES = 16 * 1024 * 1024; // 16 MiB

// Fetches and parses the spec through validatedFetch — never call fetch()
// on specUrl directly.
export async function fetchAndTranslateOpenApiSpec(specUrl: string): Promise<OpenApiTranslationResult> {
  let raw: string;
  try {
    const response = await validatedFetch(specUrl, {
      headers: { Accept: "application/json, application/yaml;q=0.9, */*;q=0.8" },
      maxBytes: SPEC_FETCH_MAX_BYTES,
    });
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, error: `Spec URL returned HTTP ${response.status}` };
    }
    raw = response.text;
  } catch (err) {
    return { ok: false, error: err instanceof EgressBlockedError ? err.message : "Could not fetch spec" };
  }

  const result = translateOpenApiDocument(raw);
  // A relative servers[0].url ("/api/v3", common in real specs) is relative
  // to the spec's own location, per the OpenAPI 3 spec.
  if (result.ok && !/^https?:\/\//i.test(result.baseUrl)) {
    try {
      return { ...result, baseUrl: new URL(result.baseUrl, specUrl).toString() };
    } catch {
      return { ok: false, error: "Spec's servers[0].url isn't a usable URL" };
    }
  }
  return result;
}

// Parses YAML with the core schema only (no custom tags, no merge keys) and a
// bounded alias count, so a hostile spec can't use YAML's own features to
// construct objects or expand a "billion laughs" alias bomb.
function parseSpec(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // Not JSON — fall through to YAML.
  }
  try {
    return parseYaml(raw, { schema: "core", merge: false, maxAliasCount: 100 });
  } catch {
    return undefined;
  }
}

/**
 * The pure half of the translator: spec text in, tools out. Used by the
 * fetch path above and by the self-hosted runtime for a spec read from a
 * local file.
 */
export function translateOpenApiDocument(raw: string): OpenApiTranslationResult {
  const parsed = parseSpec(raw);
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "Spec is not valid JSON or YAML" };
  }
  const doc = parsed as OpenApiDocument;

  if (typeof doc.openapi !== "string" || !doc.openapi.startsWith("3")) {
    return { ok: false, error: "Only OpenAPI 3.x documents are supported" };
  }

  const baseUrl = doc.servers?.[0]?.url;
  if (!baseUrl) {
    return { ok: false, error: "Spec has no servers[0].url to call operations against" };
  }

  const tools: IntegrationTool[] = [];
  for (const [path, methods] of Object.entries(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const op = methods[method];
      if (op) tools.push(operationToTool(method, path, op));
    }
  }

  if (tools.length === 0) {
    return { ok: false, error: "Spec has no operations to turn into tools" };
  }

  return { ok: true, tools, baseUrl };
}
