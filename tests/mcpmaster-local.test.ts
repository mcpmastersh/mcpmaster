// The self-hosted runtime (packages/mcpmaster) — driven as a user and an
// agent would drive it: the *bundled* CLI as a subprocess, its local web
// server over real HTTP, and a real stdio MCP server as a child process.
//
// What this file protects, in priority order:
//   1. Security: the local server only answers loopback Hosts, requires the
//      admin token on every API/MCP call, refuses cross-origin and non-JSON
//      writes; private-network egress is OFF until the user turns it on; a
//      credential is stored 0600, never printed back, and scrubbed from any
//      response that echoes it.
//   2. Stream discipline: `call`/`tools --json` put data on stdout and
//      nothing else; human lines go to stderr.
//   3. "Connect anything": OpenAPI (URL + auto-detect), local command (stdio)
//      and tool aggregation/dispatch all work end to end.
//
// No external network: every integration is a mock on 127.0.0.1, which is
// also exactly what exercises the private-network opt-in.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer, get as httpGet, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const bundle = join(repoRoot, "packages/mcpmaster/dist/mcpmaster.mjs");
const work = mkdtempSync(join(tmpdir(), "mcpmaster-test-"));
const home = join(work, "home");
const SECRET = "sk-test-super-secret-value-123456";

let api: Server;
let apiPort = 0;
// Operations the mock spec grows on demand, to model an API that adds
// endpoints between syncs ("future" tools).
const laterOps = new Set<string>();
let serverProc: ChildProcess | null = null;
let uiPort = 0;

// Always async: the mock integrations live in this process, so a blocking
// execFileSync would stop them from ever answering the CLI under test.
function run(args: string[], opts: { input?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // FORCE_COLOR from the caller's shell would make Node warn on stderr that
    // it outranks NO_COLOR — noise the stream assertions would count.
    const { FORCE_COLOR: _forceColor, ...parentEnv } = process.env;
    const child = spawn(process.execPath, [bundle, ...args], { env: { ...parentEnv, MCPMASTER_HOME: home, NO_COLOR: "1" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createNetServer().listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

before(async () => {
  execFileSync(process.execPath, [join(repoRoot, "packages/mcpmaster/scripts/build.mjs")], { stdio: "inherit" });

  // A tiny API with a spec. /echo reflects the credential it received — the
  // reflection attack redaction exists to stop.
  api = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/openapi.json") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        openapi: "3.0.0",
        servers: [{ url: `http://127.0.0.1:${apiPort}` }],
        paths: {
          "/echo": { get: { operationId: "echo", summary: "Echo back", parameters: [{ name: "q", in: "query", required: true, schema: { type: "string" } }] } },
          "/items/{id}": {
            get: { operationId: "get.item", summary: "Get an item", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] },
            ...(laterOps.has("delete") ? { delete: { operationId: "delete.item", summary: "Delete an item", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] } } : {}),
            ...(laterOps.has("archive") ? { patch: { operationId: "archive.item", summary: "Archive an item", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] } } : {}),
          },
          "/items": { post: { operationId: "create.item", summary: "Create an item", requestBody: { content: { "application/json": { schema: { type: "object" } } } } } },
        },
      }));
      return;
    }
    if (url.pathname === "/big.json") {
      // 400 resources × 4 methods = 1,600 tools, each with a real schema —
      // the size of a few large APIs connected together.
      const paths: Record<string, unknown> = {};
      const body = { content: { "application/json": { schema: { type: "object", properties: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`field_${i}`, { type: "string", description: `Field ${i} of the record` }])) } } } };
      for (let i = 0; i < 400; i++) {
        paths[`/r${i}`] = {
          get: { operationId: `list_r${i}`, summary: `List r${i} records` },
          post: { operationId: `create_r${i}`, summary: `Create an r${i} record`, requestBody: body },
          put: { operationId: `update_r${i}`, summary: `Update an r${i} record`, requestBody: body },
          delete: { operationId: `delete_r${i}`, summary: `Delete an r${i} record` },
        };
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ openapi: "3.0.0", servers: [{ url: `http://127.0.0.1:${apiPort}` }], paths }));
      return;
    }
    if (url.pathname === "/echo") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ q: url.searchParams.get("q"), sawAuth: req.headers.authorization ?? null }));
      return;
    }
    if (url.pathname.startsWith("/items/")) {
      res.end(JSON.stringify({ id: decodeURIComponent(url.pathname.slice(7)) }));
      return;
    }
    res.statusCode = 404;
    res.end("nope");
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", () => r()));
  apiPort = (api.address() as { port: number }).port;

  // A real stdio MCP server, built on the same SDK agents use.
  const sdk = join(repoRoot, "node_modules/@modelcontextprotocol/sdk/dist/esm");
  writeFileSync(join(work, "stdio-server.mjs"), `
import { Server } from ${JSON.stringify(join(sdk, "server/index.js"))};
import { StdioServerTransport } from ${JSON.stringify(join(sdk, "server/stdio.js"))};
import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(join(sdk, "types.js"))};
const server = new Server({ name: "calc", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: "add", description: "Add two numbers", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } },
  { name: "leak", description: "Echo the env secret", inputSchema: { type: "object", properties: {} } },
] }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "add") return { content: [{ type: "text", text: String(req.params.arguments.a + req.params.arguments.b) }] };
  return { content: [{ type: "text", text: "token=" + process.env.CALC_TOKEN }] };
});
await server.connect(new StdioServerTransport());
`);
});

after(async () => {
  serverProc?.kill("SIGTERM");
  await new Promise<void>((r) => api.close(() => r()));
  rmSync(work, { recursive: true, force: true });
});

test("a private address is refused until the user opts in", async () => {
  const blocked = await run(["add", `http://127.0.0.1:${apiPort}/openapi.json`, "--type", "openapi"]);
  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, /isn't reachable|Could not fetch spec/);

  const on = await run(["settings", "private-network", "on"]);
  assert.equal(on.code, 0, on.stderr);
});

test("add auto-detects an OpenAPI spec and stores the credential 0600, never printing it", async () => {
  const added = await run(["add", `http://127.0.0.1:${apiPort}/openapi.json`, "--name", "demo", "--bearer", "--token-stdin"], { input: SECRET });
  assert.equal(added.code, 0, added.stderr);

  const secretsFile = join(home, "secrets.json");
  if (process.platform !== "win32") {
    assert.equal(statSync(secretsFile).mode & 0o777, 0o600, "secrets.json must be owner-only");
    assert.equal(statSync(home).mode & 0o777, 0o700, "the state dir must be owner-only");
  }
  assert.ok(readFileSync(secretsFile, "utf8").includes(SECRET));
  assert.ok(!readFileSync(join(home, "config.json"), "utf8").includes(SECRET), "config.json must never hold a secret value");

  const listed = await run(["list", "--json"]);
  assert.equal(listed.code, 0);
  assert.ok(!listed.stdout.includes(SECRET), "list must name credentials, never print them");
  const [demo] = JSON.parse(listed.stdout);
  assert.equal(demo.type, "openapi");
  assert.equal(demo.credential.configured, true);
});

test("tools are namespaced and client-safe; --json is data on stdout only", async () => {
  const result = await run(["tools", "--json"]);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "", "--json must keep stderr empty on success");
  const names = JSON.parse(result.stdout).map((t: { name: string }) => t.name).sort();
  // `get.item` has a dot, which several model APIs reject in a tool name.
  assert.deepEqual(names, ["demo_create_item", "demo_echo", "demo_get_item"]);
  for (const name of names) assert.match(name, /^[A-Za-z0-9_-]{1,64}$/);
});

test("call routes arguments, puts only the result on stdout, and redacts a reflected credential", async () => {
  const result = await run(["call", "demo_echo", JSON.stringify({ q: "hello" })]);
  assert.equal(result.code, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.q, "hello");
  assert.ok(!result.stdout.includes(SECRET), "a credential the API echoed back must be scrubbed");
  assert.match(body.sawAuth, /\[REDACTED\]/);

  const path = await run(["call", "demo_get_item", JSON.stringify({ id: "a/b" })]);
  assert.equal(JSON.parse(path.stdout).id, "a/b", "path params are URL-encoded, not path-traversing");

  const bad = await run(["call", "demo_nope"]);
  assert.equal(bad.code, 1);
  assert.equal(bad.stdout, "");
});

test("a local command becomes a stdio MCP integration, and its env secret is scrubbed", async () => {
  const added = await run(["add", "--name", "calc", "--env", `CALC_TOKEN=${SECRET}`, "--", process.execPath, join(work, "stdio-server.mjs")]);
  assert.equal(added.code, 0, added.stderr);

  const sum = await run(["call", "calc_add", '{"a":2,"b":3}']);
  assert.equal(sum.stdout.trim(), "5");

  const leak = await run(["call", "calc_leak"]);
  assert.ok(!leak.stdout.includes(SECRET));
  assert.match(leak.stdout, /\[REDACTED\]/);

  // MCP servers declare read-only tools themselves; unannotated is "unknown"
  // (and read-only mode hides it, like a write).
  const access = Object.fromEntries(JSON.parse((await run(["tools", "calc", "--json"])).stdout).map((t: { name: string; access: string }) => [t.name, t.access]));
  assert.deepEqual(access, { calc_add: "read", calc_leak: "unknown" });
});

test("disabling a tool hides it from agents", async () => {
  const tools = async () => JSON.parse((await run(["tools", "--json"])).stdout) as { name: string; enabled: boolean }[];
  await run(["disable", "calc"]);
  assert.ok(!(await tools()).some((t) => t.name.startsWith("calc_")), "a disabled integration's tools are gone");
  await run(["enable", "calc"]);
  assert.ok((await tools()).some((t) => t.name === "calc_add"));
});

test("block rules, read-only and new-tool review cover today's tools AND future ones", async () => {
  type T = { name: string; enabled: boolean; access: string; blockedBy: string | null };
  const tools = async () => JSON.parse((await run(["tools", "--json"])).stdout) as T[];
  const byName = async () => Object.fromEntries((await tools()).map((t) => [t.name, t]));

  // A rule for a tool that doesn't exist yet…
  const rule = await run(["tools", "block", "demo_delete_*"]);
  assert.equal(rule.code, 0, rule.stderr);
  assert.match(rule.stderr, /hides 0 tools now, and any that match later/);
  // …hides it the moment a sync brings it in.
  laterOps.add("delete");
  assert.equal((await run(["sync", "demo"])).code, 0);
  let t = await byName();
  assert.equal(t.demo_delete_item.enabled, false);
  assert.equal(t.demo_delete_item.blockedBy, "rule demo_delete_*");
  const refused = await run(["call", "demo_delete_item", '{"id":"1"}']);
  assert.equal(refused.code, 1, "a blocked tool can't be called directly");
  const viaCode = await run(["execute", "return await tools.demo_delete_item({ id: '1' })"]);
  assert.equal(viaCode.code, 1, "…or from a code-mode snippet");
  assert.match(viaCode.stderr, /Unknown tool/);

  // Read-only hides writes (POST/DELETE), keeps reads (GET).
  assert.equal((await run(["policy", "demo", "--read-only"])).code, 0);
  t = await byName();
  assert.equal(t.demo_create_item.blockedBy, "read-only integration");
  assert.equal(t.demo_create_item.access, "write");
  assert.equal(t.demo_echo.enabled, true);
  assert.equal(t.demo_echo.access, "read");

  // Switching one tool on explicitly wins over read-only…
  const allow = await run(["tools", "unblock", "demo_create_item"]);
  assert.match(allow.stderr, /allowed over its rule/);
  assert.equal((await byName()).demo_create_item.enabled, true);
  // …and an explicit block wins over nothing-at-all.
  await run(["tools", "block", "demo_echo"]);
  assert.equal((await byName()).demo_echo.blockedBy, "blocked");
  await run(["tools", "unblock", "demo_echo"]);

  // Review: with it on, a tool that appears in a later sync waits, hidden.
  await run(["policy", "demo", "--read-only=off", "--hide-new-tools"]);
  laterOps.add("archive");
  await run(["sync", "demo"]);
  t = await byName();
  assert.equal(t.demo_archive_item.blockedBy, "new, not reviewed");
  assert.equal(t.demo_get_item.enabled, true, "existing tools aren't affected by review");
  const policy = await run(["policy", "demo", "--approve"]);
  assert.equal(policy.code, 0);
  assert.equal((await byName()).demo_archive_item.enabled, true, "approving exposes it");

  const rules = JSON.parse((await run(["tools", "rules", "--json"])).stdout);
  assert.deepEqual(rules.rules, ["demo_delete_*"]);
  assert.deepEqual(rules.hideNewTools, ["demo"]);

  // Reset so later tests see the original API.
  await run(["tools", "unblock", "demo_delete_*"]);
  await run(["tools", "block", "demo_create_item"]);
  await run(["tools", "unblock", "demo_create_item"]);
  await run(["policy", "demo", "--hide-new-tools=off"]);
  laterOps.clear();
  await run(["sync", "demo"]);
  assert.deepEqual((await tools()).filter((x) => x.name.startsWith("demo_")).map((x) => [x.name, x.enabled]).sort(),
    [["demo_create_item", true], ["demo_echo", true], ["demo_get_item", true]]);
  const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.deepEqual([cfg.blockRules, cfg.disabledTools, cfg.allowedTools], [[], [], []]);
});

async function startUi(): Promise<string> {
  uiPort = await freePort();
  serverProc = spawn(process.execPath, [bundle, "start", "--port", String(uiPort), "--quiet"], {
    env: { ...process.env, MCPMASTER_HOME: home },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${uiPort}/healthz`);
      if (res.ok) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return readFileSync(join(home, "token"), "utf8").trim();
}

test("the local server enforces host, token, origin and JSON on every API call", async () => {
  const token = await startUi();
  const base = `http://127.0.0.1:${uiPort}`;
  const auth = { Authorization: `Bearer ${token}` };

  // The UI shell itself is static and carries no data.
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.ok(!(await page.text()).includes(token), "the page must never embed the token");
  const logo = await fetch(`${base}/logo.png`);
  assert.equal(logo.headers.get("content-type"), "image/png");
  assert.deepEqual([...new Uint8Array(await logo.arrayBuffer()).slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], "served as real PNG bytes");

  assert.equal((await fetch(`${base}/api/state`)).status, 401, "no token → 401");
  assert.equal((await fetch(`${base}/api/state`, { headers: { Authorization: "Bearer wrong" } })).status, 401);

  // DNS rebinding: a hostile name that resolves to 127.0.0.1 still sends its own Host.
  const rebind = await new Promise<number>((resolve) => {
    import("node:http").then(({ request }) => {
      const req = request({ host: "127.0.0.1", port: uiPort, path: "/api/state", headers: { ...auth, Host: `evil.example:${uiPort}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.end();
    });
  });
  assert.equal(rebind, 403);

  const cross = await fetch(`${base}/api/state`, { headers: { ...auth, Origin: "https://evil.example" } });
  assert.equal(cross.status, 403);

  const form = await fetch(`${base}/api/integrations`, { method: "POST", headers: { ...auth, "Content-Type": "text/plain" }, body: "{}" });
  assert.equal(form.status, 415, "a form-style POST must be refused");

  // Block rules through the UI's API: add (with a live match count), remove.
  const added = await fetch(`${base}/api/rules`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ rule: "calc_*" }) });
  assert.equal(added.status, 201);
  assert.equal((await added.json()).matches, 2);
  const listed = await (await fetch(`${base}/api/tools?q=calc`, { headers: auth })).json();
  assert.equal(listed.items.find((t: { name: string }) => t.name === "calc_add").blockedBy.label, "rule calc_*");
  const bad = await fetch(`${base}/api/rules`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ rule: "a b(" }) });
  assert.equal(bad.status, 400);
  assert.equal((await fetch(`${base}/api/rules`, { method: "DELETE", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ rule: "calc_*" }) })).status, 200);

  const state = await (await fetch(`${base}/api/state`, { headers: auth })).json();
  assert.equal(state.integrations.length, 2);
  assert.ok(!JSON.stringify(state).includes(SECRET), "the API never returns a credential value");
});

test("1,600 tools: the UI API pages, searches and filters on the server, and loads schemas on demand", async () => {
  const added = await run(["add", `http://127.0.0.1:${apiPort}/big.json`, "--name", "big", "--type", "openapi"]);
  assert.equal(added.code, 0, added.stderr);
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const base = `http://127.0.0.1:${uiPort}`;
  const auth = { Authorization: `Bearer ${token}` };
  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`, { headers: auth });
    const text = await res.text();
    return { status: res.status, bytes: text.length, body: JSON.parse(text) };
  };
  type Row = { name: string; enabled: boolean; inputSchema?: unknown };

  // First page: 50 slim rows, the true total, and no schemas.
  const first = await get("/api/tools?integration=big");
  assert.equal(first.body.total, 1600);
  assert.equal(first.body.items.length, 50);
  assert.ok(first.body.items.every((t: Row) => t.inputSchema === undefined), "list rows carry no schema");
  assert.ok(first.bytes < 40_000, `a page stays small (${first.bytes} bytes)`);
  assert.deepEqual(first.body.counts, { all: 1600, exposed: 1600, hidden: 0 });

  const second = await get("/api/tools?integration=big&offset=50");
  assert.equal(second.body.items.length, 50);
  const seen = new Set(first.body.items.map((t: Row) => t.name));
  assert.ok(second.body.items.every((t: Row) => !seen.has(t.name)), "pages don't overlap");
  assert.equal((await get("/api/tools?integration=big&limit=100000")).body.items.length, 200, "a page is capped");

  // Search runs over every tool, not the loaded page; name matches rank first.
  const deletes = await get("/api/tools?integration=big&q=delete");
  assert.equal(deletes.body.total, 400);
  const r12 = await get("/api/tools?q=delete%20r12");
  assert.equal(r12.body.total, 11, "delete_r12 and delete_r120…r129");
  assert.equal(r12.body.items[0].name, "big_delete_r12");
  assert.equal((await get("/api/tools?integration=big&access=read")).body.total, 400, "GETs are the reads");
  assert.equal((await get("/api/tools?q=%3Cscript%3E")).body.total, 0);

  // The schema comes with the one tool that's opened.
  const one = await get("/api/tools/big_create_r7");
  assert.equal(one.status, 200);
  assert.ok(one.body.tool.inputSchema.properties, "the detail view has the schema");
  assert.equal((await get("/api/tools/nope_nothing")).status, 404);
  assert.equal((await get("/api/tools/..%2Fconfig")).status, 404);

  // Bulk: everything matching a filter, including rows never loaded.
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  const hid = await post("/api/tools/bulk", { enabled: false, filter: { integration: "big", q: "delete" } });
  assert.deepEqual(hid, { changed: 400, matched: 400 });
  const hidden = await get("/api/tools?integration=big&status=hidden");
  assert.equal(hidden.body.total, 400);
  assert.deepEqual(hidden.body.counts, { all: 1600, exposed: 1200, hidden: 400 });
  const cli = await run(["tools", "--integration", "big", "--hidden", "--json"]);
  assert.equal(JSON.parse(cli.stdout).length, 400, "the CLI sees the same policy");
  const shown = await post("/api/tools/bulk", { enabled: true, filter: { integration: "big", q: "delete" } });
  assert.equal(shown.changed, 400);
  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.ok(!config.disabledTools.some((n: string) => n.startsWith("big_")), "exposing again leaves no explicit blocks behind");
  assert.ok(!config.allowedTools.some((n: string) => n.startsWith("big_")), "and no needless allows");

  // A rule's reach is previewed before it's saved.
  assert.deepEqual((await get("/api/rules/preview?rule=big_delete_*")).body, { valid: true, matches: 400 });
  assert.equal((await get("/api/rules/preview?rule=a%20b")).body.valid, false);

  // The terminal gets one page and the command for the next.
  const page = await run(["tools", "--integration", "big"]);
  assert.equal(page.code, 0, page.stderr);
  assert.match(page.stderr, /1–50 of 1600 tools/);
  assert.match(page.stderr, /mcpmaster tools --integration big --offset 50/);
  assert.equal((await run(["tools", "--integration", "nope"])).code, 2);
  const paged = JSON.parse((await run(["tools", "--integration", "big", "--json", "--limit", "10", "--offset", "1590"])).stdout);
  assert.equal(paged.length, 10);
  assert.equal(paged[0].name, JSON.parse((await run(["tools", "--integration", "big", "--json"])).stdout)[1590].name, "--offset slices the same order");

  assert.equal((await run(["remove", "big"])).code, 0);
});

test("agents see ONE execute tool by default, and it reaches every tool through the sandbox", async () => {
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const rpc = async (body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${uiPort}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify(body),
    });
    return res.json();
  };

  // Code mode: the context cost is one tool, whatever is connected.
  const list = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), ["execute"]);
  const description: string = list.result.tools[0].description;
  assert.match(description, /- calc: calc \(2 tools\)/, "the execute tool names each integration prefix");
  assert.match(description, /- demo: demo \(3 tools\)/);
  assert.ok(!description.includes("Echo back"), "individual tool schemas are NOT in the listing");

  // A snippet discovers, describes and calls tools — typed, as agents write it.
  const code = `
    const { items } = await tools.search({ query: "add" });
    const path: string = items[0].path;
    const details = await tools.describe.tool({ path });
    const sum = await tools[path]({ a: 40, b: 2 });
    console.log("called", path);
    return { path, sum, required: details.inputSchema.required };
  `;
  const exec = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "execute", arguments: { code } } });
  const text: string = exec.result.content[0].text;
  assert.deepEqual(JSON.parse(text.split("\n\nconsole output:")[0]), { path: "calc_add", sum: 42, required: ["a", "b"] });
  assert.match(text, /console output:\ncalled calc_add/);

  // The snippet's only capability is the tools bridge; secrets stay scrubbed.
  const noFetch = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "execute", arguments: { code: "return await fetch('http://127.0.0.1/')" } } });
  assert.equal(noFetch.result.isError, true);
  assert.match(noFetch.result.content[0].text, /fetch.*not defined/);
  const leak = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "execute", arguments: { code: "return await tools.calc_leak({})" } } });
  assert.ok(!JSON.stringify(leak).includes(SECRET));

  // Direct calls by full name still work in code mode (same path, not advertised).
  const direct = await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "calc_add", arguments: { a: 1, b: 2 } } });
  assert.equal(direct.result.content[0].text, "3");

  // "all" mode lists every tool individually, for clients that can't run code.
  assert.equal((await run(["settings", "tools", "all"])).code, 0);
  const all = await rpc({ jsonrpc: "2.0", id: 6, method: "tools/list", params: {} });
  assert.deepEqual(all.result.tools.map((t: { name: string }) => t.name).sort(), ["calc_add", "calc_leak", "demo_create_item", "demo_echo", "demo_get_item"]);
  assert.ok(!JSON.stringify(all).includes('"x-in"'), "internal routing tags aren't shown to agents");
  await run(["settings", "tools", "execute"]);

  const unauth = await fetch(`http://127.0.0.1:${uiPort}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(unauth.status, 401);
});

test("execute from the CLI prints only the snippet's result on stdout", async () => {
  const result = await run(["execute", "return (await tools.calc_add({ a: 20, b: 22 }))"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), "42");
  assert.ok(!result.stderr.includes("ExperimentalWarning"), "node's strip-types warning is suppressed");

  const piped = await run(["execute", "-"], { input: "const n: number = 7; return n * 6" });
  assert.equal(piped.stdout.trim(), "42");
});

test("remove deletes the integration, its tool cache and its credential", async () => {
  const before = JSON.parse((await run(["list", "--json"])).stdout) as { id: string; name: string }[];
  const demo = before.find((s) => s.name === "demo")!;
  assert.equal((await run(["remove", "demo"])).code, 0);
  assert.ok(!readFileSync(join(home, "secrets.json"), "utf8").includes(demo.id));
  assert.ok(!readdirSync(join(home, "tools")).includes(`${demo.id}.json`));
});

test("OAuth MCP servers: every sign-in registers a new client, and removal leaves nothing cached", async () => {
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const ui = `http://127.0.0.1:${uiPort}`;
  const authed = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  // A remote MCP server with its own authorization server (discovery + DCR +
  // PKCE code flow), all on one mock.
  const registrations: string[] = [];
  const validTokens = new Set<string>();
  let base = "";
  const oauthServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", base);
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
    }
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
      return json(200, {
        issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`, response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.pathname === "/register") {
      const clientId = `client-${registrations.length + 1}`;
      registrations.push(clientId);
      return json(201, { ...JSON.parse(body), client_id: clientId });
    }
    if (url.pathname === "/authorize") {
      // Stands in for the user approving in their browser.
      const back = new URL(url.searchParams.get("redirect_uri")!);
      back.searchParams.set("code", `code-for-${url.searchParams.get("client_id")}`);
      back.searchParams.set("state", url.searchParams.get("state")!);
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }
    if (url.pathname === "/token") {
      const form = new URLSearchParams(body);
      const clientId = form.get("client_id")!;
      if (form.get("code") !== `code-for-${clientId}` || clientId !== registrations.at(-1)) return json(400, { error: "invalid_grant" });
      const issued = `at-${clientId}`;
      validTokens.add(issued);
      return json(200, { access_token: issued, token_type: "Bearer", expires_in: 3600 });
    }
    if (url.pathname === "/mcp") {
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!validTokens.has(bearer)) {
        res.writeHead(401, { "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` });
        return res.end();
      }
      const rpc = JSON.parse(body);
      if (rpc.id === undefined) { res.writeHead(202); return res.end(); }
      if (rpc.method === "initialize") return json(200, { jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1" } } });
      if (rpc.method === "tools/list") return json(200, { jsonrpc: "2.0", id: rpc.id, result: { tools: [{ name: "whoami", description: "Who am I", inputSchema: { type: "object", properties: {} } }] } });
      return json(200, { jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: `you are ${bearer}` }] } });
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => oauthServer.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(oauthServer.address() as { port: number }).port}`;

  const signIn = async (id: string) => {
    const { authorizationUrl } = await (await fetch(`${ui}/api/integrations/${id}/sign-in`, { method: "POST", headers: authed, body: "{}" })).json();
    assert.ok(authorizationUrl, "a sign-in URL is returned");
    const approved = await fetch(authorizationUrl, { redirect: "manual" });
    const callback = approved.headers.get("location")!;
    assert.ok(callback.startsWith(`${ui}/oauth/callback`), "the provider sends the browser back to the local server");
    const page = await fetch(callback);
    assert.equal(page.status, 200, await page.text());
    // The state is single-use: replaying the callback must fail.
    assert.equal((await fetch(callback)).status, 400);
  };

  try {
    const added = await (await fetch(`${ui}/api/integrations`, { method: "POST", headers: authed, body: JSON.stringify({ input: `${base}/mcp`, name: "remote" }) })).json();
    assert.equal(added.integration.status, "needs_auth", "a 401 from an MCP server is detected as OAuth");
    const id = added.integration.id;

    await signIn(id);
    assert.equal((await run(["call", "remote_whoami"])).stdout.trim(), "you are [REDACTED]", "calls carry the token, and it's scrubbed from the result");
    assert.deepEqual(registrations, ["client-1"]);

    // Signing in again never reuses the cached client — it registers anew.
    await signIn(id);
    assert.deepEqual(registrations, ["client-1", "client-2"]);
    const secrets = JSON.parse(readFileSync(join(home, "secrets.json"), "utf8"));
    assert.equal(secrets[id].oauth.client.client_id, "client-2");

    // Signing out forgets the client registration and tokens.
    await fetch(`${ui}/api/integrations/${id}/sign-out`, { method: "POST", headers: authed, body: "{}" });
    assert.equal(JSON.parse(readFileSync(join(home, "secrets.json"), "utf8"))[id]?.oauth, undefined);

    // Removing it deletes everything; re-adding the same URL starts over.
    await signIn(id);
    await fetch(`${ui}/api/integrations/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    assert.equal(JSON.parse(readFileSync(join(home, "secrets.json"), "utf8"))[id], undefined, "no cached OAuth survives removal");
    const again = await (await fetch(`${ui}/api/integrations`, { method: "POST", headers: authed, body: JSON.stringify({ input: `${base}/mcp`, name: "remote" }) })).json();
    await signIn(again.integration.id);
    assert.deepEqual(registrations, ["client-1", "client-2", "client-3", "client-4"], "a re-added server gets a brand-new client");
  } finally {
    await new Promise<void>((r) => oauthServer.close(() => r()));
  }
});

test("OAuth2 with your own client: browser consent with PKCE, refresh, and client credentials", async () => {
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const ui = `http://127.0.0.1:${uiPort}`;
  const authed = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const CLIENT_SECRET = "oauth2-client-secret-value-987654";

  // One mock plays the provider (authorize + token endpoints) and the API it
  // protects: an OpenAPI spec (public) whose one operation needs a bearer.
  let base = "";
  const valid = new Set<string>();
  const refreshTokens = new Set<string>();
  const challenges = new Map<string, string>();
  const tokenRequests: URLSearchParams[] = [];
  const basicAuths: string[] = [];
  let issued = 0;
  const expiresIn = 3600;
  const provider = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", base);
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const mint = () => {
      const access = `at-${++issued}`;
      const refresh = `rt-${issued}`;
      valid.add(access);
      refreshTokens.add(refresh);
      return { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: expiresIn };
    };
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(200, {
        issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
        token_endpoint_auth_methods_supported: ["client_secret_basic"], scopes_supported: ["read", "write"],
      });
    }
    if (url.pathname === "/openapi.json") {
      return json(200, {
        openapi: "3.0.0",
        servers: [{ url: base }],
        paths: { "/me": { get: { operationId: "me", summary: "Who am I" } } },
      });
    }
    if (url.pathname === "/me") {
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!valid.has(bearer)) return json(401, { error: "unauthorized" });
      return json(200, { you: bearer });
    }
    if (url.pathname === "/authorize") {
      // Stands in for the user approving (or declining) on the consent screen.
      const back = new URL(url.searchParams.get("redirect_uri")!);
      if (url.searchParams.get("client_id") !== "my-client") back.searchParams.set("error", "unauthorized_client");
      else if (url.searchParams.get("scope") === "deny") back.searchParams.set("error", "access_denied");
      else {
        assert.equal(url.searchParams.get("code_challenge_method"), "S256");
        const code = `code-${challenges.size + 1}`;
        challenges.set(code, url.searchParams.get("code_challenge")!);
        back.searchParams.set("code", code);
      }
      back.searchParams.set("state", url.searchParams.get("state")!);
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }
    if (url.pathname === "/token") {
      const form = new URLSearchParams(body);
      tokenRequests.push(form);
      if (req.headers.authorization) basicAuths.push(req.headers.authorization);
      const grant = form.get("grant_type");
      if (grant === "authorization_code") {
        const challenge = challenges.get(form.get("code")!);
        challenges.delete(form.get("code")!);
        const verifier = form.get("code_verifier") ?? "";
        const expected = createHash("sha256").update(verifier).digest("base64url");
        if (!challenge || challenge !== expected || form.get("client_secret") !== CLIENT_SECRET) {
          return json(400, { error: "invalid_grant", error_description: "PROVIDER-INTERNAL-DETAIL" });
        }
        return json(200, mint());
      }
      if (grant === "refresh_token") {
        if (!refreshTokens.delete(form.get("refresh_token")!)) return json(400, { error: "invalid_grant" });
        return json(200, mint());
      }
      if (grant === "client_credentials") {
        const expectedBasic = `Basic ${Buffer.from(`svc-client:${CLIENT_SECRET}`).toString("base64")}`;
        if (req.headers.authorization !== expectedBasic || form.get("scope") !== "read") return json(401, { error: "invalid_client" });
        // No refresh token for client credentials (RFC 6749 §4.4.3).
        const minted: Partial<ReturnType<typeof mint>> = mint();
        delete minted.refresh_token;
        return json(200, minted);
      }
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  const secrets = () => JSON.parse(readFileSync(join(home, "secrets.json"), "utf8"));
  const state = async () => (await (await fetch(`${ui}/api/state`, { headers: authed })).json()) as { oauthRedirectUrl: string; integrations: { id: string; status: string; error?: string; toolCount: number }[] };

  const consent = async (id: string) => {
    const { authorizationUrl } = await (await fetch(`${ui}/api/integrations/${id}/sign-in`, { method: "POST", headers: authed, body: "{}" })).json();
    const url = new URL(authorizationUrl);
    assert.equal(url.searchParams.get("redirect_uri"), (await state()).oauthRedirectUrl, "the redirect URI shown to the user is the one sent");
    const approved = await fetch(authorizationUrl, { redirect: "manual" });
    return approved.headers.get("location")!;
  };

  try {
    // Not https and not this machine: refused before anything is stored.
    const insecure = await fetch(`${ui}/api/integrations`, { method: "POST", headers: authed, body: JSON.stringify({
      input: `${base}/openapi.json`, auth: { type: "oauth2", grant: "authorization_code", authorizeUrl: "http://idp.example.com/authorize", tokenUrl: `${base}/token`, clientId: "my-client" },
    }) });
    assert.equal(insecure.status, 400);
    assert.match((await insecure.json()).error, /https/);

    // Browser sign-in: no token to probe a URL with yet, so its type must be given.
    const untyped = await fetch(`${ui}/api/integrations`, { method: "POST", headers: authed, body: JSON.stringify({
      input: `${base}/openapi.json`, auth: { type: "oauth2", grant: "authorization_code", authorizeUrl: `${base}/authorize`, tokenUrl: `${base}/token`, clientId: "my-client" },
      clientSecret: CLIENT_SECRET,
    }) });
    assert.equal(untyped.status, 400);
    assert.match((await untyped.json()).error, /Choose its type/);

    // An API link opened in a browser tab gets a page, not a token error — and still does nothing.
    // (Raw http: fetch sets Sec-Fetch-Mode itself.)
    const opened = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      httpGet(`${ui}/api/state`, { headers: { "Sec-Fetch-Mode": "navigate" } }, (r) => {
        let body = "";
        r.on("data", (c) => (body += c)).on("end", () => resolve({ status: r.statusCode ?? 0, body }));
      }).on("error", reject);
    });
    assert.equal(opened.status, 404);
    assert.match(opened.body, /mcpmaster&#39;s API, not a page/);

    const addBody = (clientId: string, scope?: string) => JSON.stringify({
      input: `${base}/openapi.json`, name: "idp", type: "openapi",
      auth: { type: "oauth2", grant: "authorization_code", authorizeUrl: `${base}/authorize`, tokenUrl: `${base}/token`, clientId, scope },
      clientSecret: CLIENT_SECRET,
    });
    const added = await (await fetch(`${ui}/api/integrations`, { method: "POST", headers: authed, body: addBody("my-client") })).json();
    const id = added.integration.id;
    assert.equal(added.integration.status, "needs_auth", "no token until the user consents");
    assert.equal(added.integration.toolCount, 1, "the public spec's tools are listed already");
    assert.ok(!readFileSync(join(home, "config.json"), "utf8").includes(CLIENT_SECRET), "the client secret stays out of config.json");
    assert.match((await run(["call", "idp_me"])).stderr, /Sign in/, "calling before consent says to sign in");

    const callback = await consent(id);
    assert.ok(callback.startsWith(`${ui}/oauth/callback`));
    const page = await fetch(callback);
    assert.equal(page.status, 200, await page.text());
    assert.equal((await fetch(callback)).status, 400, "the state is single-use");
    assert.equal((await state()).integrations.find((s) => s.id === id)?.status, "ready");

    const first = await run(["call", "idp_me"]);
    assert.equal(first.code, 0, first.stderr);
    assert.ok(!first.stdout.includes("at-"), "the access token is scrubbed from a result that reflects it");
    assert.match(first.stdout, /\[REDACTED\]/);

    // Revoked server-side: the 401 drops the token, the refresh token gets a
    // new one, and the call goes through without the user noticing.
    valid.clear();
    const retried = await run(["call", "idp_me"]);
    assert.equal(retried.code, 0, retried.stderr);
    assert.equal(tokenRequests.at(-1)?.get("grant_type"), "refresh_token");
    assert.ok(secrets()[id].oauth2.refreshToken !== "rt-1", "a rotated refresh token replaces the old one");

    // The refresh token revoked too: that needs a fresh consent.
    valid.clear();
    refreshTokens.clear();
    assert.match((await run(["call", "idp_me"])).stderr, /sign in again/);
    assert.equal((await state()).integrations.find((s) => s.id === id)?.status, "needs_auth");

    // Declining on the consent screen burns the state and says so.
    await fetch(`${ui}/api/integrations/${id}`, { method: "PATCH", headers: authed, body: JSON.stringify({ auth: JSON.parse(addBody("my-client", "deny")).auth }) });
    const declined = await fetch(await consent(id));
    assert.equal(declined.status, 400);
    assert.match((await state()).integrations.find((s) => s.id === id)?.error ?? "", /wasn't approved/);
    assert.equal(secrets()[id].oauth2.pendingState, undefined);
    assert.equal(secrets()[id].oauth2.clientSecret, CLIENT_SECRET, "editing settings keeps the stored client secret");

    // Sign-out forgets tokens but keeps the client secret.
    await fetch(`${ui}/api/integrations/${id}`, { method: "PATCH", headers: authed, body: JSON.stringify({ auth: JSON.parse(addBody("my-client")).auth }) });
    assert.equal((await fetch(await consent(id))).status, 200);
    await fetch(`${ui}/api/integrations/${id}/sign-out`, { method: "POST", headers: authed, body: "{}" });
    assert.deepEqual(Object.keys(secrets()[id].oauth2), ["clientSecret"]);

    // A provider error body never reaches the user.
    const bad = await fetch(await consent(id).then((c) => c.replace(/code=[^&]+/, "code=forged")));
    const badPage = await bad.text();
    assert.equal(bad.status, 400);
    assert.ok(!badPage.includes("PROVIDER-INTERNAL-DETAIL") && !badPage.includes("invalid_grant"));

    await fetch(`${ui}/api/integrations/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    assert.equal(secrets()[id], undefined, "removal deletes the client secret and every token");

    // client_credentials from the CLI: no browser, secret from the environment,
    // client sent as HTTP Basic.
    process.env.MCPM_TEST_CLIENT_SECRET = CLIENT_SECRET;
    const cc = await run(["add", `${base}/openapi.json`, "--name", "svc", "--oauth2", "--token-url", `${base}/token`,
      "--client-id", "svc-client", "--client-secret-env", "MCPM_TEST_CLIENT_SECRET", "--scope", "read", "--client-auth", "basic"]);
    assert.equal(cc.code, 0, cc.stderr);
    assert.ok(!cc.stdout.includes(CLIENT_SECRET) && !cc.stderr.includes(CLIENT_SECRET));
    const svcCall = await run(["call", "svc_me"]);
    assert.equal(svcCall.code, 0, svcCall.stderr);
    assert.ok(basicAuths.length > 0 && !tokenRequests.at(-1)?.has("client_secret"), "Basic means the secret isn't also in the body");
    valid.clear();
    assert.equal((await run(["call", "svc_me"])).code, 0, "an expired client-credentials token is re-exchanged on its own");
    assert.equal((await run(["remove", "svc"])).code, 0);

    const missing = await run(["add", `${base}/openapi.json`, "--oauth2", "--token-url", `${base}/token`, "--client-id", "x"]);
    assert.equal(missing.code, 2, "client credentials without a secret is a usage error");

    // Discovery: the provider's published metadata (RFC 8414) fills in the
    // endpoints, from the integration's own URL or an issuer.
    const discover = (url: string) => fetch(`${ui}/api/oauth2/discover`, { method: "POST", headers: authed, body: JSON.stringify({ url }) });
    const found = await (await discover(`${base}/openapi.json`)).json();
    assert.equal(found.tokenUrl, `${base}/token`);
    assert.equal(found.authorizeUrl, `${base}/authorize`);
    assert.equal(found.clientAuth, "basic", "a provider that accepts only Basic says so");
    assert.deepEqual(found.scopes, ["read", "write"]);
    const miss = await discover("http://127.0.0.1:1/");
    assert.equal(miss.status, 400);
    assert.match((await miss.json()).error, /Couldn't find published OAuth settings/);
    // RFC 9728: a resource that only names its authorization server.
    const resource = createServer((req, res) => {
      if (req.url === "/.well-known/oauth-protected-resource") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ resource: "x", authorization_servers: [base] }));
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => resource.listen(0, "127.0.0.1", () => r()));
    try {
      const viaResource = await (await discover(`http://127.0.0.1:${(resource.address() as { port: number }).port}/mcp`)).json();
      assert.equal(viaResource.tokenUrl, `${base}/token`);
    } finally {
      await new Promise<void>((r) => resource.close(() => r()));
    }
    // The CLI: no --token-url, so it looks at the integration's URL; the
    // discovered Basic-only client auth is used without --client-auth.
    const discovered = await run(["add", `${base}/openapi.json`, "--name", "svc2", "--oauth2", "--grant", "client_credentials",
      "--client-id", "svc-client", "--client-secret-env", "MCPM_TEST_CLIENT_SECRET", "--scope", "read"]);
    assert.equal(discovered.code, 0, discovered.stderr);
    assert.match(discovered.stdout + discovered.stderr, /Found the provider's OAuth settings/);
    assert.equal((await run(["call", "svc2_me"])).code, 0);
    assert.equal((await run(["remove", "svc2"])).code, 0);
    const noMetadata = await run(["add", "http://127.0.0.1:1/openapi.json", "--oauth2", "--client-id", "x", "--type", "openapi"]);
    assert.equal(noMetadata.code, 1);
    assert.match(noMetadata.stderr, /Couldn't find published OAuth settings/);
  } finally {
    delete process.env.MCPM_TEST_CLIENT_SECRET;
    await new Promise<void>((r) => provider.close(() => r()));
  }
});

test("the hosted app never enables local-mode private network egress", { skip: !existsSync(join(repoRoot, "src")) && "no hosted app in this checkout" }, async () => {
  // allowPrivateNetworkEgress() exists only for the self-hosted runtime. If
  // anything in the hosted app called it, every workspace's SSRF protection
  // would be off. Grep the whole app tree, not a list of files.
  let offenders = "";
  try {
    offenders = execFileSync("grep", ["-rl", "allowPrivateNetworkEgress", join(repoRoot, "src")], { encoding: "utf8" }).trim();
  } catch (error) {
    // grep exits 1 when nothing matches — the passing case.
    if ((error as { status?: number }).status !== 1) throw error;
  }
  assert.equal(offenders, "", `hosted code must not reference allowPrivateNetworkEgress: ${offenders}`);
});
