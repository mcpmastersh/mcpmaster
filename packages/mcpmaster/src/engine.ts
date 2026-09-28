// The self-hosted runtime's integration engine: turn a pasted URL, file or
// command into an integration, translate it into tools once (cached on disk),
// aggregate every enabled integration into one namespaced tool list, and
// dispatch calls back to the integration that owns each tool.
//
// Translation and remote dispatch are the shared engine in packages/core —
// the same code the hosted mcpmaster app runs — so every outbound HTTP call
// still goes through the one SSRF-mitigated validatedFetch() path. The only
// thing local mode adds is `stdio` integrations (a local MCP server process),
// which the hosted app can't offer.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { allowPrivateNetworkEgress } from "../../core/src/egress.ts";
import { fetchAndTranslateOpenApiSpec, translateOpenApiDocument } from "../../core/src/openapi.ts";
import { introspectAndTranslateGraphqlEndpoint, callGraphqlTool } from "../../core/src/graphql.ts";
import { fetchAndTranslateMcpServer, callMcpProxyTool } from "../../core/src/mcp-proxy.ts";
import { callOpenApiTool, type OutboundAuth, type ToolCallOutcome } from "../../core/src/openapi-call.ts";
import { redactSecrets } from "../../core/src/redact.ts";
import { EXECUTE_TOOL_NAME, buildExecuteTool, createCodeModeHandler } from "../../core/src/code-mode.ts";
import { runInSandbox } from "../../core/src/sandbox.ts";
import { OAuthError, beginOAuth, completeOAuth, forgetOAuth, oauthAccessToken, requiresOAuth } from "./oauth.ts";
import {
  OAuth2Error,
  abandonOAuth2,
  beginOAuth2,
  completeOAuth2,
  discoverOAuth2,
  findOAuth2Pending,
  forgetOAuth2Tokens,
  invalidateOAuth2AccessToken,
  oauth2AccessToken,
  oauth2Configured,
  type OAuth2Discovery,
} from "./oauth2.ts";
import {
  SOURCE_NAME_PATTERN,
  deleteToolCache,
  loadConfig,
  loadSecret,
  loadToolCache,
  newSourceId,
  saveSecret,
  saveToolCache,
  slugifyName,
  updateConfig,
  type Config,
  type ToolMode,
  type Source,
  type SourceAuth,
  type SourceSecret,
  type SourceType,
  type StoredTool,
  type ToolCache,
} from "./store.ts";

export type { ToolCallOutcome };

export class EngineError extends Error {}

const SPEC_FILE_MAX_BYTES = 16 * 1024 * 1024;
const STDIO_TIMEOUT_MS = 30_000;
// Starting a server can include `npx` downloading it on first use.
const STDIO_START_TIMEOUT_MS = 120_000;

/** Apply the local-mode egress setting before any outbound call. */
export function applySettings(config: Config = loadConfig()): void {
  allowPrivateNetworkEgress(config.allowPrivateNetwork);
}

// ---------------------------------------------------------------------------
// Input classification — "paste anything"
// ---------------------------------------------------------------------------

export type Target =
  | { kind: "url"; url: string }
  | { kind: "file"; path: string }
  | { kind: "command"; command: string; args: string[] };

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
}

/**
 * Splits a command line into argv. Quotes group, backslash escapes; no shell
 * expansion ever happens — the process is spawned directly, not via a shell.
 */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < line.length) current += line[++i];
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === "\\" && i + 1 < line.length) {
      current += line[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (has) out.push(current);
      current = "";
      has = false;
    } else {
      current += ch;
      has = true;
    }
  }
  if (quote) throw new EngineError("That command has an unclosed quote");
  if (has) out.push(current);
  return out;
}

export function classifyTarget(input: string): Target {
  const trimmed = input.trim();
  if (!trimmed) throw new EngineError("Paste a URL, a spec file path, or a command");
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return { kind: "url", url: new URL(trimmed).toString() };
    } catch {
      throw new EngineError("That URL isn't valid");
    }
  }
  const maybePath = expandHome(trimmed);
  if (/\.(json|ya?ml)$/i.test(maybePath) && !/\s/.test(maybePath)) {
    return { kind: "file", path: isAbsolute(maybePath) ? maybePath : resolvePath(maybePath) };
  }
  const argv = splitCommandLine(trimmed);
  return { kind: "command", command: argv[0], args: argv.slice(1) };
}

/** Which remote types to try, most likely first, based on the URL's shape. */
function remoteOrder(url: string): Exclude<SourceType, "stdio">[] {
  const path = new URL(url).pathname.toLowerCase();
  if (/graphql|\/gql\b/.test(path)) return ["graphql", "openapi", "mcp"];
  if (/\/(mcp|sse)\b/.test(path)) return ["mcp", "openapi", "graphql"];
  if (/\.(json|ya?ml)$|openapi|swagger|api-docs/.test(path)) return ["openapi", "graphql", "mcp"];
  return ["openapi", "mcp", "graphql"];
}

export function suggestName(target: Target): string {
  if (target.kind === "url") {
    // api.github.com → github, mcp.linear.app → linear, petstore3.swagger.io → petstore3
    const labels = new URL(target.url).hostname.split(".").filter((l) => !/^(www|api|apis|mcp|graphql|gql)$/.test(l));
    return slugifyName(labels.length > 1 ? labels[0] : (labels[0] ?? new URL(target.url).hostname));
  }
  if (target.kind === "file") return slugifyName(target.path.split(/[\\/]/).pop()!.replace(/\.(json|ya?ml)$/i, ""));
  // `npx -y @scope/server-github` → "server-github" → "github"
  const pkg = [target.command, ...target.args].reverse().find((a) => !a.startsWith("-")) ?? target.command;
  const base = pkg.split("/").pop()!.replace(/@[^@]*$/, "").replace(/^(mcp-server-|server-)|(-mcp-server|-mcp)$/g, "");
  return slugifyName(base || pkg);
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

function credentialFor(source: Source, secret: SourceSecret): string | undefined {
  if (source.auth.type !== "bearer" && source.auth.type !== "api_key") return undefined;
  if (source.auth.env) return process.env[source.auth.env] || undefined;
  return secret.token || undefined;
}

export async function resolveAuth(source: Source): Promise<OutboundAuth & { needsAuth?: boolean }> {
  if (source.auth.type === "none") return { headers: {}, secrets: [] };
  if (source.auth.type === "oauth") {
    const result = await oauthAccessToken(source);
    if ("error" in result) return { headers: {}, secrets: [], error: result.error, needsAuth: true };
    return { headers: { Authorization: `Bearer ${result.token}` }, secrets: [result.token] };
  }
  if (source.auth.type === "oauth2") {
    const result = await oauth2AccessToken(source);
    if (!result.ok) {
      if (result.needsAuth && source.status === "ready") markNeedsAuth(source.id);
      return { headers: {}, secrets: [], error: result.error, needsAuth: result.needsAuth };
    }
    return { headers: { Authorization: `Bearer ${result.token}` }, secrets: result.secrets };
  }
  const credential = credentialFor(source, loadSecret(source.id));
  if (!credential) {
    const where = source.auth.env ? `set ${source.auth.env} in the environment mcpmaster runs in` : "add it in mcpmaster";
    return { headers: {}, secrets: [], error: `This integration's credential isn't set — ${where}` };
  }
  if (source.auth.type === "bearer") return { headers: { Authorization: `Bearer ${credential}` }, secrets: [credential] };
  return { headers: { [source.auth.header || "X-API-Key"]: credential }, secrets: [credential] };
}

function stdioSecrets(source: Source): string[] {
  return Object.values(loadSecret(source.id).env ?? {}).filter((v) => v.length > 3);
}

/** Scrub every injected secret out of anything we are about to store or return. */
function scrub<T>(value: T, secrets: string[]): T {
  if (secrets.length === 0) return value;
  return JSON.parse(redactSecrets(JSON.stringify(value), secrets)) as T;
}

// ---------------------------------------------------------------------------
// stdio — a live pool of local MCP server processes
// ---------------------------------------------------------------------------

type StdioEntry = { client: Client; signature: string };
const stdioPool = new Map<string, Promise<StdioEntry>>();

function stdioSignature(source: Source): string {
  return JSON.stringify([source.command, source.args, Object.keys(loadSecret(source.id).env ?? {}).sort(), stdioSecrets(source)]);
}

function withTimeout<T>(promise: Promise<T>, message: string, ms = STDIO_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new EngineError(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// The SDK's default child environment is deliberately minimal (PATH, HOME,
// …) so a server doesn't inherit every secret in the parent's environment.
// Proxy and CA settings are the exception: without them `npx some-server`
// can't even download behind a corporate proxy.
const NETWORK_ENV = /^(https?_proxy|no_proxy|all_proxy|node_extra_ca_certs|ssl_cert_file|ssl_cert_dir|npm_config_(registry|proxy|https_proxy|cafile|strict_ssl))$/i;

function networkEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => NETWORK_ENV.test(e[0]) && e[1] !== undefined));
}

async function connectStdio(source: Source): Promise<StdioEntry> {
  if (!source.command) throw new EngineError("This integration has no command to run");
  const client = new Client({ name: "mcpmaster", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: source.command,
    args: source.args ?? [],
    env: { ...getDefaultEnvironment(), ...networkEnvironment(), ...(loadSecret(source.id).env ?? {}) },
    // The child's stderr is its log, not ours to show an agent; dropping it
    // also keeps our own stdout (the MCP protocol stream in `mcpmaster mcp`)
    // clean.
    stderr: "ignore",
  });
  transport.onclose = () => stdioPool.delete(source.id);
  try {
    await withTimeout(client.connect(transport), "That command didn't start an MCP server in time", STDIO_START_TIMEOUT_MS);
  } catch (error) {
    await client.close().catch(() => {});
    if (error instanceof EngineError) throw error;
    throw new EngineError("Couldn't start that command as an MCP server — check it runs in your terminal");
  }
  return { client, signature: stdioSignature(source) };
}

async function stdioClient(source: Source): Promise<Client> {
  const signature = stdioSignature(source);
  const existing = stdioPool.get(source.id);
  if (existing) {
    const entry = await existing.catch(() => null);
    if (entry && entry.signature === signature) return entry.client;
    await closeStdio(source.id);
  }
  const pending = connectStdio(source);
  stdioPool.set(source.id, pending);
  pending.catch(() => stdioPool.delete(source.id));
  return (await pending).client;
}

export async function closeStdio(sourceId: string): Promise<void> {
  const entry = stdioPool.get(sourceId);
  stdioPool.delete(sourceId);
  if (entry) await entry.then((e) => e.client.close()).catch(() => {});
}

export async function closeAllStdio(): Promise<void> {
  await Promise.all([...stdioPool.keys()].map(closeStdio));
}

// ---------------------------------------------------------------------------
// Translation (sync)
// ---------------------------------------------------------------------------

/**
 * `needsAuth` on success: the tools were read, but calling them needs a
 * sign-in first (an OpenAPI spec is public even when its API isn't).
 */
type Translation = { ok: true; cache: ToolCache; needsAuth?: string } | { ok: false; error: string; needsAuth?: boolean };

function readSpecFile(path: string): string {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    throw new EngineError("That spec file doesn't exist");
  }
  if (size > SPEC_FILE_MAX_BYTES) throw new EngineError("That spec file is too large");
  return readFileSync(path, "utf8");
}

async function translate(source: Source): Promise<Translation> {
  applySettings();
  const auth = await resolveAuth(source);
  // Reading an OpenAPI spec never sends the credential, so a consent that
  // hasn't happened yet doesn't stop us listing its tools.
  const pendingSignIn = auth.error && auth.needsAuth && source.type === "openapi" ? auth.error : undefined;
  if (auth.error && !pendingSignIn) return { ok: false, error: auth.error, needsAuth: auth.needsAuth };

  if (source.type === "stdio") {
    try {
      const client = await stdioClient(source);
      const { tools } = await withTimeout(client.listTools(), "That MCP server took too long to list its tools");
      if (tools.length === 0) return { ok: false, error: "That MCP server has no tools to offer" };
      const stored: StoredTool[] = tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: { type: "object", properties: {}, ...(t.inputSchema as object) } as StoredTool["inputSchema"],
        ...(t.annotations ? { annotations: { readOnlyHint: t.annotations.readOnlyHint, destructiveHint: t.annotations.destructiveHint } } : {}),
      }));
      return { ok: true, cache: scrub({ tools: stored }, stdioSecrets(source)) };
    } catch (error) {
      return { ok: false, error: error instanceof EngineError ? error.message : "Couldn't talk to that MCP server" };
    }
  }

  const url = source.url ?? "";
  let result: { ok: true; tools: unknown[]; baseUrl: string } | { ok: false; error: string };
  if (source.type === "openapi") {
    if (/^https?:\/\//i.test(url)) {
      result = await fetchAndTranslateOpenApiSpec(url);
    } else {
      try {
        result = translateOpenApiDocument(readSpecFile(url));
      } catch (error) {
        result = { ok: false, error: error instanceof EngineError ? error.message : "Couldn't read that spec file" };
      }
      if (result.ok && !/^https?:\/\//i.test(result.baseUrl)) {
        result = { ok: false, error: "A local spec needs an absolute servers[0].url to call" };
      }
    }
  } else if (source.type === "graphql") {
    result = await introspectAndTranslateGraphqlEndpoint(url, auth.headers);
  } else {
    result = await fetchAndTranslateMcpServer(url, auth.headers);
  }
  if (!result.ok) return result;
  const cache = scrub({ tools: result.tools as StoredTool[], baseUrl: result.baseUrl }, auth.secrets);
  return { ok: true, cache, ...(pendingSignIn ? { needsAuth: pendingSignIn } : {}) };
}

function isStale(sourceId: string): boolean {
  return !loadConfig().sources.some((s) => s.id === sourceId);
}

/** Re-translate one integration and persist the result on it. */
export async function syncSource(sourceId: string): Promise<Source> {
  const source = loadConfig().sources.find((s) => s.id === sourceId);
  if (!source) throw new EngineError("That integration doesn't exist");
  if (source.type === "stdio") await closeStdio(source.id);
  const previous = loadToolCache(source.id);
  const outcome = await translate(source);
  if (isStale(sourceId)) throw new EngineError("That integration was removed while it synced");
  if (outcome.ok) saveToolCache(source.id, outcome.cache);
  const currentNames = outcome.ok ? new Set(outcome.cache.tools.map((t) => t.name)) : null;
  // Tools this sync introduced. Only meaningful when there was a previous
  // list to compare against — the first successful sync is what the user
  // chose to add, not "new".
  const introduced =
    outcome.ok && previous ? [...currentNames!].filter((name) => !previous.tools.some((t) => t.name === name)) : [];
  let updated = source;
  updateConfig((config) => {
    const target = config.sources.find((s) => s.id === sourceId);
    if (!target) return;
    target.status = outcome.ok ? (outcome.needsAuth ? "needs_auth" : "ready") : outcome.needsAuth ? "needs_auth" : "failed";
    target.error = outcome.ok ? outcome.needsAuth : outcome.error;
    target.toolCount = outcome.ok ? outcome.cache.tools.length : (loadToolCache(sourceId)?.tools.length ?? 0);
    target.syncedAt = new Date().toISOString();
    if (currentNames) {
      const pending = new Set((target.pendingReview ?? []).filter((name) => currentNames.has(name)));
      if (target.hideNewTools) for (const name of introduced) pending.add(name);
      target.pendingReview = pending.size ? [...pending].sort() : undefined;
    }
    updated = target;
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Add / edit / remove
// ---------------------------------------------------------------------------

export const OAUTH2_NEEDS_TYPE =
  "Choose its type (OpenAPI, GraphQL or MCP server): with browser sign-in there's no token until after it's added, so mcpmaster can't detect it";

export type AddSourceInput = {
  /** A URL, a spec file path, or a command line. */
  input: string;
  name?: string;
  /** Skip auto-detection. */
  type?: SourceType;
  auth?: SourceAuth;
  token?: string;
  /** oauth2: the client secret, stored locally (unless read from the environment). */
  clientSecret?: string;
  env?: Record<string, string>;
  readOnly?: boolean;
  hideNewTools?: boolean;
};

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
// Printable, no control characters: these end up in URLs and form bodies.
const PRINTABLE = /^[\x21-\x7e][\x20-\x7e]*$/;

/**
 * An OAuth endpoint carries the client secret and tokens, so it must be
 * https — plain http only to this machine itself. (Other private addresses
 * are still up to the private-network setting, enforced by validatedFetch.)
 */
function validateEndpoint(value: unknown, what: string): string {
  let url: URL;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    throw new EngineError(`The ${what} isn't a valid URL`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || /^127\./.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new EngineError(`The ${what} must be an https URL`);
  if (url.username || url.password) throw new EngineError(`The ${what} can't contain credentials`);
  url.hash = "";
  return url.toString();
}

/**
 * A provider's published OAuth endpoints (RFC 8414 / OpenID Connect / RFC
 * 9728), from its issuer URL or the integration's own URL. Only fills in a
 * form: whatever comes back is validated again on add.
 */
export async function discoverOAuth2Endpoints(input: string): Promise<OAuth2Discovery> {
  applySettings();
  try {
    return await discoverOAuth2(input);
  } catch (error) {
    throw new EngineError(error instanceof OAuth2Error ? error.message : "Couldn't look up the provider's OAuth settings");
  }
}

function validateOAuth2(auth: Extract<SourceAuth, { type: "oauth2" }>): SourceAuth {
  if (auth.grant !== "client_credentials" && auth.grant !== "authorization_code") {
    throw new EngineError("The OAuth2 grant is client_credentials or authorization_code");
  }
  const clientId = String(auth.clientId ?? "").trim();
  // No client ID is fine for a browser sign-in with a registration
  // endpoint: mcpmaster registers its own client then (RFC 7591).
  const registers = !clientId && auth.grant === "authorization_code" && Boolean(auth.registrationUrl);
  if (!registers && !clientId) {
    throw new EngineError(auth.grant === "authorization_code"
      ? "Add the OAuth2 client ID — this provider doesn't let mcpmaster register one itself"
      : "Add the OAuth2 client ID");
  }
  if (clientId.length > 512 || (clientId && !PRINTABLE.test(clientId))) throw new EngineError("That client ID isn't valid");
  const clean: Extract<SourceAuth, { type: "oauth2" }> = {
    type: "oauth2",
    grant: auth.grant,
    tokenUrl: validateEndpoint(auth.tokenUrl, "token URL"),
    ...(clientId ? { clientId } : {}),
  };
  if (registers) clean.registrationUrl = validateEndpoint(auth.registrationUrl, "registration URL");
  if (auth.resource) clean.resource = validateEndpoint(auth.resource, "resource");
  if (auth.grant === "authorization_code") {
    if (!auth.authorizeUrl) throw new EngineError("Add the provider's authorization URL");
    clean.authorizeUrl = validateEndpoint(auth.authorizeUrl, "authorization URL");
  }
  const scope = String(auth.scope ?? "").trim();
  if (scope) {
    if (scope.length > 1024 || !PRINTABLE.test(scope)) throw new EngineError("That scope isn't valid");
    clean.scope = scope;
  }
  if (auth.clientAuth === "basic") clean.clientAuth = "basic";
  if (auth.clientSecretEnv) {
    if (!ENV_NAME.test(auth.clientSecretEnv)) throw new EngineError("That environment variable name isn't valid");
    clean.clientSecretEnv = auth.clientSecretEnv;
  }
  return clean;
}

function validateAuth(auth: SourceAuth | undefined): SourceAuth {
  if (!auth || auth.type === "none") return { type: "none" };
  if (auth.type === "oauth2") return validateOAuth2(auth);
  if (auth.type !== "bearer" && auth.type !== "api_key") throw new EngineError("Unknown auth type");
  const clean: SourceAuth = { type: auth.type };
  if (auth.header) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(auth.header)) throw new EngineError("That header name isn't valid");
    clean.header = auth.header;
  }
  if (auth.env) {
    if (!ENV_NAME.test(auth.env)) throw new EngineError("That environment variable name isn't valid");
    clean.env = auth.env;
  }
  return clean;
}

function validateEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) throw new EngineError(`"${key}" isn't a valid environment variable name`);
    if (typeof value !== "string") throw new EngineError(`${key} needs a value`);
    out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function uniqueName(desired: string, config: Config): string {
  const taken = new Set(config.sources.map((s) => s.name));
  if (!taken.has(desired)) return desired;
  for (let i = 2; ; i++) {
    const candidate = `${desired.slice(0, 36)}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export async function addSource(input: AddSourceInput): Promise<Source> {
  const target = classifyTarget(input.input);
  const auth = validateAuth(input.auth);
  const env = validateEnv(input.env);
  if (auth.type === "oauth2" && auth.grant === "client_credentials" && !auth.clientSecretEnv && !input.clientSecret) {
    throw new EngineError("Add the OAuth2 client secret, or read it from an environment variable");
  }
  if (auth.type === "oauth2" && target.kind === "command") throw new EngineError("A local command can't use OAuth2 — pass its credentials as environment variables");
  // Browser sign-in happens after the integration is saved, so there is no
  // token yet to probe a URL with: its type has to be given, not detected.
  if (auth.type === "oauth2" && auth.grant === "authorization_code" && target.kind === "url" && !input.type) {
    throw new EngineError(OAUTH2_NEEDS_TYPE);
  }

  const config = loadConfig();
  let name: string;
  if (input.name) {
    if (!SOURCE_NAME_PATTERN.test(input.name)) {
      throw new EngineError("Names are lowercase letters, numbers and dashes (up to 40)");
    }
    if (config.sources.some((s) => s.name === input.name)) throw new EngineError(`An integration named "${input.name}" already exists`);
    name = input.name;
  } else {
    name = uniqueName(suggestName(target), config);
  }

  const base = {
    id: newSourceId(),
    name,
    auth,
    enabled: true,
    ...(input.readOnly ? { readOnly: true } : {}),
    ...(input.hideNewTools ? { hideNewTools: true } : {}),
    status: "syncing" as const,
    toolCount: 0,
    addedAt: new Date().toISOString(),
  };

  let candidates: Source[];
  if (target.kind === "command") {
    if (input.type && input.type !== "stdio") throw new EngineError("A command can only be a local MCP server");
    candidates = [{ ...base, type: "stdio", command: target.command, args: target.args }];
  } else if (target.kind === "file") {
    if (input.type && input.type !== "openapi") throw new EngineError("A spec file can only be an OpenAPI spec");
    candidates = [{ ...base, type: "openapi", url: target.path }];
  } else {
    const order = input.type ? [input.type] : remoteOrder(target.url);
    if (order.includes("stdio")) throw new EngineError("A URL can't be a local command");
    candidates = order.map((type) => ({ ...base, type, url: target.url }));
  }

  // Credentials are saved before translation because introspection itself is
  // commonly auth-gated; they are removed again if nothing recognises the input.
  const oauth2 = auth.type === "oauth2" && input.clientSecret && !auth.clientSecretEnv ? { clientSecret: input.clientSecret } : undefined;
  if (input.token || env || oauth2) saveSecret(base.id, { token: input.token || undefined, env, oauth2 });

  // An authorization_code integration has no token until the user consents,
  // so a remote endpoint behind it can't be probed yet. Keep it, waiting for
  // that sign-in — but only once we know what it is.
  const needsConsent = auth.type === "oauth2" && auth.grant === "authorization_code";

  let firstError: string | null = null;
  let consentCandidate: Source | null = null;
  for (const candidate of candidates) {
    const outcome = await translate(candidate);
    if (outcome.ok) {
      saveToolCache(candidate.id, outcome.cache);
      const source: Source = {
        ...candidate,
        status: outcome.needsAuth ? "needs_auth" : "ready",
        ...(outcome.needsAuth ? { error: outcome.needsAuth } : {}),
        toolCount: outcome.cache.tools.length,
        syncedAt: new Date().toISOString(),
      };
      updateConfig((c) => {
        // A concurrent add may have claimed the name meanwhile.
        if (c.sources.some((s) => s.name === source.name)) source.name = uniqueName(source.name, c);
        c.sources.push(source);
      });
      return source;
    }
    // A remote MCP server that answers 401 wants its own OAuth sign-in. Save
    // it as needing one; the caller then starts the flow (startSignIn).
    if (candidate.type === "mcp" && candidate.auth.type === "none" && (await requiresOAuth(candidate.url!))) {
      const source: Source = { ...candidate, auth: { type: "oauth" }, status: "needs_auth", error: "Sign in to finish connecting" };
      updateConfig((c) => {
        if (c.sources.some((s) => s.name === source.name)) source.name = uniqueName(source.name, c);
        c.sources.push(source);
      });
      return source;
    }
    if (needsConsent && outcome.needsAuth) consentCandidate ??= candidate;
    firstError ??= outcome.error;
  }

  if (consentCandidate) {
    const source: Source = { ...consentCandidate, status: "needs_auth", error: "Sign in to finish connecting" };
    updateConfig((c) => {
      if (c.sources.some((s) => s.name === source.name)) source.name = uniqueName(source.name, c);
      c.sources.push(source);
    });
    return source;
  }

  await closeStdio(base.id);
  saveSecret(base.id, null);
  if (candidates.length > 1) {
    throw new EngineError(
      `Couldn't recognise that as an OpenAPI spec, GraphQL endpoint or MCP server (${firstError}). Pick a type to see why.`,
    );
  }
  throw new EngineError(firstError ?? "Couldn't add that integration");
}

export type UpdateSourceInput = {
  enabled?: boolean;
  readOnly?: boolean;
  hideNewTools?: boolean;
  name?: string;
  auth?: SourceAuth;
  /** Replace the stored token. An empty string clears it. */
  token?: string;
  /** oauth2: replace the stored client secret. */
  clientSecret?: string;
  /** Replace the stdio environment. */
  env?: Record<string, string>;
};

export async function updateSource(sourceId: string, input: UpdateSourceInput): Promise<Source> {
  const existing = loadConfig().sources.find((s) => s.id === sourceId);
  if (!existing) throw new EngineError("That integration doesn't exist");
  if (input.name !== undefined) {
    if (!SOURCE_NAME_PATTERN.test(input.name)) throw new EngineError("Names are lowercase letters, numbers and dashes (up to 40)");
    if (loadConfig().sources.some((s) => s.name === input.name && s.id !== sourceId)) {
      throw new EngineError(`An integration named "${input.name}" already exists`);
    }
  }
  const auth = input.auth ? validateAuth(input.auth) : undefined;
  const env = input.env ? validateEnv(input.env) ?? {} : undefined;

  if (auth?.type === "oauth2" && existing.type === "stdio") throw new EngineError("A local command can't use OAuth2 — pass its credentials as environment variables");

  if (input.token !== undefined || env !== undefined || input.clientSecret !== undefined || auth !== undefined) {
    const current = loadSecret(sourceId);
    const next = { ...current };
    if (input.token !== undefined) next.token = input.token || undefined;
    if (env !== undefined) next.env = env;
    if (auth && JSON.stringify(auth) !== JSON.stringify(existing.auth)) {
      // A changed configuration invalidates every token issued under the old
      // one; an OAuth2 client secret carries over unless it's replaced.
      next.oauth = undefined;
      next.oauth2 = auth.type === "oauth2" && !auth.clientSecretEnv && current.oauth2?.clientSecret
        ? { clientSecret: current.oauth2.clientSecret }
        : undefined;
    }
    if (input.clientSecret !== undefined) {
      next.oauth2 = { ...next.oauth2, clientSecret: input.clientSecret || undefined };
    }
    saveSecret(sourceId, next);
  }

  updateConfig((config) => {
    const target = config.sources.find((s) => s.id === sourceId);
    if (!target) return;
    if (input.enabled !== undefined) target.enabled = input.enabled;
    if (input.readOnly !== undefined) target.readOnly = input.readOnly || undefined;
    if (input.hideNewTools !== undefined) {
      target.hideNewTools = input.hideNewTools || undefined;
      // Turning review off exposes whatever was waiting on it.
      if (!input.hideNewTools) target.pendingReview = undefined;
    }
    if (input.name !== undefined) {
      const oldPrefix = `${target.name}_`;
      const rename = (t: string) => (t.startsWith(oldPrefix) ? `${input.name}_${t.slice(oldPrefix.length)}` : t);
      config.disabledTools = config.disabledTools.map(rename);
      config.allowedTools = config.allowedTools.map(rename);
      target.name = input.name;
    }
    if (auth) target.auth = auth;
  });

  const credentialsChanged = auth !== undefined || input.token !== undefined || env !== undefined || input.clientSecret !== undefined;
  if (credentialsChanged) return syncSource(sourceId);
  if (input.enabled === false) await closeStdio(sourceId);
  return loadConfig().sources.find((s) => s.id === sourceId)!;
}

export async function removeSource(sourceId: string): Promise<void> {
  const source = loadConfig().sources.find((s) => s.id === sourceId);
  if (!source) throw new EngineError("That integration doesn't exist");
  await closeStdio(sourceId);
  updateConfig((config) => {
    config.sources = config.sources.filter((s) => s.id !== sourceId);
    const prefix = `${source.name}_`;
    config.disabledTools = config.disabledTools.filter((t) => !t.startsWith(prefix));
    config.allowedTools = config.allowedTools.filter((t) => !t.startsWith(prefix));
  });
  deleteToolCache(sourceId);
  saveSecret(sourceId, null);
}

export function findSource(ref: string): Source | undefined {
  const sources = loadConfig().sources;
  return sources.find((s) => s.name === ref) ?? sources.find((s) => s.id === ref);
}

/** What the UI/CLI may show about an integration's credential — never its value. */
export function describeCredential(source: Source): { configured: boolean; envKeys: string[] } {
  const secret = loadSecret(source.id);
  return {
    configured:
      source.auth.type === "none"
        ? true
        : source.auth.type === "oauth"
          ? Boolean(secret.oauth?.tokens?.access_token)
          : source.auth.type === "oauth2"
            ? oauth2Configured(source)
            : Boolean(credentialFor(source, secret)),
    envKeys: Object.keys(secret.env ?? {}),
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** Why a tool is hidden from agents. Null when it's exposed. */
export type BlockReason =
  | { kind: "tool" }
  | { kind: "rule"; rule: string }
  | { kind: "read-only" }
  | { kind: "new" };

export type AggregatedTool = {
  /** What agents see and call: `<integration>_<tool>`, client-safe. */
  fullName: string;
  toolName: string;
  description: string;
  inputSchema: StoredTool["inputSchema"];
  source: Source;
  stored: StoredTool;
  baseUrl?: string;
  /**
   * Does the tool only read? "unknown" when the integration doesn't say (an
   * MCP tool without annotations) — read-only mode treats that as a write.
   */
  access: ToolAccess;
  blockedBy: BlockReason | null;
  /** Exposed only because it's explicitly allowed over a rule. */
  allowedOverride: boolean;
  enabled: boolean;
};

const MAX_TOOL_NAME = 64;

/**
 * `<integration>_<tool>`, restricted to [A-Za-z0-9_-] and 64 characters —
 * the intersection every mainstream MCP client and model API accepts.
 * Integration names are slugs without underscores, so the first `_` always
 * separates the namespace from the tool.
 */
export function namespacedToolName(sourceName: string, toolName: string, taken: Set<string>): string {
  const clean = toolName.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "tool";
  let full = `${sourceName}_${clean}`;
  if (full.length > MAX_TOOL_NAME || taken.has(full)) {
    const hash = createHash("sha256").update(`${sourceName}\0${toolName}`).digest("hex").slice(0, 6);
    full = `${full.slice(0, MAX_TOOL_NAME - 7)}_${hash}`;
  }
  taken.add(full);
  return full;
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type ToolAccess = "read" | "write" | "unknown";

/** Classify a tool as reading or writing from what its integration declares. */
export function toolAccess(type: SourceType, stored: StoredTool): ToolAccess {
  if (type === "openapi") return stored.method && READ_METHODS.has(stored.method.toUpperCase()) ? "read" : "write";
  if (type === "graphql") return stored.operation === "query" ? "read" : "write";
  // MCP servers may annotate their tools; without an annotation we can't know.
  const hints = stored.annotations;
  if (hints?.readOnlyHint === true && hints.destructiveHint !== true) return "read";
  if (hints?.readOnlyHint === false || hints?.destructiveHint === true) return "write";
  return "unknown";
}

export const BLOCK_RULE_PATTERN = /^[A-Za-z0-9_*?-]{1,128}$/;

/** `*` matches any run of characters, `?` exactly one; everything else is literal. */
const ruleRegexes = new Map<string, RegExp>();

export function ruleMatches(rule: string, fullName: string): boolean {
  // Compiled once per rule: every listing evaluates every rule against every
  // tool, which is rules × tools regex compilations otherwise.
  let regex = ruleRegexes.get(rule);
  if (!regex) {
    const source = rule.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    regex = new RegExp(`^${source}$`);
    if (ruleRegexes.size > 512) ruleRegexes.clear();
    ruleRegexes.set(rule, regex);
  }
  return regex.test(fullName);
}

/**
 * Precedence, strongest first:
 *   1. explicit allow   (a tool the user switched on over a rule)
 *   2. explicit block   (a tool the user switched off)
 *   3. new, not yet reviewed (integration hides new tools)
 *   4. read-only integration, and the tool writes
 *   5. a block rule matches
 * Rules are evaluated here, on every listing and call, so they cover tools
 * that arrive in a future sync without anyone re-applying them.
 */
function blockReasonFor(
  config: Config,
  sets: { allowed: Set<string>; disabled: Set<string> },
  source: Source,
  stored: StoredTool,
  fullName: string,
  access: ToolAccess,
): BlockReason | null {
  if (sets.allowed.has(fullName)) return null;
  if (sets.disabled.has(fullName)) return { kind: "tool" };
  if (source.pendingReview?.includes(stored.name)) return { kind: "new" };
  if (source.readOnly && access !== "read") return { kind: "read-only" };
  const rule = config.blockRules.find((r) => ruleMatches(r, fullName));
  return rule ? { kind: "rule", rule } : null;
}

export function aggregateTools(config: Config = loadConfig()): AggregatedTool[] {
  const sets = { allowed: new Set(config.allowedTools), disabled: new Set(config.disabledTools) };
  const out: AggregatedTool[] = [];
  const taken = new Set<string>();
  for (const source of config.sources) {
    if (!source.enabled) continue;
    const cache = loadToolCache(source.id);
    if (!cache) continue;
    for (const stored of cache.tools) {
      const fullName = namespacedToolName(source.name, stored.name, taken);
      const access = toolAccess(source.type, stored);
      const blockedBy = blockReasonFor(config, sets, source, stored, fullName, access);
      const wouldBlock = sets.allowed.has(fullName)
        ? blockReasonFor(config, { allowed: new Set(), disabled: sets.disabled }, source, stored, fullName, access)
        : null;
      out.push({
        fullName,
        toolName: stored.name,
        description: stored.description,
        inputSchema: stored.inputSchema,
        source,
        stored,
        baseUrl: cache.baseUrl,
        access,
        blockedBy,
        allowedOverride: wouldBlock !== null,
        enabled: blockedBy === null,
      });
    }
  }
  return out;
}

/** The tools an agent is offered: enabled integrations, minus anything blocked. */
export function agentTools(config: Config = loadConfig()): AggregatedTool[] {
  return aggregateTools(config).filter((t) => t.enabled);
}

/**
 * Switch one tool on or off, explicitly. Switching on a tool that a rule,
 * read-only or review still hides records an explicit allow, so it wins over
 * them; switching it off records an explicit block. A reviewed tool leaves
 * its integration's review list either way.
 */
export function setToolEnabled(fullName: string, enabled: boolean): AggregatedTool {
  if (!aggregateTools().some((t) => t.fullName === fullName)) throw new EngineError(`Unknown tool "${fullName}"`);
  setToolsEnabled([fullName], enabled);
  return aggregateTools().find((t) => t.fullName === fullName)!;
}

/**
 * The bulk form of setToolEnabled, in one config write. Unknown names are
 * ignored. Returns how many tools changed state.
 */
export function setToolsEnabled(fullNames: string[], enabled: boolean): number {
  const before = aggregateTools();
  const wanted = new Set(fullNames);
  const targets = before.filter((t) => wanted.has(t.fullName));
  if (targets.length === 0) return 0;
  updateConfig((config) => {
    const allowed = new Set(config.allowedTools);
    const disabled = new Set(config.disabledTools);
    for (const tool of targets) {
      allowed.delete(tool.fullName);
      disabled.delete(tool.fullName);
      const source = config.sources.find((s) => s.id === tool.source.id);
      if (source?.pendingReview) {
        source.pendingReview = source.pendingReview.filter((n) => n !== tool.toolName);
        if (source.pendingReview.length === 0) source.pendingReview = undefined;
      }
      if (enabled) {
        const still = source
          ? blockReasonFor(config, { allowed: new Set(), disabled: new Set() }, source, tool.stored, tool.fullName, tool.access)
          : null;
        if (still) allowed.add(tool.fullName);
      } else {
        disabled.add(tool.fullName);
      }
    }
    config.allowedTools = [...allowed].sort();
    config.disabledTools = [...disabled].sort();
  });
  return targets.filter((t) => t.enabled !== enabled).length;
}

/** Add a block rule. Returns how many current tools it hides. */
export function addBlockRule(rule: string): number {
  if (!BLOCK_RULE_PATTERN.test(rule)) {
    throw new EngineError("A rule is a tool name with * and ? wildcards, e.g. github_delete_*");
  }
  updateConfig((config) => {
    if (!config.blockRules.includes(rule)) config.blockRules = [...config.blockRules, rule];
  });
  return aggregateTools().filter((t) => t.blockedBy?.kind === "rule" && t.blockedBy.rule === rule).length;
}

export function removeBlockRule(rule: string): boolean {
  let removed = false;
  updateConfig((config) => {
    removed = config.blockRules.includes(rule);
    config.blockRules = config.blockRules.filter((r) => r !== rule);
  });
  return removed;
}

/** Mark new tools as reviewed and expose them (all pending, or just `names`). */
export function approveNewTools(sourceId: string, names?: string[]): void {
  updateConfig((config) => {
    const source = config.sources.find((s) => s.id === sourceId);
    if (!source?.pendingReview) return;
    source.pendingReview = names ? source.pendingReview.filter((n) => !names.includes(n)) : undefined;
    if (source.pendingReview?.length === 0) source.pendingReview = undefined;
  });
}

/** Human wording for a block reason — shared by the CLI and the web UI. */
export function describeBlock(reason: BlockReason): string {
  if (reason.kind === "tool") return "blocked";
  if (reason.kind === "rule") return `rule ${reason.rule}`;
  if (reason.kind === "read-only") return "read-only integration";
  return "new, not reviewed";
}

// ---------------------------------------------------------------------------
// Listing: search, filters and pages
// ---------------------------------------------------------------------------

/**
 * What the web UI and CLI ask for. A few integrations can bring well over a
 * thousand tools, so listing is filtered and paged here, on the server: the
 * browser only ever holds one page of slim rows, never every schema.
 */
export type ToolQuery = {
  /** Words that must all appear in the name, description or integration. */
  q?: string;
  /** An integration's id or name. */
  integration?: string;
  status?: "exposed" | "hidden";
  access?: ToolAccess;
};

export type ToolPage = {
  items: AggregatedTool[];
  /** How many tools match the whole query (every page). */
  total: number;
  offset: number;
  limit: number;
  /** Exposed/hidden counts for the query without its status filter. */
  counts: { all: number; exposed: number; hidden: number };
  /** Per-integration counts for the query without its integration filter. */
  integrations: { id: string; name: string; count: number }[];
};

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

function queryWords(q: string | undefined): string[] {
  return (q ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 16);
}

/** 0 = no match. Name matches rank above description-only matches. */
function searchScore(tool: AggregatedTool, words: string[]): number {
  if (words.length === 0) return 1;
  const name = tool.fullName.toLowerCase();
  const haystack = `${name} ${tool.description.toLowerCase()} ${tool.source.name.toLowerCase()}`;
  if (!words.every((w) => haystack.includes(w))) return 0;
  if (words.length === 1 && name === words[0]) return 3;
  return words.every((w) => name.includes(w)) ? 2 : 1;
}

type Part = "search" | "integration" | "status" | "access";

function matcher(query: ToolQuery, skip?: Part) {
  const words = queryWords(query.q);
  return (tool: AggregatedTool): number => {
    if (skip !== "integration" && query.integration &&
      tool.source.id !== query.integration && tool.source.name !== query.integration) return 0;
    if (skip !== "status" && query.status && (query.status === "exposed") !== tool.enabled) return 0;
    if (skip !== "access" && query.access && tool.access !== query.access) return 0;
    return searchScore(tool, words);
  };
}

/** Every tool matching the query, best matches first (stable otherwise). */
export function filterTools(tools: AggregatedTool[], query: ToolQuery): AggregatedTool[] {
  const score = matcher(query);
  return tools
    .map((tool, index) => ({ tool, index, score: score(tool) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((x) => x.tool);
}

export function listTools(query: ToolQuery, offset = 0, limit = DEFAULT_PAGE_SIZE, config: Config = loadConfig()): ToolPage {
  const tools = aggregateTools(config);
  const matching = filterTools(tools, query);
  const start = Math.max(0, Math.floor(offset));
  const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(limit)));

  const statusFree = tools.filter((t) => matcher(query, "status")(t) > 0);
  const exposed = statusFree.filter((t) => t.enabled).length;

  const byIntegration = new Map<string, { id: string; name: string; count: number }>();
  for (const source of config.sources) if (source.enabled) byIntegration.set(source.id, { id: source.id, name: source.name, count: 0 });
  const integrationFree = matcher(query, "integration");
  for (const tool of tools) if (integrationFree(tool) > 0) byIntegration.get(tool.source.id)!.count++;

  return {
    items: matching.slice(start, start + size),
    total: matching.length,
    offset: start,
    limit: size,
    counts: { all: statusFree.length, exposed, hidden: statusFree.length - exposed },
    integrations: [...byIntegration.values()],
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function callTool(fullName: string, args: Record<string, unknown>): Promise<ToolCallOutcome> {
  const config = loadConfig();
  applySettings(config);
  const tool = agentTools(config).find((t) => t.fullName === fullName);
  if (!tool) return { ok: false, error: `Unknown tool "${fullName}"` };
  const outcome = await dispatch(tool, args);
  // The provider rejected an OAuth2 token it issued (revoked, rotated, or it
  // never said when it expires): drop it and try once more with a fresh one.
  // A 401 means the request wasn't processed, so the retry can't double it.
  if (!outcome.ok && tool.source.auth.type === "oauth2" && /HTTP 401\b/.test(outcome.error)) {
    invalidateOAuth2AccessToken(tool.source.id);
    return dispatch(tool, args);
  }
  return outcome;
}

async function dispatch(tool: AggregatedTool, args: Record<string, unknown>): Promise<ToolCallOutcome> {
  const { source, stored } = tool;

  if (source.type === "openapi") {
    return callOpenApiTool(
      {
        baseUrl: tool.baseUrl,
        method: stored.method,
        path: stored.path,
        params: stored.params ?? null,
        inputSchema: { type: "object", properties: stored.inputSchema.properties, required: stored.inputSchema.required ?? [] },
      },
      args,
      () => resolveAuth(source),
    );
  }

  if (source.type === "graphql") {
    if (!tool.baseUrl || !stored.operation || stored.selection === undefined || !stored.argTypes) {
      return { ok: false, error: "This integration is missing its call details — try re-syncing it" };
    }
    const auth = await resolveAuth(source);
    if (auth.error) return { ok: false, error: auth.error };
    const outcome = await callGraphqlTool(
      tool.baseUrl,
      { name: stored.name, operation: stored.operation, selection: stored.selection, argTypes: stored.argTypes },
      args,
      auth.headers,
    );
    return scrub(outcome, auth.secrets);
  }

  if (source.type === "mcp") {
    if (!tool.baseUrl) return { ok: false, error: "This integration is missing its server URL — try re-syncing it" };
    const auth = await resolveAuth(source);
    if (auth.error) {
      if (auth.needsAuth) markNeedsAuth(source.id);
      return { ok: false, error: auth.error };
    }
    const outcome = scrub(await callMcpProxyTool(tool.baseUrl, stored.name, args, auth.headers), auth.secrets);
    // The provider revoked or expired the token server-side: drop it so the
    // next sign-in starts clean rather than retrying a dead token.
    if (!outcome.ok && source.auth.type === "oauth" && /HTTP 401/.test(outcome.error)) {
      forgetOAuth(source.id);
      markNeedsAuth(source.id);
      return { ok: false, error: "This integration's sign-in expired — sign in again in mcpmaster" };
    }
    return outcome;
  }

  try {
    const client = await stdioClient(source);
    const result = await withTimeout(
      client.callTool({ name: stored.name, arguments: args }),
      "That tool took too long to respond",
    );
    const content = (result.content ?? []) as { type: string; text?: string }[];
    const text = content.map((part) => (part.type === "text" ? part.text ?? "" : `[${part.type} content]`)).filter(Boolean).join("\n");
    const outcome: ToolCallOutcome = result.isError ? { ok: false, error: text || "That tool call failed" } : { ok: true, text };
    return scrub(outcome, stdioSecrets(source));
  } catch (error) {
    return { ok: false, error: error instanceof EngineError ? error.message : "That MCP server stopped responding — try re-syncing it" };
  }
}

// ---------------------------------------------------------------------------
// OAuth sign-in (remote MCP servers)
// ---------------------------------------------------------------------------

/** The status message while a browser sign-in is in progress. */
export const SIGN_IN_WAITING = "Waiting for you to finish signing in";

function markNeedsAuth(sourceId: string): void {
  updateConfig((config) => {
    const target = config.sources.find((s) => s.id === sourceId);
    if (target) {
      target.status = "needs_auth";
      target.error = "Sign in again to reconnect";
    }
  });
}

export function oauthRedirectUrl(port: number): string {
  return `http://127.0.0.1:${port}/oauth/callback`;
}

/**
 * Start (or restart) an OAuth sign-in. Always from scratch: any cached client
 * registration and tokens are discarded first, so a new client is registered.
 * Returns the URL to open, or null if the server authorized without a browser.
 */
export async function startSignIn(sourceId: string, port: number): Promise<string | null> {
  const source = loadConfig().sources.find((s) => s.id === sourceId);
  if (!source) throw new EngineError("That integration doesn't exist");
  if (source.auth.type === "oauth2") return startOAuth2SignIn(source, port);
  if (source.type !== "mcp") throw new EngineError("This integration doesn't use OAuth — set its credential instead");
  updateConfig((config) => {
    const target = config.sources.find((s) => s.id === sourceId);
    if (target) {
      target.auth = { type: "oauth" };
      target.status = "needs_auth";
      target.error = SIGN_IN_WAITING;
    }
  });
  // Any static credential it had is replaced by the OAuth one; beginOAuth
  // then discards any earlier OAuth state too.
  saveSecret(sourceId, {});
  try {
    const url = await beginOAuth({ ...source, auth: { type: "oauth" } }, oauthRedirectUrl(port));
    if (url) return url;
  } catch (error) {
    throw new EngineError(error instanceof OAuthError ? error.message : "Couldn't start the sign-in");
  }
  await syncSource(sourceId);
  return null;
}

/**
 * OAuth2 with the user's own client. client_credentials needs no browser:
 * "signing in" re-exchanges the token. authorization_code discards the old
 * grant and returns the provider's consent URL.
 */
async function startOAuth2SignIn(source: Source, port: number): Promise<string | null> {
  forgetOAuth2Tokens(source.id);
  if (source.auth.type !== "oauth2" || source.auth.grant === "client_credentials") {
    const synced = await syncSource(source.id);
    if (synced.status !== "ready") throw new EngineError(synced.error ?? "Couldn't get a token from the provider");
    return null;
  }
  updateConfig((config) => {
    const target = config.sources.find((s) => s.id === source.id);
    if (target) {
      target.status = "needs_auth";
      target.error = SIGN_IN_WAITING;
    }
  });
  try {
    return await beginOAuth2(source, oauthRedirectUrl(port));
  } catch (error) {
    throw new EngineError(error instanceof OAuth2Error ? error.message : "Couldn't start the sign-in");
  }
}

/**
 * The provider sent the browser back with an error (the user declined, or
 * the client isn't allowed): burn the pending sign-in and say so, so a
 * waiting CLI stops instead of timing out.
 */
export function declineSignIn(state: string): void {
  const source = findOAuth2Pending(state);
  if (!source) return;
  abandonOAuth2(source);
  updateConfig((config) => {
    const target = config.sources.find((s) => s.id === source.id);
    if (target) target.error = "The sign-in wasn't approved — sign in again to connect";
  });
}

/** The browser came back from the provider: exchange the code and sync. */
export async function finishSignIn(state: string, code: string): Promise<Source> {
  const oauth2Source = findOAuth2Pending(state);
  if (oauth2Source) {
    try {
      await completeOAuth2(oauth2Source, code);
    } catch (error) {
      updateConfig((config) => {
        const target = config.sources.find((s) => s.id === oauth2Source.id);
        if (target) target.error = "The sign-in didn't finish — sign in again to connect";
      });
      throw new EngineError(error instanceof OAuth2Error ? error.message : "Couldn't finish the sign-in");
    }
    return syncSource(oauth2Source.id);
  }
  try {
    const source = await completeOAuth(state, code);
    return await syncSource(source.id);
  } catch (error) {
    throw new EngineError(error instanceof OAuthError || error instanceof EngineError ? error.message : "Couldn't finish the sign-in");
  }
}

/** Forget every cached OAuth artefact (client registration included). */
export async function signOut(sourceId: string): Promise<Source> {
  const source = loadConfig().sources.find((s) => s.id === sourceId);
  if (!source) throw new EngineError("That integration doesn't exist");
  if (source.auth.type === "oauth2") {
    forgetOAuth2Tokens(sourceId);
    if (source.auth.grant === "client_credentials") return loadConfig().sources.find((s) => s.id === sourceId)!;
  } else {
    forgetOAuth(sourceId);
  }
  markNeedsAuth(sourceId);
  return loadConfig().sources.find((s) => s.id === sourceId)!;
}

// ---------------------------------------------------------------------------
// Code mode — one `execute` tool instead of every tool
// ---------------------------------------------------------------------------

export { EXECUTE_TOOL_NAME };

/**
 * The tool mode in effect. MCPMASTER_TOOL_MODE overrides the saved setting for
 * one process (e.g. `MCPMASTER_TOOL_MODE=all mcpmaster mcp` for a client that
 * can't run snippets) without changing it for everyone else.
 */
export function toolMode(config: Config = loadConfig()): ToolMode {
  const override = process.env.MCPMASTER_TOOL_MODE;
  if (override === "all" || override === "execute") return override;
  return config.toolMode;
}

export function setToolMode(mode: ToolMode): void {
  updateConfig((config) => {
    config.toolMode = mode;
  });
}

function codeModeTools(config: Config) {
  return agentTools(config).map((tool) => ({
    fullName: tool.fullName,
    toolName: tool.toolName,
    description: tool.description,
    inputSchema: publicInputSchema(tool.inputSchema),
    integrationName: tool.source.name,
  }));
}

/** Strip the translator's internal routing tags before a schema reaches an agent. */
export function publicInputSchema(schema: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(schema, (key, value) => (key === "x-in" ? undefined : value)));
}

/** The single tool code mode advertises. Its size grows with integrations, not tools. */
export function executeToolDefinition(config: Config = loadConfig()) {
  return buildExecuteTool(codeModeTools(config));
}

/**
 * Run a code-mode snippet. It can only reach the enabled, agent-visible tools
 * (the same set a direct call can), each call dispatched through callTool —
 * so the egress rules, credential injection and redaction are identical to
 * calling the tool directly. The snippet itself runs in QuickJS/WASM with no
 * network, filesystem or host objects (core/src/sandbox.ts).
 */
export async function executeCode(code: unknown): Promise<ToolCallOutcome> {
  if (typeof code !== "string" || !code.trim()) return { ok: false, error: 'Missing required "code" argument.' };
  const config = loadConfig();
  applySettings(config);
  const handler = createCodeModeHandler({
    tools: codeModeTools(config),
    beforeCall: async () => {},
    callTool: (tool, input) => callTool(tool.fullName, input),
    afterCall: () => {},
  });

  let result: Awaited<ReturnType<typeof runInSandbox>>;
  try {
    result = await runInSandbox(code, handler);
  } catch (error) {
    // The sandbox itself failed to load — not the snippet. Detail to our log.
    process.stderr.write(`mcpmaster: code sandbox failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return { ok: false, error: "Code execution is unavailable right now. Please try again." };
  }
  const logs = result.logs.length ? `\n\nconsole output:\n${result.logs.join("\n")}` : "";
  if (!result.ok) return { ok: false, error: `${result.error}${logs}` };
  const text = typeof result.value === "string" ? result.value : JSON.stringify(result.value, null, 2);
  return { ok: true, text: `${text}${logs}` };
}
