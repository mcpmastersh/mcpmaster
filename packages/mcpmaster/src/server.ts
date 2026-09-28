// The local web server: the management UI, its JSON API, and a Streamable
// HTTP MCP endpoint, all on one loopback port.
//
// Threat model — this runs on a developer's machine, where the realistic
// attacker is a web page in their browser, not the network:
//   - Bound to 127.0.0.1 only, never 0.0.0.0.
//   - Host header must be a loopback name for our port, which defeats DNS
//     rebinding (evil.example resolving to 127.0.0.1 still sends its own Host).
//   - Every /api/* and /mcp request needs the local admin token as a Bearer
//     header, compared in constant time. A cross-site page can't read the
//     token (it lives in ~/.mcpmaster/token and reaches the UI via the URL
//     fragment, which is never sent to a server), so it can't forge a call.
//   - A request carrying an Origin must be same-origin, and mutating API
//     calls must be application/json — belt and braces against CSRF.
//   - Strict CSP, no framing, no referrer. Static UI files carry no data.
// Adding an integration can spawn a local command (stdio MCP servers), which
// is exactly why the token is required on every API call, not just some.

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  EngineError,
  discoverOAuth2Endpoints,
  addSource,
  aggregateTools,
  filterTools,
  listTools,
  setToolsEnabled,
  BLOCK_RULE_PATTERN,
  ruleMatches,
  type ToolQuery,
  type ToolAccess,
  applySettings,
  callTool,
  classifyTarget,
  addBlockRule,
  approveNewTools,
  describeBlock,
  describeCredential,
  removeBlockRule,
  executeCode,
  setToolMode,
  toolMode,
  declineSignIn,
  finishSignIn,
  oauthRedirectUrl,
  removeSource,
  signOut,
  startSignIn,
  setToolEnabled,
  suggestName,
  syncSource,
  updateSource,
  type AggregatedTool,
} from "./engine.ts";
import { createMcpServer } from "./mcp.ts";
import { adminToken, homeDir, loadConfig, updateConfig, type Source, type SourceAuth } from "./store.ts";
import { webAsset } from "./web-assets.ts";
import { VERSION } from "./version.ts";

export const DEFAULT_PORT = 7437;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "no-store",
};

const CONTENT_TYPES: Record<string, string> = {
  "/": "text/html; charset=utf-8",
  "/app.js": "text/javascript; charset=utf-8",
  "/app.css": "text/css; charset=utf-8",
  "/logo.svg": "image/svg+xml",
  "/logo.png": "image/png",
};

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: ServerResponse, status: number, body: string | Buffer, contentType: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": contentType, ...extra });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON.stringify(value), "application/json; charset=utf-8");
}

function allowedHosts(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const match = /^Bearer (.+)$/.exec(header ?? "");
  if (!match) return false;
  const given = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) throw new HttpError(413, "That request is too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(400, "Expected a JSON object");
}

// ---------------------------------------------------------------------------
// View models — what the UI may see. Never a credential value.
// ---------------------------------------------------------------------------

type SourceStats = { exposed: number; read: number; write: number; unknown: number };

function sourceView(source: Source, stats?: SourceStats) {
  return {
    id: source.id,
    name: source.name,
    type: source.type,
    url: source.url,
    command: source.command,
    args: source.args,
    enabled: source.enabled,
    readOnly: source.readOnly === true,
    hideNewTools: source.hideNewTools === true,
    pendingReview: source.pendingReview ?? [],
    status: source.status,
    error: source.error,
    toolCount: source.toolCount,
    exposedCount: stats?.exposed ?? 0,
    access: stats ? { read: stats.read, write: stats.write, unknown: stats.unknown } : { read: 0, write: 0, unknown: 0 },
    addedAt: source.addedAt,
    syncedAt: source.syncedAt,
    auth: source.auth,
    credential: describeCredential(source),
  };
}

/** A list row: everything the list shows, and no input schema. */
function toolSummary(tool: AggregatedTool) {
  return {
    name: tool.fullName,
    toolName: tool.toolName,
    description: tool.description,
    integration: tool.source.name,
    integrationId: tool.source.id,
    type: tool.source.type,
    enabled: tool.enabled,
    access: tool.access,
    blockedBy: tool.blockedBy ? { ...tool.blockedBy, label: describeBlock(tool.blockedBy) } : null,
    allowedOverride: tool.allowedOverride,
    method: tool.stored.method,
    path: tool.stored.path,
    operation: tool.stored.operation,
  };
}

/** One tool in full, for the detail pane: the summary plus its input schema. */
function toolView(tool: AggregatedTool) {
  return {
    ...toolSummary(tool),
    inputSchema: JSON.parse(JSON.stringify(tool.inputSchema, (k, v) => (k === "x-in" ? undefined : v))),
  };
}

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ACCESS_VALUES = new Set<ToolAccess>(["read", "write", "unknown"]);

/** Parse list filters from a query string or a JSON body, dropping anything malformed. */
function toolQuery(input: { q?: unknown; integration?: unknown; status?: unknown; access?: unknown }): ToolQuery {
  const q = typeof input.q === "string" ? input.q.slice(0, 200) : undefined;
  const integration = typeof input.integration === "string" && input.integration.length <= 64 ? input.integration : undefined;
  const status = input.status === "exposed" || input.status === "hidden" ? input.status : undefined;
  const access = typeof input.access === "string" && ACCESS_VALUES.has(input.access as ToolAccess) ? (input.access as ToolAccess) : undefined;
  return { q: q || undefined, integration: integration || undefined, status, access };
}

function intParam(value: string | null, fallback: number): number {
  if (value === null || !/^\d{1,6}$/.test(value)) return fallback;
  return Number(value);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function strRecord(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Expected an object of strings");
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") throw new HttpError(400, "Expected an object of strings");
    out[k] = v;
  }
  return out;
}

/** The `auth` object of an add/edit body, as strings only; the engine validates it. */
function authFromBody(value: unknown): SourceAuth | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "auth must be an object");
  const auth = value as Record<string, unknown>;
  const opt = (key: string) => str(auth[key]) || undefined;
  if (auth.type === "oauth2") {
    return {
      type: "oauth2",
      grant: opt("grant"),
      tokenUrl: opt("tokenUrl"),
      authorizeUrl: opt("authorizeUrl"),
      clientId: opt("clientId"),
      registrationUrl: opt("registrationUrl"),
      resource: opt("resource"),
      scope: opt("scope"),
      clientAuth: opt("clientAuth"),
      clientSecretEnv: opt("clientSecretEnv"),
    } as never;
  }
  return { type: auth.type, header: opt("header"), env: opt("env") } as never;
}

async function handleApi(req: IncomingMessage, res: ServerResponse, path: string, mcpUrl: string, port: number): Promise<void> {
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "DELETE") {
    const type = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (type !== "application/json") throw new HttpError(415, "Send JSON");
  }

  if (path === "/api/state" && method === "GET") {
    const config = loadConfig();
    const tools = aggregateTools(config);
    const stats = new Map<string, SourceStats>();
    for (const tool of tools) {
      const entry = stats.get(tool.source.id) ?? { exposed: 0, read: 0, write: 0, unknown: 0 };
      if (tool.enabled) entry.exposed++;
      entry[tool.access]++;
      stats.set(tool.source.id, entry);
    }
    return sendJson(res, 200, {
      version: VERSION,
      home: homeDir(),
      mcpUrl,
      oauthRedirectUrl: oauthRedirectUrl(port),
      allowPrivateNetwork: config.allowPrivateNetwork,
      toolMode: toolMode(config),
      toolModeOverridden: toolMode(config) !== config.toolMode,
      blockRules: config.blockRules.map((rule) => ({
        rule,
        matches: tools.filter((t) => t.blockedBy?.kind === "rule" && t.blockedBy.rule === rule).length,
      })),
      integrations: config.sources.map((source) => sourceView(source, stats.get(source.id))),
      toolCount: tools.length,
      enabledToolCount: tools.filter((t) => t.enabled).length,
    });
  }

  // Filtered and paged on the server: a page of slim rows, never every tool's
  // schema. The detail pane asks for one tool's schema when it opens.
  if (path === "/api/tools" && method === "GET") {
    const params = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
    const query = toolQuery({ q: params.get("q"), integration: params.get("integration"), status: params.get("status"), access: params.get("access") });
    const page = listTools(query, intParam(params.get("offset"), 0), intParam(params.get("limit"), 50));
    return sendJson(res, 200, { ...page, items: page.items.map(toolSummary) });
  }

  const oneTool = /^\/api\/tools\/([^/]+)$/.exec(path);
  if (oneTool && method === "GET" && oneTool[1] !== "call") {
    const name = oneTool[1]; // tool names are [A-Za-z0-9_-], so never percent-encoded
    const tool = TOOL_NAME_PATTERN.test(name) ? aggregateTools().find((t) => t.fullName === name) : undefined;
    if (!tool) throw new HttpError(404, "That tool isn't here anymore");
    return sendJson(res, 200, { tool: toolView(tool) });
  }

  // Block or expose many tools at once: either the names given, or every tool
  // matching a filter (the same filter the list uses, so "all 212 matching"
  // means exactly what the list showed).
  if (path === "/api/tools/bulk" && method === "POST") {
    const body = await readJson(req);
    if (typeof body.enabled !== "boolean") throw new HttpError(400, "Send enabled");
    let names: string[];
    if (Array.isArray(body.names)) {
      names = body.names.filter((n): n is string => typeof n === "string" && TOOL_NAME_PATTERN.test(n));
      if (names.length === 0) throw new HttpError(400, "Send at least one tool name");
    } else if (body.filter && typeof body.filter === "object" && !Array.isArray(body.filter)) {
      names = filterTools(aggregateTools(), toolQuery(body.filter as Record<string, unknown>)).map((t) => t.fullName);
    } else {
      throw new HttpError(400, "Send names or a filter");
    }
    return sendJson(res, 200, { changed: setToolsEnabled(names, body.enabled), matched: names.length });
  }

  // How many tools a rule would hide right now, before it's saved.
  if (path === "/api/rules/preview" && method === "GET") {
    const rule = (new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("rule") ?? "").trim();
    if (!BLOCK_RULE_PATTERN.test(rule)) return sendJson(res, 200, { valid: false, matches: 0 });
    return sendJson(res, 200, { valid: true, matches: aggregateTools().filter((t) => ruleMatches(rule, t.fullName)).length });
  }

  if (path === "/api/tools" && method === "PATCH") {
    const body = await readJson(req);
    const name = str(body.name);
    if (!name || typeof body.enabled !== "boolean") throw new HttpError(400, "Send a tool name and enabled");
    return sendJson(res, 200, { tool: toolView(setToolEnabled(name, body.enabled)) });
  }

  if (path === "/api/rules" && (method === "POST" || method === "DELETE")) {
    const body = await readJson(req);
    const rule = str(body.rule)?.trim();
    if (!rule) throw new HttpError(400, "Send a rule");
    if (method === "POST") return sendJson(res, 201, { rule, matches: addBlockRule(rule) });
    if (!removeBlockRule(rule)) throw new HttpError(404, "No such rule");
    return sendJson(res, 200, { ok: true });
  }

  if (path === "/api/tools/call" && method === "POST") {
    const body = await readJson(req);
    const name = str(body.name);
    if (!name) throw new HttpError(400, "Send a tool name");
    const args = body.arguments ?? {};
    if (typeof args !== "object" || Array.isArray(args) || args === null) throw new HttpError(400, "Arguments must be a JSON object");
    const started = Date.now();
    const outcome = await callTool(name, args as Record<string, unknown>);
    return sendJson(res, 200, { ...outcome, ms: Date.now() - started });
  }

  if (path === "/api/detect" && method === "POST") {
    const body = await readJson(req);
    const target = classifyTarget(str(body.input) ?? "");
    return sendJson(res, 200, { kind: target.kind, suggestedName: suggestName(target) });
  }

  if (path === "/api/oauth2/discover" && method === "POST") {
    const body = await readJson(req);
    return sendJson(res, 200, await discoverOAuth2Endpoints(str(body.url) ?? ""));
  }

  if (path === "/api/integrations" && method === "POST") {
    const body = await readJson(req);
    const source = await addSource({
      input: str(body.input) ?? "",
      name: str(body.name) || undefined,
      type: (str(body.type) || undefined) as never,
      auth: authFromBody(body.auth),
      token: str(body.token) || undefined,
      clientSecret: str(body.clientSecret) || undefined,
      env: strRecord(body.env),
      readOnly: body.readOnly === true,
      hideNewTools: body.hideNewTools === true,
    });
    return sendJson(res, 201, { integration: sourceView(source) });
  }

  if (path === "/api/settings" && method === "PATCH") {
    const body = await readJson(req);
    const hasPrivate = typeof body.allowPrivateNetwork === "boolean";
    const hasMode = body.toolMode === "execute" || body.toolMode === "all";
    if (!hasPrivate && !hasMode) throw new HttpError(400, "Send allowPrivateNetwork or toolMode");
    if (hasMode) setToolMode(body.toolMode as "execute" | "all");
    if (hasPrivate) {
      const config = updateConfig((c) => {
        c.allowPrivateNetwork = body.allowPrivateNetwork as boolean;
      });
      applySettings(config);
    }
    return sendJson(res, 200, { ok: true });
  }

  if (path === "/api/execute" && method === "POST") {
    const body = await readJson(req);
    const started = Date.now();
    const outcome = await executeCode(body.code);
    return sendJson(res, 200, { ...outcome, ms: Date.now() - started });
  }

  const approve = /^\/api\/integrations\/([0-9a-f-]{36})\/approve$/.exec(path);
  if (approve && method === "POST") {
    const body = await readJson(req);
    const names = Array.isArray(body.names) ? body.names.filter((n): n is string => typeof n === "string") : undefined;
    approveNewTools(approve[1], names);
    return sendJson(res, 200, { ok: true });
  }

  const signIn = /^\/api\/integrations\/([0-9a-f-]{36})\/(sign-in|sign-out)$/.exec(path);
  if (signIn && method === "POST") {
    const [, id, action] = signIn;
    if (action === "sign-out") return sendJson(res, 200, { integration: sourceView(await signOut(id)) });
    const url = await startSignIn(id, port);
    return sendJson(res, 200, { authorizationUrl: url });
  }

  const match = /^\/api\/integrations\/([0-9a-f-]{36})(\/sync)?$/.exec(path);
  if (match) {
    const [, id, sync] = match;
    if (sync && method === "POST") return sendJson(res, 200, { integration: sourceView(await syncSource(id)) });
    if (!sync && method === "PATCH") {
      const body = await readJson(req);
      const source = await updateSource(id, {
        enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
        readOnly: typeof body.readOnly === "boolean" ? body.readOnly : undefined,
        hideNewTools: typeof body.hideNewTools === "boolean" ? body.hideNewTools : undefined,
        name: str(body.name),
        auth: authFromBody(body.auth),
        token: str(body.token),
        clientSecret: str(body.clientSecret),
        env: strRecord(body.env),
      });
      return sendJson(res, 200, { integration: sourceView(source) });
    }
    if (!sync && method === "DELETE") {
      await removeSource(id);
      return sendJson(res, 200, { ok: true });
    }
  }

  throw new HttpError(404, "Not found");
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    // Stateless server: no standalone SSE stream and no sessions to delete.
    res.writeHead(405, { ...SECURITY_HEADERS, Allow: "POST" }).end();
    return;
  }
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
  }
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

function messagePage(title: string, message: string, hint?: string): string {
  const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>mcpmaster</title><link rel="stylesheet" href="/app.css"></head><body><main><div class="hero signin"><img src="/logo.svg" alt="" width="44" height="44"><h1>${esc(title)}</h1><p>${esc(message)}</p>${hint ? `<p class="hint">${hint}</p>` : ""}</div></main></body></html>`;
}

function callbackPage(ok: boolean, title: string, message: string): string {
  return messagePage(title, message, ok ? undefined : "Start the sign-in again from mcpmaster.");
}

async function handleOAuthCallback(url: URL, res: ServerResponse): Promise<void> {
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  if (url.searchParams.get("error") || !state || !code) {
    // Tell a waiting CLI/UI now rather than letting it time out.
    if (url.searchParams.get("error") && state) declineSignIn(state);
    return send(res, 400, callbackPage(false, "Sign-in wasn't completed", "The provider didn't approve the sign-in."), "text/html; charset=utf-8");
  }
  try {
    const source = await finishSignIn(state, code);
    const ok = source.status === "ready";
    return send(
      res,
      ok ? 200 : 400,
      callbackPage(ok, ok ? `Connected ${source.name}` : "Signed in, but syncing failed",
        ok ? `${source.toolCount} tools are ready for your agents. You can close this tab.` : source.error ?? "Try syncing it again."),
      "text/html; charset=utf-8",
    );
  } catch (error) {
    const message = error instanceof EngineError ? error.message : "Something went wrong. Please try again.";
    return send(res, 400, callbackPage(false, "Sign-in didn't finish", message), "text/html; charset=utf-8");
  }
}

export type StartedServer = { server: HttpServer; port: number; url: string; mcpUrl: string; token: string };

export function startServer(port = DEFAULT_PORT): Promise<StartedServer> {
  const token = adminToken();
  applySettings();

  return new Promise((resolve, reject) => {
    let actualPort = port;
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname;
      void (async () => {
        try {
          const host = (req.headers.host ?? "").toLowerCase();
          if (!allowedHosts(actualPort).has(host)) throw new HttpError(403, "mcpmaster only answers on localhost");

          const origin = req.headers.origin;
          if (origin !== undefined && origin !== `http://${host}`) throw new HttpError(403, "Cross-origin requests aren't allowed");

          if (path === "/healthz") return sendJson(res, 200, { ok: true, name: "mcpmaster", version: VERSION });

          // The OAuth provider redirects the browser here. It carries no admin
          // token (it's a third-party redirect) — the single-use `state` it
          // must match is what authenticates it (RFC 6749 §10.12).
          if (path === "/oauth/callback" && req.method === "GET") return await handleOAuthCallback(url, res);

          const isApi = path.startsWith("/api/");
          const isMcp = path === "/mcp";
          if (!isApi && !isMcp) {
            if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed");
            const asset = webAsset(path);
            if (asset === null) throw new HttpError(404, "Not found");
            return send(res, 200, asset, CONTENT_TYPES[path]);
          }

          // A link to an API route opened in a browser tab (not a fetch from
          // the UI): say where to go instead of answering with a token error.
          // Nothing is read or started, so the admin token stays required.
          if (isApi && req.method === "GET" && req.headers["sec-fetch-mode"] === "navigate") {
            return send(res, 404, messagePage("That's mcpmaster's API, not a page", "The web UI and the CLI call it for you — to sign in, use Sign in on the integration's page, or run mcpmaster login <name>.", '<a href="/">Open mcpmaster</a>'), "text/html; charset=utf-8");
          }

          if (!tokenMatches(req.headers.authorization, token)) {
            res.writeHead(401, { ...SECURITY_HEADERS, "Content-Type": "application/json", "WWW-Authenticate": 'Bearer realm="mcpmaster"' });
            res.end(JSON.stringify({ error: "Missing or wrong token — run `mcpmaster token` to get it" }));
            return;
          }

          if (isMcp) return await handleMcp(req, res);
          const mcpUrl = `http://127.0.0.1:${actualPort}/mcp`;
          return await handleApi(req, res, path, mcpUrl, actualPort);
        } catch (error) {
          if (res.headersSent) {
            res.end();
            return;
          }
          if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message });
          if (error instanceof EngineError) return sendJson(res, 400, { error: error.message });
          // Real detail goes to our own log, never to the client.
          process.stderr.write(`mcpmaster: request failed: ${error instanceof Error ? error.stack : String(error)}\n`);
          return sendJson(res, 500, { error: "Something went wrong. Please try again." });
        }
      })();
    });

    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      actualPort = typeof address === "object" && address ? address.port : port;
      server.off("error", reject);
      resolve({
        server,
        port: actualPort,
        url: `http://127.0.0.1:${actualPort}`,
        mcpUrl: `http://127.0.0.1:${actualPort}/mcp`,
        token,
      });
    });
  });
}
