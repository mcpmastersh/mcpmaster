import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns";
import type { Dispatcher } from "undici";

// undici is loaded lazily rather than at module scope: this helper is
// imported by the MCP dispatch path and the integration dispatcher, and a
// request that never makes an outbound call (e.g. a list_tools answered
// from cache) shouldn't pay to evaluate the whole
// client at startup. The promise is cached so the import happens once.
type Undici = typeof import("undici");
let undiciPromise: Promise<Undici> | null = null;
function loadUndici(): Promise<Undici> {
  if (!undiciPromise) undiciPromise = import("undici");
  return undiciPromise;
}

// Shared validated-egress helper for every outbound call the integration
// engine makes to a user-supplied URL — spec fetch, GraphQL introspection,
// MCP proxy connection, tool call dispatch, OAuth token exchange. A URL a
// user pasted is an SSRF vector: without this, a spec could point calls at
// cloud metadata endpoints or internal services. This is the ONLY place that should call
// fetch() against a user-supplied URL; a new integration type must reuse
// this, never add a one-off fetch() path.
//
// Resolve-then-validate, not validate-then-resolve: we supply undici's HTTP
// client our own `lookup` function (instead of resolving the hostname up
// front and rewriting the URL to a literal IP) so DNS resolution and the
// actual TCP connect happen atomically from undici's point of view — a
// second DNS answer arriving after our check can't rebind the connection to
// a different address, and TLS still gets the real hostname for SNI/cert
// validation since undici only swaps the resolved address, not the URL.
//
// URL.hostname keeps the surrounding brackets for an IPv6 literal (e.g.
// "[::1]"), and undici never calls our `lookup` for a literal address — so a
// literal IPv6 host has to be validated up front with the brackets stripped.
// Both validation paths share isDisallowedAddress() below, which parses the
// address into bytes and rejects every non-globally-routable range (including
// IPv4-mapped/-compatible/6to4/NAT64 forms that embed an internal IPv4).

// Default bound for every validatedFetch() call — sized for the hot-path
// case (a live tool call to an openapi integration): tight enough that a
// single request can't be abused to hold a lot of memory. One-time work
// (e.g. fetching an OpenAPI spec when an integration is added) may pass a
// larger `maxBytes` override instead of raising this default for every
// caller.
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MiB
const REQUEST_TIMEOUT_MS = 10_000;

export class EgressBlockedError extends Error {}

// Non-globally-routable IPv4 ranges. a/b/c are the first three octets; `c` is
// only used by the /24 checks. Kept deliberately broad (documentation,
// benchmarking, CGNAT, 6to4 relay anycast, reserved) rather than the minimum
// needed to block loopback/RFC1918 — a user-supplied source URL never
// legitimately points at any of these.
function isDisallowedIPv4(a: number, b: number, c: number): boolean {
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10.0.0.0/8 RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT (cloud metadata on some providers)
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC1918
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24, 192.0.2.0/24
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24 6to4 relay anycast
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true; // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved, broadcast
  return false;
}

function isDisallowedIPv4String(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  return isDisallowedIPv4(parts[0], parts[1], parts[2]);
}

// Parses an IPv6 address (optionally bracketed, optionally carrying a zone
// id, optionally ending in an embedded dotted-quad) into its 16 bytes.
// Returns null for anything it can't parse — callers treat that as
// "disallowed". Deliberately strict: no reliance on a third-party parser, so
// every form the platform accepts is either turned into exact bytes or
// refused.
function parseIPv6(input: string): Uint8Array | null {
  let s = input.trim();
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);

  // Fold a trailing dotted-quad (e.g. "::ffff:127.0.0.1") into two hextets so
  // the rest of the parser only ever deals with hex groups.
  if (s.includes(".")) {
    const lastColon = s.lastIndexOf(":");
    if (lastColon === -1) return null;
    const quad = s.slice(lastColon + 1).split(".");
    if (quad.length !== 4) return null;
    const nums = quad.map((o) => (/^\d{1,3}$/.test(o) ? Number(o) : NaN));
    if (nums.some((n) => Number.isNaN(n) || n > 255)) return null;
    const high = ((nums[0] << 8) | nums[1]).toString(16);
    const low = ((nums[2] << 8) | nums[3]).toString(16);
    s = `${s.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;

  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  const head = parseGroups(halves[0]);
  if (!head) return null;
  const tail = halves.length === 2 ? parseGroups(halves[1]) : [];
  if (!tail) return null;

  let groups: number[];
  if (halves.length === 2) {
    if (head.length + tail.length > 7) return null; // "::" stands for >=1 group
    groups = [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = (groups[i] >> 8) & 0xff;
    bytes[i * 2 + 1] = groups[i] & 0xff;
  }
  return bytes;
}

function isZeroRange(b: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) if (b[i] !== 0) return false;
  return true;
}

// Non-globally-routable IPv6 ranges, evaluated on the parsed bytes so
// IPv4-embedding transition forms (mapped/compatible/NAT64/6to4) are caught
// by validating the IPv4 address they carry — the exact bypass a
// string-prefix check misses ("::ffff:7f00:1", "::ffff:a9fe:a9fe", ...).
function isDisallowedIPv6Bytes(b: Uint8Array): boolean {
  if (isZeroRange(b, 0, 16)) return true; // :: unspecified
  if (isZeroRange(b, 0, 15) && b[15] === 1) return true; // ::1 loopback
  if (isZeroRange(b, 0, 10) && b[10] === 0xff && b[11] === 0xff) {
    return isDisallowedIPv4(b[12], b[13], b[14]); // ::ffff:0:0/96 IPv4-mapped
  }
  if (isZeroRange(b, 0, 12)) {
    return isDisallowedIPv4(b[12], b[13], b[14]); // ::/96 IPv4-compatible (deprecated)
  }
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && isZeroRange(b, 4, 12)) {
    return isDisallowedIPv4(b[12], b[13], b[14]); // 64:ff9b::/96 NAT64
  }
  if (b[0] === 0x20 && b[1] === 0x02) {
    return isDisallowedIPv4(b[2], b[3], b[4]); // 2002::/16 6to4 (embedded IPv4 in bytes 2-5)
  }
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true; // 2001::/32 Teredo
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // 2001:db8::/32 documentation
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (b[0] === 0xff) return true; // ff00::/8 multicast
  return false;
}

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

// True if `host` is a literal IP the egress helper must refuse. Only
// meaningful for actual IP literals — a hostname returns false here and is
// validated per-address by the `lookup` hook instead.
function isDisallowedLiteral(host: string): boolean {
  const candidate = stripBrackets(host);
  const family = isIP(candidate);
  if (family === 4) return isDisallowedIPv4String(candidate);
  if (family === 6) {
    const bytes = parseIPv6(candidate);
    return bytes ? isDisallowedIPv6Bytes(bytes) : true; // unparsable → refuse
  }
  return false;
}

// Every address handed back by DNS (or a literal) goes through this —
// `isIP` first so a malformed entry is refused rather than passed through.
function isDisallowedResolvedAddress(address: string): boolean {
  const candidate = stripBrackets(address);
  const family = isIP(candidate);
  if (family === 4) return isDisallowedIPv4String(candidate);
  if (family === 6) {
    const bytes = parseIPv6(candidate);
    return bytes ? isDisallowedIPv6Bytes(bytes) : true;
  }
  return true;
}

// A `dns.lookup`-compatible function (used as undici's connector `lookup`
// option) that resolves every candidate address and only ever hands back
// one that passed our validation — undici connects to exactly that address,
// so there's no window between "we checked" and "we connected" for a
// different DNS answer to sneak in. Honours the caller's `all` flag so it
// matches whatever shape undici's connector expects.
type LookupCallback = (err: NodeJS.ErrnoException | null, address: unknown, family?: number) => void;

const validatingLookup = ((hostname: string, options: unknown, callback?: LookupCallback) => {
  const cb = (typeof options === "function" ? options : callback) as LookupCallback;
  const opts = (typeof options === "function" ? {} : options) as { all?: boolean };
  dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return cb(err, []);
    const list = Array.isArray(addresses) ? addresses : [addresses];
    const allowed = list.filter((a) => !isDisallowedResolvedAddress(a.address));
    if (allowed.length === 0) {
      return cb(new Error("EGRESS_BLOCKED: no allowed address"), []);
    }
    if (opts.all) return cb(null, allowed);
    return cb(null, allowed[0].address, allowed[0].family);
  });
}) as unknown as typeof dnsLookup;

// LOCAL-MODE ONLY opt-in (the self-hosted `mcpmaster` runtime, packages/
// mcpmaster): a developer running this on their own machine may legitimately
// want to wrap an API on localhost or their LAN, and on their own machine
// there is no cloud metadata endpoint or other tenant to protect. It's off
// by default and only the user can turn it on
// (`mcpmaster settings private-network on`). A multi-tenant deployment must
// never call it, so every check above stays unconditional there. Everything
// else (protocol allowlist, no redirects, timeout, size cap) still applies
// in local mode.
let privateNetworkAllowed = false;

export function allowPrivateNetworkEgress(allowed: boolean): void {
  if (allowed === privateNetworkAllowed) return;
  privateNetworkAllowed = allowed;
  // The agent's lookup is fixed at construction, so a flipped setting needs a
  // fresh agent rather than a pooled socket validated under the old rule.
  const previous = agentPromise;
  agentPromise = null;
  previous?.then((agent) => agent.close()).catch(() => {});
}

function buildAgent(Agent: Undici["Agent"]): Dispatcher {
  return new Agent({
    connect: {
      lookup: privateNetworkAllowed ? dnsLookup : validatingLookup,
      timeout: REQUEST_TIMEOUT_MS,
    },
  });
}

// One Agent for the whole process, not one per call.
//
// Constructing an Agent per request — and closing it in a `finally` — threw
// away undici's connection pool on every single outbound call, so each one
// paid a fresh DNS resolution and a full TCP+TLS handshake. `callMcpProxyTool`
// makes three validatedFetch calls per tool call (initialize,
// notifications/initialized, tools/call), so one user-visible action paid
// three of each.
//
// Safe to share because every *security* control here is a per-request option
// or a fixed function, never mutable state on the agent:
//   - `redirect: "manual"`, the protocol allowlist and the literal-IP check
//     are applied in validatedFetch() before the dispatcher is ever used;
//   - `lookup: validatingLookup` re-resolves and re-validates on *every*
//     connect, so a pooled socket is only ever reused for an address that was
//     validated at connect time, and a validated-address binding cannot leak
//     between requests;
//   - the per-request timeout is the AbortController's, not the agent's.
// The connection pool is keyed by origin by undici itself, so pooling cannot
// carry one origin's socket to another.
//
// The cached promise, not the agent, is what's memoized: `loadUndici()` is
// async, and two concurrent first calls must not each build an agent. A failed
// load clears the slot so a later call can retry rather than inheriting a
// permanently-rejected promise.
let agentPromise: Promise<Dispatcher> | null = null;

function sharedAgent(): Promise<Dispatcher> {
  if (!agentPromise) {
    agentPromise = loadUndici()
      .then(({ Agent }) => buildAgent(Agent))
      .catch((error: unknown) => {
        agentPromise = null;
        throw error;
      });
  }
  return agentPromise;
}

export type ValidatedFetchOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  // Overrides MAX_RESPONSE_BYTES for this call. Only raise this for one-time
  // work (a spec fetch or introspection when an integration is added or
  // re-synced) where a bigger bounded read is an acceptable memory cost —
  // never for a live tool call, which must keep the tight default so a
  // single invocation can't be used to balloon memory on every request.
  maxBytes?: number;
};

export type ValidatedFetchResult = {
  status: number;
  headers: Headers;
  text: string;
};

// Fetches a user-supplied URL through the validated-egress path above.
// Redirects are never followed. Bounded timeout and response size.
export async function validatedFetch(
  rawUrl: string,
  options: ValidatedFetchOptions = {},
): Promise<ValidatedFetchResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new EgressBlockedError("Invalid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new EgressBlockedError("Only http/https URLs are allowed");
  }

  // A literal IP in the URL bypasses our lookup() hook entirely (undici
  // never calls lookup for a dotted-quad/IPv6-literal host) — validate it up
  // front so "http://169.254.169.254/" doesn't sail through. URL.hostname
  // keeps the brackets for IPv6, so strip them before classifying.
  if (!privateNetworkAllowed && isDisallowedLiteral(url.hostname)) {
    throw new EgressBlockedError("That address isn't reachable");
  }

  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const { fetch: undiciFetch } = await loadUndici();
  const agent = await sharedAgent();

  try {
    const response = await undiciFetch(url, {
      method: options.method ?? "GET",
      headers: options.headers,
      body: options.body,
      redirect: "manual",
      signal: controller.signal,
      dispatcher: agent,
    });

    if (response.status >= 300 && response.status < 400) {
      // A validated URL that 3xx's to an internal address is the same
      // attack through a different door — refuse rather than
      // silently following it.
      throw new EgressBlockedError("That source redirected somewhere else — redirects aren't followed");
    }

    const reader = response.body?.getReader();
    if (!reader) return { status: response.status, headers: response.headers as unknown as Headers, text: "" };

    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new EgressBlockedError("That source's response was too large");
      }
      chunks.push(value);
    }

    const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
    return { status: response.status, headers: response.headers as unknown as Headers, text };
  } catch (err) {
    if (err instanceof EgressBlockedError) throw err;
    if (controller.signal.aborted) throw new EgressBlockedError("That source took too long to respond");
    throw new EgressBlockedError("Could not reach that source");
  } finally {
    clearTimeout(timeout);
    // The agent is deliberately NOT closed here: it is process-wide and shared
    // by every concurrent validatedFetch, so closing it would abort in-flight
    // requests and force the next caller to rebuild the pool. Its sockets are
    // idle-timed-out by undici and die with the process (a serverless
    // invocation ends with the response), which is why there is no teardown
    // path for it to miss.
  }
}
