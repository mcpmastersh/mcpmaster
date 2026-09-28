// OAuth2 for integrations that use a client you registered with the provider
// yourself (GitHub, Google, Atlassian, Salesforce, an internal IdP …).
// oauth.ts is the other OAuth in this package: the MCP authorization spec,
// where a remote MCP server hands out its own client via discovery + DCR.
// This file is for everything else: the endpoints come from the provider's
// published metadata or the user, and the client is the user's own — or,
// for a browser sign-in with no client ID where the provider supports it,
// one mcpmaster registers itself (RFC 7591) as a public PKCE client.
//
// Two grants:
//   - client_credentials: no user interaction. The token is exchanged
//     lazily on first use and re-exchanged on every expiry.
//   - authorization_code: one interactive consent in the browser. The
//     provider redirects back to this machine's own server
//     (http://127.0.0.1:<port>/oauth/callback), which exchanges the code.
//     PKCE (S256) is always sent, so a public client with no secret works
//     too. After that the access token is refreshed lazily with the refresh
//     token; a second consent is needed only if the provider revokes it.
//
// The rules this file keeps:
//   - Every token request goes through validatedFetch() — a token URL is
//     exactly as much "a URL someone else chose" as a spec URL.
//   - `state` is unguessable, single-use and short-lived (RFC 6749 §10.12);
//     it is what authenticates the callback, which carries no admin token.
//   - The provider's own error body never reaches the user or an agent —
//     only a translated message.
//   - Client secret, access and refresh tokens live in secrets.json (0600)
//     and are never shown back; every one of them is scrubbed from results.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { validatedFetch, EgressBlockedError } from "../../core/src/egress.ts";
import { loadConfig, loadSecret, saveSecret, type OAuth2State, type Source, type SourceAuth } from "./store.ts";

export type OAuth2Auth = Extract<SourceAuth, { type: "oauth2" }>;

export class OAuth2Error extends Error {}

// Refresh a little before the provider's expiry so a token that's valid when
// checked doesn't expire during the call that follows.
const EXPIRY_SKEW_MS = 30_000;
// How long a consent link stays usable.
const PENDING_TTL_MS = 10 * 60_000;

const NEEDS_CONSENT = "Sign in to this integration to connect it";
const CONSENT_EXPIRED = "This integration's sign-in expired — sign in again";
const LINK_EXPIRED = "That sign-in link expired — start it again from mcpmaster";

function updateOAuth2(sourceId: string, mutate: (state: OAuth2State) => OAuth2State): void {
  const secret = loadSecret(sourceId);
  saveSecret(sourceId, { ...secret, oauth2: mutate(secret.oauth2 ?? {}) });
}

/** The client secret, from the environment when configured that way. */
function clientSecret(auth: OAuth2Auth, state: OAuth2State): string | undefined {
  if (auth.clientSecretEnv) return process.env[auth.clientSecretEnv] || undefined;
  return state.clientSecret || undefined;
}

/** Is a client secret available (or not needed)? For describeCredential. */
export function oauth2Configured(source: Source): boolean {
  if (source.auth.type !== "oauth2") return false;
  const state = loadSecret(source.id).oauth2 ?? {};
  if (source.auth.grant === "authorization_code") return Boolean(state.accessToken || state.refreshToken);
  return Boolean(clientSecret(source.auth, state));
}

type TokenResponse = { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };

/** The client a token request authenticates as. */
type Client = { id: string; secret?: string; basic: boolean };

/** The user's own client, else the one mcpmaster registered, if any yet. */
function clientFor(auth: OAuth2Auth, state: OAuth2State): Client | undefined {
  if (auth.clientId) return { id: auth.clientId, secret: clientSecret(auth, state), basic: auth.clientAuth === "basic" };
  const registered = state.registered;
  return registered ? { id: registered.clientId, secret: registered.clientSecret, basic: registered.basic === true } : undefined;
}

async function tokenRequest(
  auth: OAuth2Auth,
  client: Client,
  params: Record<string, string>,
): Promise<{ ok: true; accessToken: string; refreshToken?: string; expiresIn?: number } | { ok: false; status?: number; error: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  const form: Record<string, string> = { ...params };
  const secret = client.secret;
  if (client.basic && secret !== undefined) {
    // RFC 6749 §2.3.1: both halves form-urlencoded before base64.
    const pair = `${encodeURIComponent(client.id)}:${encodeURIComponent(secret)}`;
    headers.Authorization = `Basic ${Buffer.from(pair).toString("base64")}`;
  } else {
    form.client_id = client.id;
    if (secret !== undefined) form.client_secret = secret;
  }
  let response;
  try {
    response = await validatedFetch(auth.tokenUrl, { method: "POST", headers, body: new URLSearchParams(form).toString() });
  } catch (error) {
    return { ok: false, error: error instanceof EgressBlockedError ? error.message : "Couldn't reach the provider's token endpoint" };
  }
  // Never the provider's own error text — just enough to know which step failed.
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, status: response.status, error: `The provider's token endpoint refused the request (HTTP ${response.status})` };
  }
  let body: TokenResponse;
  try {
    body = JSON.parse(response.text) as TokenResponse;
  } catch {
    return { ok: false, error: "The provider's token endpoint didn't return JSON" };
  }
  if (typeof body.access_token !== "string" || !body.access_token) {
    return { ok: false, error: "The provider's token endpoint didn't return an access token" };
  }
  const expiresIn = Number(body.expires_in);
  return {
    ok: true,
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : undefined,
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : undefined,
  };
}

// A rotating refresh token (many providers issue a new one on every refresh)
// replaces the stored one; a provider that omits it keeps the existing one.
function saveTokens(sourceId: string, tokens: { accessToken: string; refreshToken?: string; expiresIn?: number }): void {
  updateOAuth2(sourceId, (s) => ({
    ...s,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? s.refreshToken,
    expiresAt: tokens.expiresIn ? Date.now() + tokens.expiresIn * 1000 : undefined,
  }));
}

export type OAuth2Token =
  | { ok: true; token: string; secrets: string[] }
  | { ok: false; error: string; needsAuth: boolean };

// One exchange/refresh per integration at a time, so concurrent calls on an
// expired token don't each spend (and, with rotation, invalidate) the
// refresh token.
const inFlight = new Map<string, Promise<OAuth2Token>>();

/** A usable access token, exchanging or refreshing it first when needed. */
export function oauth2AccessToken(source: Source): Promise<OAuth2Token> {
  const running = inFlight.get(source.id);
  if (running) return running;
  const next = obtain(source).finally(() => inFlight.delete(source.id));
  inFlight.set(source.id, next);
  return next;
}

async function obtain(source: Source): Promise<OAuth2Token> {
  const auth = source.auth;
  if (auth.type !== "oauth2") return { ok: false, error: "This integration doesn't use OAuth2", needsAuth: false };
  const state = loadSecret(source.id).oauth2 ?? {};
  const client = clientFor(auth, state);
  const secret = client?.secret;
  const known = [secret, state.refreshToken].filter((v): v is string => Boolean(v));

  // A token with no stated expiry is used until a call rejects it (then
  // invalidateOAuth2AccessToken drops it) — re-exchanging on every call
  // would double every request.
  if (state.accessToken && (!state.expiresAt || Date.now() < state.expiresAt - EXPIRY_SKEW_MS)) {
    return { ok: true, token: state.accessToken, secrets: [state.accessToken, ...known] };
  }

  if (auth.grant === "client_credentials") {
    if (!secret) {
      const where = auth.clientSecretEnv ? `set ${auth.clientSecretEnv} in the environment mcpmaster runs in` : "add it in mcpmaster";
      return { ok: false, error: `This integration's client secret isn't set — ${where}`, needsAuth: false };
    }
    const result = await tokenRequest(auth, client!, { grant_type: "client_credentials", ...(auth.scope ? { scope: auth.scope } : {}), ...(auth.resource ? { resource: auth.resource } : {}) });
    if (!result.ok) return { ok: false, error: result.error, needsAuth: false };
    saveTokens(source.id, result);
    return { ok: true, token: result.accessToken, secrets: [result.accessToken, ...known] };
  }

  if (!state.refreshToken || !client) {
    return { ok: false, error: state.accessToken ? CONSENT_EXPIRED : NEEDS_CONSENT, needsAuth: true };
  }
  const result = await tokenRequest(auth, client, { grant_type: "refresh_token", refresh_token: state.refreshToken, ...resourceFor(source) });
  if (!result.ok) {
    // Unreachable is transient; a refusal means the grant is gone and only
    // a fresh consent brings it back.
    if (result.status === undefined) return { ok: false, error: result.error, needsAuth: false };
    forgetOAuth2Tokens(source.id);
    return { ok: false, error: CONSENT_EXPIRED, needsAuth: true };
  }
  saveTokens(source.id, result);
  return { ok: true, token: result.accessToken, secrets: [result.accessToken, result.refreshToken ?? state.refreshToken, ...known] };
}

/**
 * The RFC 8707 resource a token is for: the one the resource published, or
 * for a remote MCP server its own URL (the MCP authorization spec requires
 * it). Sent on the authorize and token requests alike.
 */
function resourceFor(source: Source): Record<string, string> {
  const auth = source.auth;
  const resource = auth.type === "oauth2" ? auth.resource ?? (source.type === "mcp" ? source.url : undefined) : undefined;
  return resource ? { resource } : {};
}

/** A call was rejected with 401: drop the access token so the next one re-obtains it. */
export function invalidateOAuth2AccessToken(sourceId: string): void {
  const state = loadSecret(sourceId).oauth2;
  if (state?.accessToken) updateOAuth2(sourceId, (s) => ({ ...s, accessToken: undefined, expiresAt: undefined }));
}

/** Forget tokens and any sign-in in progress; the client (secret or registration) stays. */
export function forgetOAuth2Tokens(sourceId: string): void {
  const state = loadSecret(sourceId).oauth2;
  if (!state) return;
  updateOAuth2(sourceId, (s) => ({ clientSecret: s.clientSecret, registered: s.registered }));
}

/**
 * Register mcpmaster as a public client (RFC 7591): PKCE, no secret asked
 * for, this machine's callback as its one redirect URI. A provider may
 * issue a secret anyway; it's kept like any client secret.
 */
async function registerClient(auth: OAuth2Auth, redirectUrl: string): Promise<NonNullable<OAuth2State["registered"]>> {
  const failed = "The provider didn't let mcpmaster register itself — add your own client ID";
  let response;
  try {
    response = await validatedFetch(auth.registrationUrl!, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_name: "mcpmaster",
        redirect_uris: [redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        ...(auth.scope ? { scope: auth.scope } : {}),
      }),
    });
  } catch (error) {
    throw new OAuth2Error(error instanceof EgressBlockedError ? error.message : "Couldn't reach the provider's client registration endpoint");
  }
  // Never the provider's own error text.
  if (response.status < 200 || response.status >= 300) throw new OAuth2Error(failed);
  let body: { client_id?: unknown; client_secret?: unknown; token_endpoint_auth_method?: unknown };
  try {
    body = JSON.parse(response.text);
  } catch {
    throw new OAuth2Error(failed);
  }
  if (typeof body.client_id !== "string" || !body.client_id || body.client_id.length > 512) throw new OAuth2Error(failed);
  const clientSecret = typeof body.client_secret === "string" && body.client_secret ? body.client_secret : undefined;
  return {
    clientId: body.client_id,
    ...(clientSecret ? { clientSecret } : {}),
    ...(clientSecret && body.token_endpoint_auth_method === "client_secret_basic" ? { basic: true } : {}),
    redirectUrl,
  };
}

function sameState(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/**
 * Start an authorization_code consent: mint a fresh state and PKCE verifier
 * (discarding old tokens — a new consent replaces the old grant) and return
 * the provider URL to open.
 */
export async function beginOAuth2(source: Source, redirectUrl: string): Promise<string> {
  const auth = source.auth;
  if (auth.type !== "oauth2" || auth.grant !== "authorization_code" || !auth.authorizeUrl) {
    throw new OAuth2Error("This integration doesn't sign in through a browser");
  }
  // No client of the user's own: register one, once per redirect URL (the
  // port is part of it, so moving mcpmaster to another port re-registers).
  let registered = loadSecret(source.id).oauth2?.registered;
  if (!auth.clientId) {
    if (!auth.registrationUrl) throw new OAuth2Error("Add the OAuth2 client ID");
    if (!registered || registered.redirectUrl !== redirectUrl) registered = await registerClient(auth, redirectUrl);
  }
  const clientId = auth.clientId ?? registered!.clientId;
  const pendingState = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  updateOAuth2(source.id, (s) => ({
    clientSecret: s.clientSecret,
    registered: auth.clientId ? undefined : registered,
    pendingState,
    pendingExpiresAt: Date.now() + PENDING_TTL_MS,
    codeVerifier,
    redirectUrl,
  }));
  const url = new URL(auth.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUrl);
  url.searchParams.set("state", pendingState);
  url.searchParams.set("code_challenge", createHash("sha256").update(codeVerifier).digest("base64url"));
  url.searchParams.set("code_challenge_method", "S256");
  if (auth.scope) url.searchParams.set("scope", auth.scope);
  for (const [key, value] of Object.entries(resourceFor(source))) url.searchParams.set(key, value);
  return url.toString();
}

/** The integration a callback's `state` belongs to, if it's one of ours. */
export function findOAuth2Pending(state: string): Source | undefined {
  if (!state) return undefined;
  return loadConfig().sources.find((s) => {
    const pending = s.auth.type === "oauth2" ? loadSecret(s.id).oauth2?.pendingState : undefined;
    return pending !== undefined && sameState(pending, state);
  });
}

/** The provider declined (or the user cancelled): burn the pending state. */
export function abandonOAuth2(source: Source): void {
  updateOAuth2(source.id, (s) => ({ ...s, pendingState: undefined, pendingExpiresAt: undefined, codeVerifier: undefined }));
}

/** Finish a consent from the browser callback: exchange the code for tokens. */
export async function completeOAuth2(source: Source, code: string): Promise<void> {
  const auth = source.auth;
  const state = loadSecret(source.id).oauth2 ?? {};
  // Burn the state before the exchange so a replayed callback can't reuse it.
  abandonOAuth2(source);
  if (auth.type !== "oauth2" || !state.codeVerifier || !state.redirectUrl) throw new OAuth2Error(LINK_EXPIRED);
  if (!state.pendingExpiresAt || Date.now() > state.pendingExpiresAt) throw new OAuth2Error(LINK_EXPIRED);
  const client = clientFor(auth, state);
  if (!client) throw new OAuth2Error(LINK_EXPIRED);
  const result = await tokenRequest(auth, client, {
    grant_type: "authorization_code",
    code,
    redirect_uri: state.redirectUrl,
    code_verifier: state.codeVerifier,
    ...resourceFor(source),
  });
  if (!result.ok) throw new OAuth2Error(result.status ? "The provider didn't accept that sign-in — try again" : result.error);
  saveTokens(source.id, result);
}

// ---------------------------------------------------------------------------
// Discovery — most providers publish their endpoints, so the user needn't
// copy them by hand. RFC 8414 (OAuth authorization server metadata), OpenID
// Connect Discovery, and RFC 9728 (a protected resource naming its
// authorization server) are all tried. It only ever fills in a form: the
// result is shown to the user and validated again when the integration is
// added, like any URL they typed.
// ---------------------------------------------------------------------------

export type OAuth2Discovery = {
  /** Where the metadata was found. */
  metadataUrl: string;
  issuer?: string;
  authorizeUrl?: string;
  tokenUrl: string;
  /** RFC 8707 resource indicator, from the protected resource's own metadata. */
  resource?: string;
  /** RFC 7591: mcpmaster can register its own client, so no client ID is needed. */
  registrationUrl?: string;
  /** Set when the provider accepts only HTTP Basic client authentication. */
  clientAuth?: "basic";
  grants?: string[];
  scopes?: string[];
};

const NOT_FOUND = "Couldn't find published OAuth settings there — enter the endpoints by hand";

/** The metadata locations for a URL, most specific first. */
export function discoveryUrls(input: string): { metadata: string[]; resource: string[] } {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new OAuth2Error("That isn't a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new OAuth2Error("That isn't a valid URL");
  if (url.pathname.includes("/.well-known/")) {
    url.hash = "";
    return { metadata: [url.toString()], resource: [] };
  }
  const origin = url.origin;
  const path = url.pathname.replace(/\/+$/, "");
  const paths = path ? [path, ""] : [""];
  const metadata = new Set<string>();
  const resource = new Set<string>();
  for (const p of paths) {
    metadata.add(`${origin}/.well-known/oauth-authorization-server${p}`); // RFC 8414 §3
    metadata.add(`${origin}${p}/.well-known/openid-configuration`); // OIDC Discovery §4
    metadata.add(`${origin}/.well-known/openid-configuration${p}`); // RFC 8414 §5
    resource.add(`${origin}/.well-known/oauth-protected-resource${p}`); // RFC 9728 §3
  }
  return { metadata: [...metadata], resource: [...resource] };
}

/** https, or plain http to this machine only — what validateEndpoint will accept. */
function endpoint(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || /^127\./.test(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return undefined;
    if (url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

async function fetchJson(url: string): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await validatedFetch(url, { headers: { Accept: "application/json" }, maxBytes: 256 * 1024 });
    if (response.status !== 200) return undefined;
    const body = JSON.parse(response.text) as unknown;
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").slice(0, 100) : undefined;

function parseMetadata(metadataUrl: string, doc: Record<string, unknown>): OAuth2Discovery | undefined {
  const tokenUrl = endpoint(doc.token_endpoint);
  if (!tokenUrl) return undefined;
  const methods = strings(doc.token_endpoint_auth_methods_supported);
  return {
    metadataUrl,
    issuer: typeof doc.issuer === "string" ? doc.issuer : undefined,
    authorizeUrl: endpoint(doc.authorization_endpoint),
    tokenUrl,
    registrationUrl: endpoint(doc.registration_endpoint),
    clientAuth: methods && methods.includes("client_secret_basic") && !methods.includes("client_secret_post") ? "basic" : undefined,
    grants: strings(doc.grant_types_supported),
    scopes: strings(doc.scopes_supported),
  };
}

/** The first location, in order, that holds usable metadata. Fetched in parallel. */
async function firstMetadata(urls: string[]): Promise<OAuth2Discovery | undefined> {
  const docs = await Promise.all(urls.map(fetchJson));
  for (let i = 0; i < urls.length; i++) {
    const found = docs[i] && parseMetadata(urls[i], docs[i]!);
    if (found) return found;
  }
  return undefined;
}

/**
 * Find a provider's OAuth endpoints from an issuer, an API or MCP URL, or a
 * metadata URL itself. Every request goes through validatedFetch.
 */
export async function discoverOAuth2(input: string): Promise<OAuth2Discovery> {
  const { metadata, resource } = discoveryUrls(input.trim());
  const [direct, resources] = await Promise.all([firstMetadata(metadata), Promise.all(resource.map(fetchJson))]);
  // A protected resource (RFC 9728) names itself and its authorization
  // server(s). Its own word wins: the resource is what a token is asked for
  // (RFC 8707, which e.g. MCP servers require), and the server it names is
  // the one to use even when the origin publishes metadata of its own.
  for (const doc of resources) {
    if (!doc) continue;
    const named = endpoint(doc.resource);
    const server = strings(doc.authorization_servers)?.map(endpoint).find(Boolean);
    const found = server ? await firstMetadata(discoveryUrls(server).metadata) : direct;
    if (found) return { ...found, ...(named ? { resource: named } : {}) };
  }
  if (direct) return direct;
  throw new OAuth2Error(NOT_FOUND);
}
