// The shared integration engine (packages/core) — the behaviours added when it
// was extracted for the self-hosted runtime, all of which the hosted app now
// runs too: SSE responses from remote MCP servers, YAML OpenAPI specs, and the
// shallow-introspection retry for depth-limited GraphQL endpoints.
//
// Pure functions are executed directly; the GraphQL retry is driven against a
// mock endpoint on 127.0.0.1, with local-mode private egress switched on for
// this process only (and switched back off afterwards).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonRpcResponse } from "../packages/core/src/mcp-proxy.ts";
import { translateOpenApiDocument } from "../packages/core/src/openapi.ts";
import { introspectAndTranslateGraphqlEndpoint } from "../packages/core/src/graphql.ts";
import { allowPrivateNetworkEgress, validatedFetch } from "../packages/core/src/egress.ts";

after(() => allowPrivateNetworkEgress(false));

test("an SSE MCP response is parsed, picking the event with the matching id", () => {
  const body = [
    ": keep-alive",
    "",
    'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}',
    "",
    'event: message\ndata: {"jsonrpc":"2.0","id":2,\ndata: "result":{"tools":[]}}',
    "",
  ].join("\n");
  const parsed = parseJsonRpcResponse<{ tools: unknown[] }>(body, "text/event-stream; charset=utf-8", 2);
  assert.deepEqual(parsed, { jsonrpc: "2.0", id: 2, result: { tools: [] } });
});

test("a plain JSON MCP response still parses, and a mismatched id is refused", () => {
  const body = '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}';
  assert.deepEqual(parseJsonRpcResponse(body, "application/json", 1), { jsonrpc: "2.0", id: 1, result: { ok: true } });
  assert.equal(parseJsonRpcResponse(body, "application/json", 7), null);
  assert.equal(parseJsonRpcResponse("<html>", "text/html", 1), null);
});

test("a YAML OpenAPI spec translates the same as JSON", () => {
  const yaml = `
openapi: 3.0.3
servers:
  - url: https://api.example.com/v1
paths:
  /pets/{id}:
    get:
      operationId: getPet
      summary: Get a pet
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
`;
  const result = translateOpenApiDocument(yaml);
  assert.ok(result.ok);
  assert.equal(result.baseUrl, "https://api.example.com/v1");
  assert.deepEqual(result.tools.map((t) => t.name), ["getPet"]);
  assert.deepEqual(result.tools[0].params, [{ name: "id", in: "path" }]);
});

test("a YAML alias bomb is refused instead of expanded", () => {
  const bomb = ["openapi: 3.0.0", "a: &a [x, x, x, x, x, x, x, x, x, x]"];
  for (let i = 0; i < 12; i++) bomb.push(`${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} [${Array(10).fill(`*${String.fromCharCode(97 + i)}`).join(", ")}]`);
  const result = translateOpenApiDocument(bomb.join("\n"));
  assert.equal(result.ok, false);
});

test("private egress is refused by default and only allowed after the local-mode opt-in", async () => {
  await assert.rejects(validatedFetch("http://127.0.0.1:1/"), /isn't reachable/);
});

test("a depth-limited GraphQL endpoint gets one shallower introspection retry", async () => {
  const depths: number[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const query: string = JSON.parse(body).query;
    // Depth of the deepest `ofType` chain in the query.
    const depth = (query.match(/ofType \{ kind name ofType \{ kind name ofType \{ kind name ofType/) ? 4 : 2);
    depths.push(depth);
    if (depth > 2) {
      res.writeHead(413, { "Content-Type": "application/json" });
      return res.end('{"errors":[{"message":"Query depth limit exceeded."}]}');
    }
    const str = { kind: "SCALAR", name: "String", ofType: null };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: { __schema: {
      queryType: { name: "Query" }, mutationType: null,
      types: [
        { kind: "OBJECT", name: "Query", inputFields: null, enumValues: null, fields: [
          { name: "hello", description: "Say hi", args: [{ name: "to", description: null, type: { kind: "NON_NULL", name: null, ofType: str } }], type: str },
          // [Thing!]! is deeper than the shallow query can see: it must be
          // skipped, not selected as a String.
          { name: "things", description: null, args: [], type: { kind: "NON_NULL", name: null, ofType: { kind: "LIST", name: null, ofType: { kind: "NON_NULL", name: null, ofType: null } } } },
        ] },
      ],
    } } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  allowPrivateNetworkEgress(true);
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/graphql`;
    const result = await introspectAndTranslateGraphqlEndpoint(url);
    assert.deepEqual(depths, [4, 2], "full query first, then exactly one shallow retry");
    assert.ok(result.ok);
    assert.deepEqual(result.tools.map((t) => t.name), ["hello"]);
    assert.equal(result.tools[0].argTypes.to, "String!");
  } finally {
    allowPrivateNetworkEgress(false);
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("code mode finds the integration prefix in both runtimes' tool names", async () => {
  const { toolPrefix } = await import("../packages/core/src/code-mode.ts");
  assert.equal(toolPrefix("github.list_issues"), "github", "hosted: prefix.tool");
  assert.equal(toolPrefix("github_list_issues"), "github", "self-hosted: prefix_tool");
  assert.equal(toolPrefix("my-api_get_thing_by_id"), "my-api", "prefixes never contain _, so the first one ends it");
  assert.equal(toolPrefix("my-api.get_thing"), "my-api", "a dot wins when present");
});

test("the open-source packages never point at the private repo's docs or internals", () => {
  // packages/core, packages/mcpmaster and packages/mcpv are published on their own, so a
  // comment citing a design doc, a hosted source path or hosted-only
  // infrastructure is a dead reference there (and leaks internals).
  const root = fileURLToPath(new URL("../packages/", import.meta.url));
  const pattern = /docs\/design\.md|docs\/reference|CLAUDE\.md|(?<!~\/)(?<!HOME\/)\.claude\/skills|src\/lib\/|src\/app\/|@\/lib|QStash|Vercel|Upstash|Neon\b|tools_summary/;
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|js|mjs|css|html|md|sh|json)$/.test(name)) {
        readFileSync(path, "utf8").split("\n").forEach((line, i) => {
          if (pattern.test(line)) offenders.push(`${path.slice(root.length)}:${i + 1}: ${line.trim()}`);
        });
      }
    }
  };
  // Each public repo exports only some of these, so a missing one is skipped.
  for (const pkg of ["core", "mcpmaster", "mcpv"]) if (existsSync(join(root, pkg))) walk(join(root, pkg));
  assert.deepEqual(offenders, [], offenders.join("\n"));
});
