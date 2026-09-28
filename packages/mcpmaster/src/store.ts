// Local state for the self-hosted runtime. Everything lives under one
// directory (MCPMASTER_HOME, default ~/.mcpmaster), created 0700, with every
// file written 0600 and atomically (write a temp file, then rename), so a
// crash mid-write never leaves a half-written config and nothing in it is
// readable by another local user.
//
//   config.json   integrations + settings — no secret values, ever
//   secrets.json  credential values, keyed by integration id
//   tools/<id>.json  the translated tool list for one integration
//   token         the local admin token guarding the web UI + HTTP endpoint
//
// Secret values are stored here, never shown back: the web UI and CLI only
// ever report whether a credential is set ("use, never see"). Encrypting them
// at rest with a key kept on the same disk would add ceremony without adding
// protection, so file permissions are the boundary — the same posture as
// ~/.ssh or a cloud CLI's credentials file.

import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SourceType = "openapi" | "graphql" | "mcp" | "stdio";

export type SourceAuth =
  | { type: "none" }
  /** Remote MCP server signed in through its own OAuth flow (oauth.ts). */
  | { type: "oauth" }
  /**
   * OAuth2 with a client you registered with the provider (oauth2.ts).
   * Endpoints and the client id aren't secret; the client secret and tokens
   * live in secrets.json.
   */
  | {
      type: "oauth2";
      grant: "client_credentials" | "authorization_code";
      tokenUrl: string;
      /** authorization_code: where the browser goes for consent. */
      authorizeUrl?: string;
      /**
       * Absent for authorization_code with a registrationUrl: mcpmaster then
       * registers its own client at sign-in (RFC 7591), kept in secrets.json.
       */
      clientId?: string;
      /** RFC 8707 resource indicator sent with every authorize/token request. */
      resource?: string;
      /** The provider's dynamic client registration endpoint (RFC 7591). */
      registrationUrl?: string;
      /** Space-separated, as the provider expects it. */
      scope?: string;
      /** Send the client id/secret as HTTP Basic instead of in the form body. */
      clientAuth?: "basic";
      /** Read the client secret from this environment variable instead of the store. */
      clientSecretEnv?: string;
    }
  | {
      type: "bearer" | "api_key";
      /** Header an api_key is sent in (default X-API-Key). */
      header?: string;
      /** Read the credential from this environment variable instead of the store. */
      env?: string;
    };

export type SourceStatus = "ready" | "failed" | "syncing" | "needs_auth";

export type Source = {
  id: string;
  /** Slug, unique — also the tool-name prefix agents see. */
  name: string;
  type: SourceType;
  /** openapi/graphql/mcp: the URL (or, for openapi, a local file path). */
  url?: string;
  /** stdio: the command and its arguments. */
  command?: string;
  args?: string[];
  auth: SourceAuth;
  enabled: boolean;
  /**
   * Expose only tools that read: OpenAPI GET/HEAD/OPTIONS, GraphQL queries,
   * and MCP tools the server marks `readOnlyHint`. Anything unknown counts as
   * a write, so it's hidden.
   */
  readOnly?: boolean;
  /** Tools that first appear in a later sync stay hidden until reviewed. */
  hideNewTools?: boolean;
  /** Raw tool names that appeared in a sync and haven't been reviewed yet. */
  pendingReview?: string[];
  status: SourceStatus;
  /** A translated, user-safe message — never a raw downstream error. */
  error?: string;
  toolCount: number;
  addedAt: string;
  syncedAt?: string;
};

/**
 * How agents see the tools. "execute" (default) lists ONE code-mode tool the
 * agent uses to search, describe and call every other tool, so its context
 * cost stays flat however many integrations are connected. "all" lists every
 * tool individually, for clients that can't run code-mode snippets.
 */
export type ToolMode = "execute" | "all";

export type Config = {
  version: 1;
  toolMode: ToolMode;
  /** Local-mode opt-in: allow integrations on localhost/LAN addresses. */
  allowPrivateNetwork: boolean;
  /** Full tool names hidden from agents, explicitly. */
  disabledTools: string[];
  /**
   * Full tool names allowed explicitly, overriding a block rule, read-only or
   * new-tool review. Never overlaps `disabledTools`.
   */
  allowedTools: string[];
  /**
   * Glob rules on full tool names (`*` any run, `?` one character), e.g.
   * `github_delete_*`. Evaluated on every listing and call, so they also
   * cover tools that don't exist yet.
   */
  blockRules: string[];
  sources: Source[];
};

/**
 * Cached OAuth state for one integration — see oauth.ts for exactly when it
 * is wiped. `client` is the dynamically registered client (its id, and a
 * secret if the server issued one); tokens are the provider's own.
 */
export type OAuthState = {
  client?: Record<string, unknown>;
  redirectUrl?: string;
  tokens?: Record<string, unknown> & { access_token?: string; refresh_token?: string; expires_in?: number };
  tokensSavedAt?: number;
  codeVerifier?: string;
  pendingState?: string;
};

/**
 * OAuth2 state for one integration with a user-supplied client (oauth2.ts).
 * A new consent or a changed configuration discards everything but the
 * client secret.
 */
export type OAuth2State = {
  clientSecret?: string;
  /** A client mcpmaster registered itself (RFC 7591), bound to one redirect URL. */
  registered?: { clientId: string; clientSecret?: string; basic?: boolean; redirectUrl: string };
  accessToken?: string;
  refreshToken?: string;
  /** Epoch ms; absent when the provider didn't say. */
  expiresAt?: number;
  pendingState?: string;
  pendingExpiresAt?: number;
  codeVerifier?: string;
  redirectUrl?: string;
};

export type SourceSecret = {
  oauth?: OAuthState;
  oauth2?: OAuth2State;
  /** bearer / api_key value. */
  token?: string;
  /** stdio: extra environment variables for the process. */
  env?: Record<string, string>;
};

export type StoredTool = {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  method?: string;
  path?: string;
  params?: { name: string; in: "path" | "query" | "header" | "body" }[];
  operation?: "query" | "mutation";
  selection?: string;
  argTypes?: Record<string, string>;
  /** MCP tool annotations, as the server declared them. */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};

export type ToolCache = { tools: StoredTool[]; baseUrl?: string };

const EMPTY_CONFIG: Config = {
  version: 1,
  toolMode: "execute",
  allowPrivateNetwork: false,
  disabledTools: [],
  allowedTools: [],
  blockRules: [],
  sources: [],
};

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((t): t is string => typeof t === "string") : []);

export function homeDir(): string {
  return process.env.MCPMASTER_HOME || join(homedir(), ".mcpmaster");
}

export function ensureHome(): string {
  const dir = homeDir();
  mkdirSync(join(dir, "tools"), { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best effort on filesystems without POSIX modes (Windows).
  }
  return dir;
}

function writeAtomic(path: string, contents: string): void {
  ensureHome();
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, path);
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

// Re-read on change only: the web server and a CLI invocation can both edit
// the config, so every read checks the file's mtime rather than trusting a
// copy held since startup — a `mcpmaster add` shows up in a running server
// immediately without a restart.
let configMemo: { mtimeMs: number; config: Config } | null = null;

export function loadConfig(): Config {
  const path = join(homeDir(), "config.json");
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return structuredClone(EMPTY_CONFIG);
  }
  if (configMemo && configMemo.mtimeMs === mtimeMs) return structuredClone(configMemo.config);
  const raw = readJson<Partial<Config>>(path, {});
  const config: Config = {
    version: 1,
    toolMode: raw.toolMode === "all" ? "all" : "execute",
    allowPrivateNetwork: raw.allowPrivateNetwork === true,
    disabledTools: strings(raw.disabledTools),
    allowedTools: strings(raw.allowedTools),
    blockRules: strings(raw.blockRules),
    sources: Array.isArray(raw.sources) ? raw.sources : [],
  };
  configMemo = { mtimeMs, config };
  return structuredClone(config);
}

export function saveConfig(config: Config): void {
  writeAtomic(join(homeDir(), "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  configMemo = null;
}

/** Read-modify-write in one step so callers can't forget to save. */
export function updateConfig(mutate: (config: Config) => void): Config {
  const config = loadConfig();
  mutate(config);
  saveConfig(config);
  return config;
}

export function loadSecret(sourceId: string): SourceSecret {
  const all = readJson<Record<string, SourceSecret>>(join(homeDir(), "secrets.json"), {});
  return all[sourceId] ?? {};
}

export function saveSecret(sourceId: string, secret: SourceSecret | null): void {
  const path = join(homeDir(), "secrets.json");
  const all = readJson<Record<string, SourceSecret>>(path, {});
  if (secret === null) delete all[sourceId];
  else all[sourceId] = secret;
  writeAtomic(path, `${JSON.stringify(all, null, 2)}\n`);
}

function toolCachePath(sourceId: string): string {
  // Ids are UUIDs we generate; refuse anything else so a hand-edited config
  // can't point a cache read/write outside the tools directory.
  if (!/^[0-9a-f-]{36}$/.test(sourceId)) throw new Error("invalid integration id");
  return join(homeDir(), "tools", `${sourceId}.json`);
}

const toolMemo = new Map<string, { mtimeMs: number; cache: ToolCache }>();

export function loadToolCache(sourceId: string): ToolCache | null {
  const path = toolCachePath(sourceId);
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  const memo = toolMemo.get(sourceId);
  if (memo && memo.mtimeMs === mtimeMs) return memo.cache;
  const cache = readJson<ToolCache | null>(path, null);
  if (cache) toolMemo.set(sourceId, { mtimeMs, cache });
  return cache;
}

export function saveToolCache(sourceId: string, cache: ToolCache): void {
  writeAtomic(toolCachePath(sourceId), JSON.stringify(cache));
  toolMemo.delete(sourceId);
}

export function deleteToolCache(sourceId: string): void {
  rmSync(toolCachePath(sourceId), { force: true });
  toolMemo.delete(sourceId);
}

/** The local admin token, created on first use. */
export function adminToken(rotate = false): string {
  const path = join(homeDir(), "token");
  if (!rotate && existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length >= 32) return existing;
  }
  const token = `mcpm_local_${randomBytes(24).toString("base64url")}`;
  writeAtomic(path, `${token}\n`);
  return token;
}

export function newSourceId(): string {
  return randomUUID();
}

export const SOURCE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Turns any label into a valid integration name. */
export function slugifyName(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^(www|api)\./, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "integration";
}
