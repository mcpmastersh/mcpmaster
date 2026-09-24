// Parameter routing for an `openapi` tool call — the pure half of
// callOpenApiTool (openapi-call.ts), kept separate so the two derivations
// below can be *proven* equivalent by execution rather than by reading two
// loops side by side.
//
// Background: dispatch used to re-walk `inputSchema.properties` and re-read
// each property's `"x-in"` tag on every single call — a full pass over the
// same cached payload per call. The tag is written once by the openapi
// translator and is immutable for the life of the integration, so the
// translator now pre-resolves it into a `params` list.
//
// THAT INTRODUCES A REAL HAZARD, which is why this module exists. Cached
// tool lists are stored verbatim, so tools translated before `params` existed
// have none — and they're only refreshed on a re-sync. Two code paths
// therefore have to agree:
//
//   newer tools → tool.params (pre-resolved at translation time)
//   older tools → params derived from the schema's "x-in" tags, as before
//
// If they ever disagree, a re-synced integration and an un-resynced one would
// route the same arguments to different places — a bug that only shows up for
// some installs, and only for parameters whose location changed. Making both
// paths produce the same shape and feeding that one shape to one routing
// function is what removes the possibility rather than testing for it.

import type { ToolParam } from "./tool-param.ts";

/** A tool's `inputSchema`, as much of it as routing needs. */
export type RoutableSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
};

/**
 * The original derivation: read each property's `"x-in"` tag.
 *
 * Deliberately permissive about *which* names appear (any property carrying a
 * recognised tag becomes a param), and deliberately silent about unknown
 * locations: a `cookie` parameter has no request slot in the routing below, so
 * it must not be turned into a param that claims a handling which doesn't
 * exist. That matches the original loop exactly, which had no `cookie` branch
 * and simply fell through.
 */
export function paramsFromSchema(schema: RoutableSchema): ToolParam[] {
  const params: ToolParam[] = [];
  for (const [name, property] of Object.entries(schema.properties)) {
    const location = (property as { "x-in"?: string })["x-in"];
    if (location === "path" || location === "query" || location === "header" || location === "body") {
      params.push({ name, in: location });
    }
  }
  return params;
}

export type RoutedRequest = {
  resolvedPath: string;
  query: [string, string][];
  headers: Record<string, string>;
  body: string | undefined;
};

/**
 * Interpolates `args` into the operation's `path`/query/headers/body according
 * to each param's location. This is the ONE implementation both the
 * pre-resolved and the fallback path go through.
 *
 * An argument absent from `args` is skipped entirely — a caller may legitimately
 * omit an optional parameter, and sending an empty string for it would be a
 * different (and wrong) request.
 */
export function routeOpenApiArgs(
  params: ToolParam[],
  args: Record<string, unknown>,
  path: string,
): RoutedRequest {
  let resolvedPath = path;
  const query = new URLSearchParams();
  const headers: Record<string, string> = { Accept: "application/json" };
  let body: string | undefined;

  for (const param of params) {
    const value = args[param.name];
    if (value === undefined) continue;

    if (param.in === "path") {
      resolvedPath = resolvedPath.replace(`{${param.name}}`, encodeURIComponent(String(value)));
    } else if (param.in === "query") {
      query.set(param.name, String(value));
    } else if (param.in === "header") {
      headers[param.name] = String(value);
    } else if (param.in === "body") {
      // Only a parameter actually named "body" carries the request body — the
      // translator tags exactly one such property (`properties.body`). A
      // differently-named property tagged "body" would fall through here, same
      // as it fell through the original `key === "body"` condition.
      if (param.name === "body") {
        body = JSON.stringify(value);
        headers["Content-Type"] = "application/json";
      }
    }
  }

  return { resolvedPath, query: [...query.entries()], headers, body };
}

/**
 * Resolves which params a tool routes by, preferring the pre-resolved list and
 * falling back to the schema for rows persisted before it existed.
 *
 * The `??` is on `null`/`undefined` only. An empty array is a *real answer*
 * ("this tool has no parameters") and must not trigger a schema walk — but that
 * walk would yield the same empty list anyway, so the distinction is about
 * honest intent, not a behavioural difference.
 */
export function resolveToolParams(
  preResolved: ToolParam[] | null | undefined,
  schema: RoutableSchema,
): ToolParam[] {
  return preResolved ?? paramsFromSchema(schema);
}
