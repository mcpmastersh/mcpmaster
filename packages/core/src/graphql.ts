import { validatedFetch, EgressBlockedError } from "./egress.ts";

// Translates a `graphql` integration: introspect the endpoint's schema once
// (the result is cached by the caller), and turn a bounded set of top-level
// queries/mutations into MCP tools (arguments from the field's own arguments,
// result shape from its return type) — capped at a query depth/complexity we
// choose, so introspection can't hand anyone a tool that builds an
// arbitrarily expensive nested query.
//
// The caps are concrete numbers rather than "reasonable" in code. The rule,
// deliberately conservative:
// - Only top-level `Query`/`Mutation` fields become tools, capped at
//   MAX_TOOLS_PER_OPERATION each — no arbitrarily nested tool composition.
// - An argument is only exposed if it's a scalar/enum, a list of scalar/enum,
//   or a single level of an input object whose own fields are themselves
//   scalar/enum (or a list of them) — anything deeper is simply omitted from
//   that tool's input schema (the field becomes uncallable with that arg,
//   not an error) rather than expanded further.
// - A field's result selection only ever goes one level deep: for an object
//   return type, its own scalar/enum fields are selected (capped at
//   MAX_SELECTED_FIELDS), never a nested object's fields. A field whose
//   return type is an object with no scalar/enum fields to select — or an
//   interface/union — has nothing bounded to ask for and is skipped.
// This makes runaway query depth structurally impossible: every generated
// query is at most two levels deep (the field, and its flat scalar
// selection), regardless of how deeply nested the underlying schema is.

const MAX_TOOLS_PER_OPERATION = 25;
const MAX_SELECTED_FIELDS = 20;
// Introspection is one-time work when an integration is added or re-synced —
// same reasoning as openapi.ts's SPEC_FETCH_MAX_BYTES for the larger bound.
const INTROSPECTION_MAX_BYTES = 16 * 1024 * 1024; // 16 MiB

type TypeRef = {
  kind: string;
  name: string | null;
  ofType: TypeRef | null;
};

type GraphqlField = {
  name: string;
  description: string | null;
  args: { name: string; description: string | null; type: TypeRef }[];
  type: TypeRef;
};

type GraphqlType = {
  kind: string;
  name: string | null;
  fields: GraphqlField[] | null;
  inputFields: { name: string; description: string | null; type: TypeRef }[] | null;
  enumValues: { name: string }[] | null;
};

type IntrospectionResult = {
  data?: {
    __schema: {
      queryType: { name: string } | null;
      mutationType: { name: string } | null;
      types: GraphqlType[];
    };
  };
  errors?: { message: string }[];
};

// Five levels of ofType nesting covers every practically-occurring wrapper
// combination (e.g. [String!]! is NON_NULL -> LIST -> NON_NULL -> SCALAR) —
// the same depth graphql-js's own getIntrospectionQuery() uses.
const FULL_TYPE_REF_DEPTH = 4;
// Some GraphQL CDNs enforce a query-depth limit that the full introspection
// query exceeds (answering 413/400 "depth limit exceeded"). One retry with a
// shallower type-ref selection gets those endpoints working; a wrapper deeper
// than it can see simply unwraps to String (see unwrap()), which only affects
// the rare [T!]!-style argument on such an endpoint.
const SHALLOW_TYPE_REF_DEPTH = 2;

function typeRefSelection(depth: number): string {
  return depth === 0 ? "kind name" : `kind name ofType { ${typeRefSelection(depth - 1)} }`;
}

function introspectionQuery(typeRefDepth: number): string {
  const typeRef = typeRefSelection(typeRefDepth);
  return `
  query MCPMasterIntrospection {
    __schema {
      queryType { name }
      mutationType { name }
      types {
        kind
        name
        fields(includeDeprecated: false) {
          name
          description
          args { name description type { ${typeRef} } }
          type { ${typeRef} }
        }
        inputFields { name description type { ${typeRef} } }
        enumValues { name }
      }
    }
  }
`;
}

// Walks NON_NULL/LIST wrappers down to the named type underneath, recording
// whether a LIST was ever crossed (an arg/field of "[String!]!" is a list of
// strings, not a single string).
function unwrap(type: TypeRef): { kind: string; name: string | null; isList: boolean } {
  let current: TypeRef | null = type;
  let isList = false;
  while (current) {
    if (current.kind === "LIST") isList = true;
    if (current.kind !== "NON_NULL" && current.kind !== "LIST") {
      return { kind: current.kind, name: current.name, isList };
    }
    current = current.ofType;
  }
  // The wrapper chain ran deeper than the introspection selection could see
  // (only possible on the shallow retry). The named type is unknown, so it's
  // reported as such: buildSelection/leafJsonSchema skip it rather than guess
  // a scalar and select an object field without a sub-selection.
  return { kind: "UNKNOWN", name: null, isList };
}

// Reconstructs the literal GraphQL type string (e.g. "[String!]!") from a
// TypeRef — used to declare a top-level argument's `$variable` with its real
// schema type, not a guessed one, so GraphQL's own variable coercion (which
// accepts a plain JSON string for an enum/input-object variable, per spec)
// does the right thing for every argument shape we allow through
// leafJsonSchema, including enums and input objects.
function typeRefToGraphqlString(type: TypeRef): string {
  if (type.kind === "NON_NULL" && type.ofType) return `${typeRefToGraphqlString(type.ofType)}!`;
  if (type.kind === "LIST" && type.ofType) return `[${typeRefToGraphqlString(type.ofType)}]`;
  return type.name ?? "String";
}

function scalarJsonSchema(scalarName: string | null): Record<string, unknown> {
  switch (scalarName) {
    case "Int":
      return { type: "integer" };
    case "Float":
      return { type: "number" };
    case "Boolean":
      return { type: "boolean" };
    default:
      // ID, String, and any custom scalar we don't otherwise recognize.
      return { type: "string" };
  }
}

// Builds the JSON-schema property for one argument/input-object field, or
// null if it's too deep for v1 (an object/interface/union nested beyond the
// one level this function is allowed to expand) — the caller omits it
// rather than failing the whole tool.
function leafJsonSchema(type: TypeRef, typesByName: Map<string, GraphqlType>, allowInputExpansion: boolean): Record<string, unknown> | null {
  const { kind, name, isList } = unwrap(type);

  let itemSchema: Record<string, unknown> | null = null;
  if (kind === "SCALAR") {
    itemSchema = scalarJsonSchema(name);
  } else if (kind === "ENUM") {
    const enumType = name ? typesByName.get(name) : undefined;
    itemSchema = { type: "string", enum: (enumType?.enumValues ?? []).map((v) => v.name) };
  } else if (kind === "INPUT_OBJECT" && allowInputExpansion && name) {
    const inputType = typesByName.get(name);
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const field of inputType?.inputFields ?? []) {
      // One level only — nested input objects inside this one aren't
      // expanded further (the depth cap described above).
      const nested = leafJsonSchema(field.type, typesByName, false);
      if (!nested) continue;
      properties[field.name] = { ...nested, description: field.description ?? undefined };
      if (field.type.kind === "NON_NULL") required.push(field.name);
    }
    if (Object.keys(properties).length === 0) return null;
    itemSchema = { type: "object", properties, required };
  } else {
    return null; // OBJECT/INTERFACE/UNION arguments, or a too-deep INPUT_OBJECT — unsupported in v1.
  }

  return isList ? { type: "array", items: itemSchema } : itemSchema;
}

// Picks the bounded, flat selection set for a field's return type — see the
// module comment's depth-cap rules. Returns "" for a scalar/enum return
// (nothing to select) or null if this field's return type has nothing
// selectable within the cap (the field is skipped entirely in that case).
function buildSelection(type: TypeRef, typesByName: Map<string, GraphqlType>): string | null {
  const { kind, name } = unwrap(type);
  if (kind === "SCALAR" || kind === "ENUM") return "";
  if (kind !== "OBJECT" || !name) return null; // INTERFACE/UNION, or unresolvable — skip.

  const objectType = typesByName.get(name);
  const scalarFields = (objectType?.fields ?? []).filter((f) => {
    const inner = unwrap(f.type);
    return inner.kind === "SCALAR" || inner.kind === "ENUM";
  });
  if (scalarFields.length === 0) return null;

  return scalarFields.slice(0, MAX_SELECTED_FIELDS).map((f) => f.name).join(" ");
}

export type GraphqlTool = {
  name: string;
  description: string;
  operation: "query" | "mutation";
  // The pre-built, depth-capped selection set to append after the field call
  // in the query dispatch builds (e.g. "id name email" or "" for a scalar
  // return) — computed once here rather than re-derived from the schema on
  // every call_tool dispatch.
  selection: string;
  // Real GraphQL type string per exposed top-level argument (e.g.
  // {"status": "TicketStatus!"}) — callGraphqlTool uses this to declare
  // `$variable` types that match the schema, so enum/input-object/list
  // arguments coerce correctly instead of being guessed as String.
  argTypes: Record<string, string>;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required: string[] };
};

function fieldsToTools(
  fields: GraphqlField[],
  operation: "query" | "mutation",
  typesByName: Map<string, GraphqlType>,
): GraphqlTool[] {
  const tools: GraphqlTool[] = [];

  for (const field of fields) {
    if (tools.length >= MAX_TOOLS_PER_OPERATION) break;

    const selection = buildSelection(field.type, typesByName);
    if (selection === null) continue; // Nothing boundedly selectable — skip.

    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    const argTypes: Record<string, string> = {};
    for (const arg of field.args) {
      const schema = leafJsonSchema(arg.type, typesByName, true);
      if (!schema) continue; // Too deep for v1 — omit rather than fail the tool.
      properties[arg.name] = { ...schema, description: arg.description ?? undefined };
      argTypes[arg.name] = typeRefToGraphqlString(arg.type);
      if (arg.type.kind === "NON_NULL") required.push(arg.name);
    }

    tools.push({
      name: field.name,
      description: field.description || `${operation === "query" ? "Query" : "Mutation"} ${field.name}`,
      operation,
      selection,
      argTypes,
      inputSchema: { type: "object", properties, required },
    });
  }

  return tools;
}

type IntrospectionOutcome =
  | { ok: true; parsed: IntrospectionResult & { data: NonNullable<IntrospectionResult["data"]> } }
  | { ok: false; error: string; retryShallow: boolean };

async function runIntrospection(
  endpointUrl: string,
  authHeaders: Record<string, string>,
  typeRefDepth: number,
): Promise<IntrospectionOutcome> {
  let raw: string;
  let status: number;
  try {
    const response = await validatedFetch(endpointUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...authHeaders },
      body: JSON.stringify({ query: introspectionQuery(typeRefDepth) }),
      maxBytes: INTROSPECTION_MAX_BYTES,
    });
    raw = response.text;
    status = response.status;
  } catch (err) {
    return { ok: false, retryShallow: false, error: err instanceof EgressBlockedError ? err.message : "Could not reach that endpoint" };
  }

  // A depth-limited endpoint answers 400/413, or 200 with `errors` — all
  // worth exactly one shallower retry. Anything else is a real failure.
  const retryShallow = typeRefDepth > SHALLOW_TYPE_REF_DEPTH;
  if (status < 200 || status >= 300) {
    return { ok: false, retryShallow: retryShallow && (status === 400 || status === 413), error: `Endpoint returned HTTP ${status}` };
  }

  let parsed: IntrospectionResult;
  try {
    parsed = JSON.parse(raw) as IntrospectionResult;
  } catch {
    return { ok: false, retryShallow: false, error: "Endpoint did not return valid JSON" };
  }

  if (parsed.errors?.length || !parsed.data) {
    return { ok: false, retryShallow, error: "Introspection is disabled or failed on that endpoint" };
  }
  return { ok: true, parsed: parsed as IntrospectionResult & { data: NonNullable<IntrospectionResult["data"]> } };
}

export type GraphqlTranslationResult =
  | { ok: true; tools: GraphqlTool[]; baseUrl: string }
  | { ok: false; error: string };

// Introspects the endpoint through validatedFetch — never call fetch() on
// endpointUrl directly. `authHeaders` carries the integration's stored credential
// (same bearer/api_key treatment as openapi) since introspection is commonly
// gated behind the same auth as the rest of the API.
export async function introspectAndTranslateGraphqlEndpoint(
  endpointUrl: string,
  authHeaders: Record<string, string> = {},
): Promise<GraphqlTranslationResult> {
  let outcome = await runIntrospection(endpointUrl, authHeaders, FULL_TYPE_REF_DEPTH);
  if (!outcome.ok && outcome.retryShallow) {
    outcome = await runIntrospection(endpointUrl, authHeaders, SHALLOW_TYPE_REF_DEPTH);
  }
  if (!outcome.ok) return { ok: false, error: outcome.error };
  const parsed = outcome.parsed;

  const { queryType, mutationType, types } = parsed.data.__schema;
  const typesByName = new Map(types.filter((t) => t.name).map((t) => [t.name as string, t]));

  const tools: GraphqlTool[] = [];
  if (queryType) {
    const queryFields = typesByName.get(queryType.name)?.fields ?? [];
    tools.push(...fieldsToTools(queryFields, "query", typesByName));
  }
  if (mutationType) {
    const mutationFields = typesByName.get(mutationType.name)?.fields ?? [];
    tools.push(...fieldsToTools(mutationFields, "mutation", typesByName));
  }

  if (tools.length === 0) {
    return { ok: false, error: "No boundedly-callable queries or mutations were found on that endpoint" };
  }

  return { ok: true, tools, baseUrl: endpointUrl };
}

export type GraphqlCallOutcome =
  | { ok: true; text: string }
  | { ok: false; error: string };

// Live tool call — builds and sends exactly one
// flat, depth-capped GraphQL request per call, through validatedFetch.
export async function callGraphqlTool(
  endpointUrl: string,
  tool: { name: string; operation: "query" | "mutation"; selection: string; argTypes: Record<string, string> },
  args: Record<string, unknown>,
  authHeaders: Record<string, string> = {},
): Promise<GraphqlCallOutcome> {
  // Only pass through arguments this tool actually declared (argTypes is
  // built from the same schema-derived set leafJsonSchema allowed) — an
  // unrecognized key in `args` is silently dropped rather than sent as an
  // untyped variable GraphQL would reject anyway.
  const argNames = Object.keys(args).filter((name) => tool.argTypes[name]);
  const variableDefs = argNames.map((name) => `$${name}: ${tool.argTypes[name]}`).join(", ");
  const argAssignments = argNames.map((name) => `${name}: $${name}`).join(", ");
  const variables = Object.fromEntries(argNames.map((name) => [name, args[name]]));
  const selection = tool.selection ? ` { ${tool.selection} }` : "";

  const query = `${tool.operation} ${variableDefs ? `MCPMasterCall(${variableDefs})` : "MCPMasterCall"} {
    result: ${tool.name}${argAssignments ? `(${argAssignments})` : ""}${selection}
  }`;

  try {
    const response = await validatedFetch(endpointUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...authHeaders },
      body: JSON.stringify({ query, variables }),
    });
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, error: `That call failed (HTTP ${response.status})` };
    }

    let body: { data?: { result?: unknown }; errors?: { message: string }[] };
    try {
      body = JSON.parse(response.text);
    } catch {
      return { ok: false, error: "That endpoint did not return valid JSON" };
    }
    if (body.errors?.length) {
      return { ok: false, error: "That call failed" };
    }
    return { ok: true, text: JSON.stringify(body.data?.result ?? null) };
  } catch (err) {
    return { ok: false, error: err instanceof EgressBlockedError ? err.message : "Could not reach that endpoint" };
  }
}
