// OAuth for remote MCP servers (the MCP authorization spec: protected-resource
// discovery → authorization-server metadata → dynamic client registration →
// authorization code + PKCE → refresh). The protocol mechanics are the MCP
// SDK's own `auth()`; this file supplies the two things that are ours:
//
// 1. Every HTTP call the flow makes goes through validatedFetch(), the one
//    SSRF-mitigated egress path — discovery documents and token endpoints are
//    exactly as much "a URL someone else chose" as the server itself.
//
// 2. Where the state lives, and when it dies. Everything — the registered
//    client_id/secret, tokens, PKCE verifier, discovery results, the pending
//    `state` — is stored per INTEGRATION (secrets.json, keyed by integration
//    id), never per server URL, and is wiped:
//      - when the integration is removed (its whole secret entry goes),
//      - on every sign-in (`mcpmaster login`, the UI's "Sign in again"):
//        a sign-in always starts from nothing and registers a NEW client,
//      - on sign-out, and whenever the server rejects the client.
//    So removing and re-adding a server, or re-authenticating after changing
//    something on the provider's side, can never silently reuse a stale
//    client_id or token — the failure mode where a cached registration keeps
//    getting sent to a server that no longer accepts it.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { validatedFetch, EgressBlockedError } from "../../core/src/egress.ts";
import { loadConfig, loadSecret, saveSecret, type OAuthState, type Source } from "./store.ts";
import { VERSION } from "./version.ts";

/** validatedFetch, shaped as the fetch the SDK expects. */
async function egressFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => {
    headers[key] = value;
  });
  const body = init?.body === undefined || init.body === null ? undefined : String(init.body);
  const result = await validatedFetch(String(url), { method: init?.method, headers, body });
  const nullBody = [101, 204, 205, 304].includes(result.status);
  return new Response(nullBody ? null : result.text, { status: result.status, headers: result.headers });
}

function updateOAuth(sourceId: string, mutate: (state: OAuthState) => OAuthState | null): void {
  const secret = loadSecret(sourceId);
  const next = mutate(secret.oauth ?? {});
  saveSecret(sourceId, { ...secret, oauth: next ?? undefined });
}

class IntegrationOAuthProvider implements OAuthClientProvider {
  authorizationUrl: URL | null = null;
  private readonly sourceId: string;
  private readonly redirect: string;

  constructor(sourceId: string, redirect: string) {
    this.sourceId = sourceId;
    this.redirect = redirect;
  }

  private get stored(): OAuthState {
    return loadSecret(this.sourceId).oauth ?? {};
  }

  get redirectUrl(): string {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "mcpmaster",
      client_uri: "https://github.com/mcpmastersh/mcpmaster",
      software_id: "mcpmaster-local",
      software_version: VERSION,
      redirect_uris: [this.redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  /** The CSRF `state` parameter for the authorization request. */
  state(): string {
    return this.stored.pendingState ?? "";
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const { client, redirectUrl } = this.stored;
    // A registration is only valid for the redirect URI it was made with
    // (the local port can change) — re-register rather than send a mismatch.
    return client && redirectUrl === this.redirect ? (client as OAuthClientInformationMixed) : undefined;
  }

  saveClientInformation(client: OAuthClientInformationMixed): void {
    updateOAuth(this.sourceId, (s) => ({ ...s, client, redirectUrl: this.redirect }));
  }

  tokens(): OAuthTokens | undefined {
    return this.stored.tokens as OAuthTokens | undefined;
  }

  saveTokens(tokens: OAuthTokens): void {
    updateOAuth(this.sourceId, (s) => ({ ...s, tokens, tokensSavedAt: Date.now() }));
  }

  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url;
  }

  saveCodeVerifier(codeVerifier: string): void {
    updateOAuth(this.sourceId, (s) => ({ ...s, codeVerifier }));
  }

  codeVerifier(): string {
    const verifier = this.stored.codeVerifier;
    if (!verifier) throw new Error("No sign-in is in progress for this integration");
    return verifier;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    updateOAuth(this.sourceId, (s) => {
      if (scope === "all") return null;
      const next = { ...s };
      if (scope === "client") {
        // A rejected client takes its tokens with it — they were issued to it.
        delete next.client;
        delete next.tokens;
        delete next.tokensSavedAt;
      }
      if (scope === "tokens") {
        delete next.tokens;
        delete next.tokensSavedAt;
      }
      if (scope === "verifier") delete next.codeVerifier;
      return next;
    });
  }
}

function providerFor(sourceId: string, redirectUrl: string): IntegrationOAuthProvider {
  return new IntegrationOAuthProvider(sourceId, redirectUrl);
}

/** Wipe every piece of cached OAuth state for an integration. */
export function forgetOAuth(sourceId: string): void {
  const secret = loadSecret(sourceId);
  if (secret.oauth) saveSecret(sourceId, { ...secret, oauth: undefined });
}

/**
 * Does this MCP server want OAuth? True when an unauthenticated initialize is
 * answered 401 — the spec's signal to start discovery.
 */
export async function requiresOAuth(serverUrl: string): Promise<boolean> {
  try {
    const res = await validatedFetch(serverUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcpmaster", version: VERSION } } }),
    });
    return res.status === 401;
  } catch {
    return false;
  }
}

export class OAuthError extends Error {}

function translate(error: unknown): OAuthError {
  if (error instanceof OAuthError) return error;
  if (error instanceof EgressBlockedError) return new OAuthError(error.message);
  return new OAuthError("That server's sign-in didn't work — try signing in again");
}

/**
 * Start a sign-in from scratch: forget everything cached for this
 * integration, register a fresh client, and return the URL to open.
 */
export async function beginOAuth(source: Source, redirectUrl: string): Promise<string> {
  if (!source.url) throw new OAuthError("This integration has no server URL");
  const pendingState = randomBytes(24).toString("base64url");
  // Fresh every time, by design — see the module comment.
  saveSecret(source.id, { ...loadSecret(source.id), oauth: { pendingState, redirectUrl } });
  const provider = providerFor(source.id, redirectUrl);
  try {
    const result = await auth(provider, { serverUrl: source.url, fetchFn: egressFetch });
    if (result === "AUTHORIZED") return "";
  } catch (error) {
    throw translate(error);
  }
  if (!provider.authorizationUrl) throw new OAuthError("That server didn't offer a sign-in page");
  return provider.authorizationUrl.toString();
}

function sameState(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/**
 * Finish a sign-in from the browser callback. `state` must match the one this
 * process issued (RFC 6749 §10.12 CSRF protection) and is single-use.
 */
export async function completeOAuth(state: string, code: string): Promise<Source> {
  const source = loadConfig().sources.find((s) => {
    const pending = loadSecret(s.id).oauth?.pendingState;
    return pending !== undefined && sameState(pending, state);
  });
  if (!source || !source.url) throw new OAuthError("That sign-in link expired — start it again from mcpmaster");
  const redirectUrl = loadSecret(source.id).oauth?.redirectUrl;
  if (!redirectUrl) throw new OAuthError("That sign-in link expired — start it again from mcpmaster");
  // Burn the state before the exchange so a replayed callback can't reuse it.
  updateOAuth(source.id, (s) => ({ ...s, pendingState: undefined }));
  const provider = providerFor(source.id, redirectUrl);
  try {
    const result = await auth(provider, { serverUrl: source.url, authorizationCode: code, fetchFn: egressFetch });
    if (result !== "AUTHORIZED") throw new OAuthError("That server didn't finish the sign-in");
  } catch (error) {
    throw translate(error);
  } finally {
    updateOAuth(source.id, (s) => ({ ...s, codeVerifier: undefined }));
  }
  return source;
}

const EXPIRY_SKEW_MS = 60_000;

/** A usable access token, refreshing it first when it's about to expire. */
export async function oauthAccessToken(source: Source): Promise<{ token: string } | { error: string }> {
  const state = loadSecret(source.id).oauth;
  const tokens = state?.tokens as OAuthTokens | undefined;
  if (!state || !tokens?.access_token || !source.url) return { error: "Sign in to this integration first" };

  const expiresAt = tokens.expires_in && state.tokensSavedAt ? state.tokensSavedAt + tokens.expires_in * 1000 : Infinity;
  if (Date.now() < expiresAt - EXPIRY_SKEW_MS) return { token: tokens.access_token };
  if (!tokens.refresh_token || !state.redirectUrl) return { error: "This integration's sign-in expired — sign in again" };

  const provider = providerFor(source.id, state.redirectUrl);
  try {
    const result = await auth(provider, { serverUrl: source.url, fetchFn: egressFetch });
    const refreshed = loadSecret(source.id).oauth?.tokens as OAuthTokens | undefined;
    if (result === "AUTHORIZED" && refreshed?.access_token) return { token: refreshed.access_token };
  } catch {
    // fall through
  }
  forgetOAuth(source.id);
  return { error: "This integration's sign-in expired — sign in again" };
}
