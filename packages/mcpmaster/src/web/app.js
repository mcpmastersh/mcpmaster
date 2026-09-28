// mcpmaster local web UI — a thin management layer over the local API.
//
// Deliberately framework-free and dependency-free: it ships inlined in the
// single-file CLI bundle. Every piece of text from an integration (tool
// names, descriptions, schemas) is untrusted — it came from someone else's
// spec — so the DOM is only ever built with textContent via h(), never
// innerHTML.

"use strict";

// ---------------------------------------------------------------------------
// Token — arrives once in the URL fragment (never sent to a server), kept in
// sessionStorage for this tab, then scrubbed from the address bar.
// ---------------------------------------------------------------------------

const TOKEN_KEY = "mcpmaster.token";

function readToken() {
  const match = /(?:^#|&)token=([^&]+)/.exec(location.hash);
  if (match) {
    const token = decodeURIComponent(match[1]);
    try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* private mode */ }
    history.replaceState(null, "", `${location.pathname}#/`);
    return token;
  }
  try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}

let token = readToken();

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function api(method, path, body) {
  // The server takes only JSON on anything but GET/DELETE (a cross-site form
  // can't send it), so a body-less POST such as sign-in still sends `{}`.
  if (body === undefined && method !== "GET" && method !== "DELETE") body = {};
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "mcpmaster isn't reachable — is it still running? Start it with `mcpmaster up`.");
  }
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (res.status === 401) {
    token = null;
    try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
    render();
    throw new ApiError(401, "Your session expired");
  }
  if (!res.ok) throw new ApiError(res.status, data.error || "Something went wrong. Please try again.");
  return data;
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on")) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "class") el.className = value;
    else if (key === "value") el.value = value;
    else if (key === "checked") el.checked = Boolean(value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  append(el, children);
  return el;
}

/**
 * replaceChildren() for conditional content: `null`/`false` children are
 * skipped (replaceChildren itself would render them as the text "null").
 */
function fill(el, ...children) {
  el.replaceChildren();
  return append(el, children);
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const ICONS = {
  plug: "M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0V8zM12 18v4",
  tools: "M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4 2.5-2.5z",
  link: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  plus: "M12 5v14M5 12h14",
  refresh: "M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M3 21v-5h5",
  trash: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  back: "M15 18l-6-6 6-6",
  play: "M7 4l13 8-13 8z",
};

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

function toast(message, kind = "ok") {
  const el = h("div", { class: `toast ${kind}`, role: "status" }, message);
  document.body.append(el);
  setTimeout(() => el.remove(), 3200);
}

async function copy(text, label = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
  } catch {
    toast("Couldn't copy — select the text and copy it manually", "fail");
  }
}

function codeBlock(text, display = text) {
  return h("div", { class: "code" }, display,
    h("button", { class: "btn btn-sm btn-ghost copy", "aria-label": "Copy", onclick: () => copy(text) }, icon("copy")));
}

// The one modal. Focus is trapped inside, Escape closes, the page behind is
// inert — no window.confirm/alert anywhere.
function openDialog(build, onClose) {
  const previous = document.activeElement;
  const overlay = h("div", { class: "overlay" });
  const dialog = h("div", { class: "dialog", role: "dialog", "aria-modal": "true" });
  overlay.append(dialog);
  const app = document.getElementById("app");
  const close = () => {
    overlay.remove();
    app.inert = false;
    document.removeEventListener("keydown", onKey);
    if (previous && previous.focus) previous.focus();
    if (onClose) onClose();
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
    if (e.key === "Tab") {
      const items = [...dialog.querySelectorAll("button, input, select, textarea, a[href]")].filter((n) => !n.disabled);
      if (items.length === 0) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey);
  append(dialog, [build(close)]);
  document.body.append(overlay);
  app.inert = true;
  const focusTarget = dialog.querySelector("[autofocus]") || dialog.querySelector("input, textarea, button");
  if (focusTarget) focusTarget.focus();
  return close;
}

function confirmDialog({ title, description, confirmLabel, danger }) {
  return new Promise((resolve) => {
    let answer = false;
    // Escape, the backdrop and Cancel all close without confirming.
    openDialog((close) => [
      h("h2", {}, title),
      h("p", { class: "desc" }, description),
      h("div", { class: "dialog-actions" },
        h("button", { class: "btn", onclick: close }, "Cancel"),
        h("button", { class: `btn ${danger ? "btn-danger" : "btn-primary"}`, autofocus: true, onclick: () => { answer = true; close(); } }, confirmLabel)),
    ], () => resolve(answer));
  });
}

// ---------------------------------------------------------------------------
// State + routing
// ---------------------------------------------------------------------------

// The browser never holds the whole tool list: a few integrations can bring
// well over a thousand tools, so lists come from the server a page at a time
// (filtered and searched there) and a tool's schema only when it's opened.
const PAGE_SIZE = 50;
const store = { state: null, snippet: undefined };

async function refresh() {
  store.state = await api("GET", "/api/state");
}

// Callbacks a page registers to repaint its own counts after refreshChrome().
let chromeWatchers = [];

// After a small change (one switch), fetch fresh counts and repaint only the
// sidebar and whatever the page registered — never the whole page.
async function refreshChrome() {
  try { await refresh(); } catch { return; }
  const old = document.querySelector(".sidebar");
  if (old) old.replaceWith(sidebar(route().page));
  for (const fn of chromeWatchers) fn();
}

function route() {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [path, qs = ""] = raw.split("?");
  const parts = path.split("/").filter(Boolean);
  return { page: parts[0] || "integrations", id: parts[1], params: new URLSearchParams(qs) };
}

function go(path) {
  location.hash = path;
}

// Keep list filters in the address bar (so reload and back keep them)
// without triggering a navigation.
function setParams(entries) {
  const { page, id } = route();
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) if (value) params.set(key, value);
  const qs = params.toString();
  history.replaceState(null, "", `#/${[page, id].filter(Boolean).join("/")}${qs ? `?${qs}` : ""}`);
}

window.addEventListener("hashchange", () => render());

function fetchTools(query, offset, limit = PAGE_SIZE) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value) params.set(key, value);
  params.set("offset", String(offset));
  params.set("limit", String(limit));
  return api("GET", `/api/tools?${params}`);
}

async function fetchTool(name) {
  const { tool } = await api("GET", `/api/tools/${encodeURIComponent(name)}`);
  return tool;
}

function plural(n, word) {
  return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

// Screen readers hear loading and result changes from one polite region,
// not from the whole app re-announcing itself.
function announce(message) {
  let region = document.getElementById("announce");
  if (!region) {
    region = h("div", { id: "announce", class: "sr-only", role: "status", "aria-live": "polite" });
    document.body.append(region);
  }
  region.textContent = "";
  setTimeout(() => { region.textContent = message; }, 30);
}

// ---------------------------------------------------------------------------
// Skeletons — the page's own shape while its data loads, so nothing jumps
// when the real content replaces it in one swap.
// ---------------------------------------------------------------------------

function sk(cls) {
  return h("span", { class: `sk ${cls || ""}` });
}

function skRows(n, withSwitch) {
  return h("div", { class: "list" }, Array.from({ length: n }, (_, i) =>
    h("div", { class: "list-row sk-row" },
      h("div", { class: "sk-stack" }, sk(i % 3 === 0 ? "w50" : i % 3 === 1 ? "w40" : "w60"), sk("w80 thin")),
      withSwitch ? sk("switch") : null)));
}

function skeleton(kind) {
  const head = h("div", { class: "page-head" }, h("div", { class: "sk-stack" }, sk("title"), sk("w60 thin")));
  const card = (...lines) => h("div", { class: "card sk-stack" }, lines.map((w) => sk(w)));
  let body;
  if (kind === "tools") {
    body = [head, card("w30", "w70 thin"),
      h("div", { class: "toolbar" }, sk("field grow"), sk("field"), sk("field")),
      h("div", { class: "tools-layout" }, skRows(9, false), card("w50", "w80 thin", "w70 thin", "w40 thin"))];
  } else if (kind === "integration") {
    body = [sk("w10 thin"), head, card("w40 thin", "w30 thin", "w50 thin", "w30 thin"), card("w20", "w70 thin"), card("w20", "w60 thin", "w60 thin"), skRows(6, true)];
  } else {
    body = [head, h("div", { class: "stats" }, card("w30", "w60 thin"), card("w30", "w60 thin"), card("w30", "w60 thin")), skRows(4, false)];
  }
  return h("div", { class: "skeleton", "aria-hidden": "true" }, body);
}

function sidebarSkeleton() {
  return h("nav", { class: "sidebar", "aria-hidden": "true" },
    h("div", { class: "brand" }, h("img", { src: "/logo.svg", alt: "" }), "mcpmaster"),
    Array.from({ length: 4 }, () => h("div", { class: "nav-item" }, sk("w70 thin"))));
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

const TYPE_LABEL = { openapi: "OpenAPI", graphql: "GraphQL", mcp: "MCP · remote", stdio: "MCP · local" };

function statusBadge(source) {
  if (!source.enabled) return h("span", { class: "badge off" }, h("span", { class: "dot" }), "Disabled");
  if (source.status === "ready") return h("span", { class: "badge ok" }, h("span", { class: "dot" }), "Connected");
  if (source.status === "failed") return h("span", { class: "badge fail" }, h("span", { class: "dot" }), "Needs attention");
  if (source.status === "needs_auth") return h("span", { class: "badge warn" }, h("span", { class: "dot" }), "Sign in needed");
  return h("span", { class: "badge warn" }, h("span", { class: "spinner" }), "Syncing");
}

function target(source) {
  if (source.type === "stdio") return [source.command, ...(source.args || [])].join(" ");
  return source.url || "";
}

// Why a tool is hidden, as a badge. The server supplies the wording.
function blockBadge(tool) {
  if (tool.blockedBy) return h("span", { class: "badge off", title: "Hidden from agents" }, tool.blockedBy.label);
  if (tool.allowedOverride) return h("span", { class: "badge ok", title: "Exposed despite a rule, read-only or review" }, "allowed over rule");
  return null;
}

function accessBadge(tool) {
  if (tool.access === "read") return h("span", { class: "badge type" }, "reads");
  if (tool.access === "write") return h("span", { class: "badge type write" }, "writes");
  return h("span", { class: "badge type", title: "The server doesn't say whether this tool changes anything. Read-only mode hides it." }, "may write");
}

function sidebar(active) {
  const s = store.state;
  const item = (page, label, iconName, count) =>
    h("a", { class: "nav-item", href: `#/${page}`, "aria-current": active === page ? "page" : undefined },
      icon(iconName), label, count !== undefined ? h("span", { class: "count" }, count) : null);
  return h("nav", { class: "sidebar", "aria-label": "Main" },
    h("div", { class: "brand" }, h("img", { src: "/logo.svg", alt: "" }), "mcpmaster", h("small", {}, `v${s.version}`)),
    item("integrations", "Integrations", "plug", s.integrations.length),
    item("tools", "Tools", "tools", s.enabledToolCount),
    item("connect", "Connect an agent", "link"),
    item("settings", "Settings", "settings"),
    h("div", { class: "sidebar-foot" }, h("span", { class: "live" }, "Running locally"), h("div", { class: "mono" }, location.host)));
}

// ---------------------------------------------------------------------------
// Add integration — "paste anything"
// ---------------------------------------------------------------------------

const EXAMPLES = [
  { label: "Petstore · OpenAPI", input: "https://petstore3.swagger.io/api/v3/openapi.json", type: "openapi" },
  { label: "Countries · GraphQL", input: "https://countries.trevorblades.com/graphql", type: "graphql" },
  { label: "Filesystem · local MCP", input: "npx -y @modelcontextprotocol/server-filesystem ~" },
  { label: "Memory · local MCP", input: "npx -y @modelcontextprotocol/server-memory" },
];

// ---------------------------------------------------------------------------
// OAuth2 with your own client — shared by the add and credential dialogs
// ---------------------------------------------------------------------------

function segmentedControl(options, current, onPick) {
  return h("div", { class: "segmented", role: "group" }, options.map(([value, label]) =>
    h("button", { type: "button", "aria-pressed": String(current === value), onclick: () => onPick(value) }, label)));
}

function oauth2Form(auth) {
  const a = auth && auth.type === "oauth2" ? auth : {};
  return {
    grant: a.grant || "authorization_code", authorizeUrl: a.authorizeUrl || "", tokenUrl: a.tokenUrl || "",
    clientId: a.clientId || "", registrationUrl: a.registrationUrl || "", resource: a.resource || "", scope: a.scope || "", basic: a.clientAuth === "basic",
    useEnv: Boolean(a.clientSecretEnv), secretEnv: a.clientSecretEnv || "", secret: "",
    issuer: "", lookup: null, autoFor: "", manual: false,
  };
}

// Most providers publish their endpoints (RFC 8414 / OpenID Connect
// discovery), so they're looked up rather than copied by hand: on the
// integration's own URL automatically (`auto`), or on an issuer URL the user
// gives when that finds nothing. The endpoint fields show only then.
async function findOAuth2Endpoints(o, url, paint, auto = false) {
  if (!url) {
    o.lookup = { miss: "Enter the provider's issuer URL, like https://accounts.google.com." };
    paint();
    return;
  }
  o.lookup = { busy: true, auto };
  paint();
  let host = url;
  try { host = new URL(url).host; } catch { /* show it as is */ }
  try {
    const found = await api("POST", "/api/oauth2/discover", { url });
    if (auto && o.autoFor !== url) return; // the URL changed meanwhile
    o.authorizeUrl = found.authorizeUrl || "";
    o.tokenUrl = found.tokenUrl;
    o.registrationUrl = found.registrationUrl || "";
    o.resource = found.resource || "";
    if (found.clientAuth === "basic") o.basic = true;
    try { host = new URL(found.metadataUrl).host; } catch { /* keep the one asked */ }
    o.manual = false;
    o.lookup = { found: true, host, auto, scopes: found.scopes || [] };
  } catch (e) {
    if (auto && o.autoFor !== url) return;
    o.manual = true;
    o.registrationUrl = "";
    o.resource = "";
    o.lookup = {
      auto,
      miss: auto
        ? `${host} doesn't publish its OAuth settings. Enter them below, or look them up from the provider's issuer URL.`
        : e.message,
    };
  }
  paint();
}

// `editing`: the integration already has these settings, so an empty secret
// field means "keep the stored one".
// `guess`: the integration's URL, where the provider's settings may be published.
function oauth2Fields(o, paint, editing = false, guess = "") {
  const browser = o.grant === "authorization_code";
  const text = (id, label, key, placeholder) => h("div", { class: "field" }, h("label", { for: id }, label),
    h("input", { type: "text", id, value: o[key], placeholder, autocomplete: "off", spellcheck: "false", oninput: (e) => { o[key] = e.target.value; } }));
  const redirect = store.state && store.state.oauthRedirectUrl;
  // A browser sign-in with nothing of the user's own: mcpmaster registers a client.
  const registers = browser && Boolean(o.registrationUrl);
  const ownClient = !registers || Boolean(o.clientId.trim());

  // Look the URL up once, and again when it changes — unless the user has
  // taken over, or (editing) the endpoints are already set.
  if (guess && o.autoFor !== guess && !(o.manual && !(o.lookup && o.lookup.auto))) {
    // What an earlier lookup filled in is replaced; what the user typed isn't.
    const stale = o.lookup && o.lookup.auto && o.lookup.found;
    if (stale || (!o.tokenUrl && !o.authorizeUrl)) {
      if (stale) { o.tokenUrl = ""; o.authorizeUrl = ""; o.registrationUrl = ""; o.resource = ""; }
      o.autoFor = guess;
      o.lookup = { busy: true, auto: true };
      setTimeout(() => findOAuth2Endpoints(o, guess, paint, true), 0);
    }
  }

  const lookup = o.lookup || {};
  const found = lookup.found && !o.manual && (!browser || o.authorizeUrl);
  const find = () => findOAuth2Endpoints(o, o.issuer.trim(), paint);
  const endpoints = lookup.busy
    ? h("div", { class: "field hint", role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), " Looking up the provider's OAuth settings…")
    : found
      ? h("div", { class: "field" }, h("label", {}, "Endpoints"),
        h("div", { class: "found-box" },
          h("div", { class: "hint ok", role: "status" }, `Found ${lookup.host}'s published OAuth settings`,
            browser && o.registrationUrl ? " — no OAuth app needed, mcpmaster registers itself when you sign in." : ""),
          h("dl", { class: "kv" },
            browser ? [h("dt", {}, "Authorization"), h("dd", { class: "mono" }, o.authorizeUrl)] : null,
            h("dt", {}, "Token"), h("dd", { class: "mono" }, o.tokenUrl)),
          h("a", { href: "#", class: "hint", onclick: (e) => { e.preventDefault(); o.manual = true; o.lookup = null; paint(); } }, "Enter them by hand")))
      : h("div", {},
        lookup.found && browser && !o.authorizeUrl
          ? h("div", { class: "field hint" }, `${lookup.host} publishes no sign-in page — use Client credentials, or add the authorization URL.`) : null,
        h("div", { class: "field" }, h("label", { for: "o-issuer" }, "Provider issuer URL (optional)"),
          h("div", { class: "input-row" },
            h("input", { type: "text", id: "o-issuer", value: o.issuer, placeholder: "https://accounts.google.com", autocomplete: "off", spellcheck: "false",
              oninput: (e) => { o.issuer = e.target.value; },
              onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); find(); } } }),
            h("button", { type: "button", class: "btn btn-sm", onclick: find }, "Find endpoints")),
          lookup.miss ? h("div", { class: lookup.auto ? "hint" : "field-error", role: lookup.auto ? "status" : "alert" }, lookup.miss)
            : h("div", { class: "hint" }, "mcpmaster reads the endpoints a provider publishes. Or fill them in below.")),
        browser ? text("o-authorize", "Authorization URL", "authorizeUrl", "https://provider.example.com/oauth/authorize") : null,
        text("o-token", "Token URL", "tokenUrl", "https://provider.example.com/oauth/token"));
  return h("div", {},
    h("div", { class: "field" }, h("label", {}, "Grant"),
      segmentedControl([["authorization_code", "Browser sign-in"], ["client_credentials", "Client credentials"]], o.grant, (v) => { o.grant = v; paint(); }),
      h("div", { class: "hint" }, browser
        ? "You approve access once on the provider's consent screen (authorization code with PKCE). Tokens refresh on their own."
        : "Machine-to-machine: mcpmaster trades the client ID and secret for a token. No sign-in.")),
    endpoints,
    h("div", { class: "field" },
      h("label", { for: "o-client" }, registers ? "Client ID (optional)" : "Client ID"),
      h("input", { type: "text", id: "o-client", value: o.clientId, autocomplete: "off", spellcheck: "false",
        placeholder: registers ? "Leave empty to have mcpmaster register itself" : "",
        oninput: (e) => { o.clientId = e.target.value; }, onchange: () => paint() }),
      registers ? h("div", { class: "hint" }, "The provider supports dynamic client registration, so mcpmaster can sign in without an OAuth app of your own. Enter a client ID only to use yours.") : null),
    !ownClient ? null : h("div", { class: "field" },
      h("label", { for: "o-secret" }, o.useEnv ? "Client secret: environment variable" : browser ? "Client secret (leave empty for a public client)" : "Client secret"),
      o.useEnv
        ? h("input", { type: "text", id: "o-secret", value: o.secretEnv, placeholder: "CLIENT_SECRET", spellcheck: "false", oninput: (e) => { o.secretEnv = e.target.value; } })
        : h("input", { type: "password", id: "o-secret", value: o.secret, autocomplete: "off", placeholder: editing ? "Unchanged" : "", oninput: (e) => { o.secret = e.target.value; } }),
      h("div", { class: "hint" },
        o.useEnv ? "Read from the environment mcpmaster runs in. " : "Stored in ~/.mcpmaster with owner-only permissions and never shown again. ",
        h("a", { href: "#", onclick: (e) => { e.preventDefault(); o.useEnv = !o.useEnv; paint(); } }, o.useEnv ? "Store a value instead" : "Use an environment variable instead"))),
    text("o-scope", "Scopes (optional)", "scope", "read write"),
    lookup.scopes && lookup.scopes.length ? h("div", { class: "hint scopes" }, "Offered: ",
      lookup.scopes.slice(0, 16).join(" "), lookup.scopes.length > 16 ? ` … ${lookup.scopes.length - 16} more` : "") : null,
    !ownClient ? null : h("div", { class: "field checks" },
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: o.basic, onchange: (e) => { o.basic = e.target.checked; } }),
        " Send the client ID and secret as HTTP Basic (some providers require it)")),
    browser && redirect && ownClient ? h("div", { class: "field" }, h("label", {}, "Redirect URI"), codeBlock(redirect),
      h("div", { class: "hint" }, "Register this exact URI on your OAuth app. It points at this machine, so the sign-in code never leaves it.")) : null);
}

/** `{ auth, clientSecret }` for the API, or `{ error }` to show. */
function oauth2Payload(o, editing = false) {
  const browser = o.grant === "authorization_code";
  if (o.lookup && o.lookup.busy) return { error: "Still looking up the provider's OAuth settings — one moment." };
  if (browser && !o.authorizeUrl.trim()) return { error: "Add the provider's authorization URL." };
  if (!o.tokenUrl.trim()) return { error: "Add the provider's token URL." };
  const registers = browser && Boolean(o.registrationUrl) && !o.clientId.trim();
  if (!o.clientId.trim() && !registers) return { error: "Add the client ID." };
  if (!registers && o.useEnv && !o.secretEnv.trim()) return { error: "Name the environment variable." };
  if (!browser && !o.useEnv && !o.secret && !editing) return { error: "Client credentials need the client secret." };
  const auth = {
    type: "oauth2", grant: o.grant, tokenUrl: o.tokenUrl.trim(), clientId: o.clientId.trim() || undefined,
    registrationUrl: registers ? o.registrationUrl : undefined, resource: o.resource || undefined,
    authorizeUrl: browser ? o.authorizeUrl.trim() : undefined, scope: o.scope.trim() || undefined,
    // A registered client's own auth method comes from its registration.
    clientAuth: o.basic && !registers ? "basic" : undefined, clientSecretEnv: o.useEnv && !registers ? o.secretEnv.trim() : undefined,
  };
  return { auth, clientSecret: !registers && !o.useEnv && o.secret ? o.secret : undefined };
}

function addDialog(initialInput = "", initialType = "") {
  openDialog((close) => {
    const form = { input: initialInput, name: "", type: "", authType: "none", token: "", useEnv: false, envName: "", header: "", env: [], readOnly: false, hideNewTools: false, oauth2: oauth2Form() };
    let detected = null;
    let busy = false;

    const inputEl = h("input", { type: "text", id: "add-input", value: initialInput, autocomplete: "off", spellcheck: "false", autofocus: true,
      placeholder: "https://api.example.com/openapi.json  ·  ./spec.yaml  ·  npx -y some-mcp-server" });
    const detectedEl = h("div", { class: "detected" });
    const nameEl = h("input", { type: "text", id: "add-name", autocomplete: "off", spellcheck: "false", placeholder: "auto" });
    const typeEl = h("select", { id: "add-type" },
      h("option", { value: "", disabled: true, selected: true }, "Choose a type"),
      h("option", { value: "openapi" }, "OpenAPI"),
      h("option", { value: "graphql" }, "GraphQL"),
      h("option", { value: "mcp" }, "MCP server (remote)"));
    if (initialType) typeEl.value = initialType;
    const errorEl = h("div", { class: "field-error", role: "alert" });
    const authArea = h("div");
    const envArea = h("div");
    const submit = h("button", { class: "btn btn-primary", type: "submit" }, "Connect");

    const kindText = {
      url: "A URL — choose whether it's OpenAPI, GraphQL or an MCP server.",
      file: "A local OpenAPI spec file.",
      command: "A command — it runs on this machine as a local MCP server.",
    };

    let timer = null;
    const detect = () => {
      clearTimeout(timer);
      const value = inputEl.value.trim();
      form.input = value;
      if (!value) { detected = null; detectedEl.replaceChildren(); paint(); return; }
      timer = setTimeout(async () => {
        try {
          const result = await api("POST", "/api/detect", { input: value });
          if (form.input !== value) return;
          detected = result;
          detectedEl.replaceChildren(h("span", { class: "badge type" }, result.kind), kindText[result.kind]);
          nameEl.placeholder = result.suggestedName;
        } catch (e) {
          detected = null;
          detectedEl.replaceChildren(h("span", { class: "field-error" }, e.message));
        }
        paint();
      }, 250);
    };
    inputEl.addEventListener("input", detect);

    const segmented = (options, current, onPick) =>
      h("div", { class: "segmented", role: "group" }, options.map(([value, label]) =>
        h("button", { type: "button", "aria-pressed": String(current === value), onclick: () => onPick(value) }, label)));

    function paint() {
      const isCommand = detected && detected.kind === "command";
      typeEl.parentElement.hidden = !detected || detected.kind !== "url";
      authArea.hidden = isCommand;
      envArea.hidden = !isCommand;

      fill(authArea,
        h("div", { class: "field" }, h("label", {}, "Authentication"),
          segmented([["none", "None"], ["bearer", "Bearer token"], ["api_key", "API key"], ["oauth2", "OAuth2"]], form.authType, (v) => { form.authType = v; paint(); })),
        form.authType === "oauth2" ? oauth2Fields(form.oauth2, paint, false, detected && detected.kind === "url" ? form.input : "") : null,
        form.authType === "none" || form.authType === "oauth2" ? null : h("div", {},
          form.authType === "api_key" ? h("div", { class: "field" }, h("label", { for: "add-header" }, "Header"),
            h("input", { type: "text", id: "add-header", value: form.header, placeholder: "X-API-Key", oninput: (e) => { form.header = e.target.value; } })) : null,
          h("div", { class: "field" },
            h("label", { for: "add-secret" }, form.useEnv ? "Environment variable" : form.authType === "bearer" ? "Token" : "Key"),
            form.useEnv
              ? h("input", { type: "text", id: "add-secret", value: form.envName, placeholder: "GITHUB_TOKEN", spellcheck: "false", oninput: (e) => { form.envName = e.target.value; } })
              : h("input", { type: "password", id: "add-secret", value: form.token, autocomplete: "off", oninput: (e) => { form.token = e.target.value; } }),
            h("div", { class: "hint" },
              form.useEnv ? "Read from the environment mcpmaster runs in, every call. " : "Stored in ~/.mcpmaster with owner-only permissions and never shown again. ",
              h("a", { href: "#", onclick: (e) => { e.preventDefault(); form.useEnv = !form.useEnv; paint(); } }, form.useEnv ? "Store a value instead" : "Use an environment variable instead")))));

      fill(envArea,
        h("label", {}, "Environment variables ", h("span", { class: "hint" }, "(optional — e.g. an API key the server needs)")),
        form.env.map((pair, i) => h("div", { class: "env-row" },
          h("input", { type: "text", value: pair.key, placeholder: "NAME", "aria-label": "Variable name", spellcheck: "false", oninput: (e) => { pair.key = e.target.value; } }),
          h("input", { type: "password", value: pair.value, placeholder: "value", "aria-label": "Variable value", autocomplete: "off", oninput: (e) => { pair.value = e.target.value; } }),
          h("button", { type: "button", class: "btn btn-sm btn-ghost", "aria-label": "Remove variable", onclick: () => { form.env.splice(i, 1); paint(); } }, icon("trash")))),
        h("button", { type: "button", class: "btn btn-sm", onclick: () => { form.env.push({ key: "", value: "" }); paint(); } }, icon("plus"), "Add variable"));
    }

    const onSubmit = async (e) => {
      e.preventDefault();
      if (busy) return;
      errorEl.textContent = "";
      if (!form.input) { errorEl.textContent = "Paste a URL, a spec file path or a command."; inputEl.focus(); return; }
      const body = { input: form.input, readOnly: form.readOnly, hideNewTools: form.hideNewTools };
      if (nameEl.value.trim()) body.name = nameEl.value.trim();
      if (typeEl.value && detected && detected.kind === "url") body.type = typeEl.value;
      if (detected && detected.kind === "url" && !typeEl.value) {
        errorEl.textContent = "Choose its type — OpenAPI, GraphQL or MCP server.";
        typeEl.focus();
        return;
      }
      if (detected && detected.kind === "command") {
        const env = {};
        for (const { key, value } of form.env) if (key.trim()) env[key.trim()] = value;
        if (Object.keys(env).length) body.env = env;
      } else if (form.authType === "oauth2") {
        const payload = oauth2Payload(form.oauth2);
        if (payload.error) { errorEl.textContent = payload.error; return; }
        body.auth = payload.auth;
        if (payload.clientSecret) body.clientSecret = payload.clientSecret;
      } else if (form.authType !== "none") {
        body.auth = { type: form.authType, header: form.header.trim() || undefined, env: form.useEnv ? form.envName.trim() : undefined };
        if (!form.useEnv) {
          if (!form.token) { errorEl.textContent = "Add the credential, or choose None."; return; }
          body.token = form.token;
        } else if (!form.envName.trim()) { errorEl.textContent = "Name the environment variable."; return; }
      }
      busy = true;
      submit.disabled = true;
      submit.replaceChildren(h("span", { class: "spinner" }), "Connecting…");
      try {
        const { integration } = await api("POST", "/api/integrations", body);
        close();
        toast(integration.status === "needs_auth" ? `${integration.name} uses OAuth: sign in to finish connecting` : `Connected ${integration.name} · ${integration.toolCount} tools`);
        // go() renders through hashchange; render directly when already there.
        if (location.hash === `#/integrations/${integration.id}`) render({ soft: true });
        else go(`/integrations/${integration.id}`);
      } catch (err) {
        errorEl.textContent = err.message;
        busy = false;
        submit.disabled = false;
        submit.replaceChildren("Connect");
      }
    };

    const formEl = h("form", { onsubmit: onSubmit, novalidate: true },
      h("h2", {}, "Add an integration"),
      h("p", { class: "desc" }, "Paste an OpenAPI spec URL or file, a GraphQL endpoint, an MCP server URL, or a command that starts a local MCP server."),
      h("div", { class: "field" }, h("label", { for: "add-input" }, "What should agents connect to?"), inputEl, detectedEl),
      h("div", { class: "field" }, h("label", { for: "add-name" }, "Name"), nameEl, h("div", { class: "hint" }, "Also the prefix on its tools, e.g. github_list_repos.")),
      h("div", { class: "field", hidden: true }, h("label", { for: "add-type" }, "Type"), typeEl),
      authArea,
      envArea,
      h("div", { class: "field checks" },
        h("label", { class: "check" }, h("input", { type: "checkbox", onchange: (e) => { form.readOnly = e.target.checked; } }), " Read-only — only expose tools that read"),
        h("label", { class: "check" }, h("input", { type: "checkbox", onchange: (e) => { form.hideNewTools = e.target.checked; } }), " Hide tools added by future syncs until I review them")),
      errorEl,
      h("div", { class: "dialog-actions" }, h("button", { type: "button", class: "btn", onclick: close }, "Cancel"), submit));
    paint();
    if (initialInput) detect();
    return formEl;
  });
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function pasteBox() {
  const input = h("input", { type: "text", "aria-label": "URL, spec file or command", spellcheck: "false", autocomplete: "off",
    placeholder: "Paste an OpenAPI or GraphQL URL, an MCP server, or a command…" });
  return h("div", {},
    h("form", { class: "paste", onsubmit: (e) => { e.preventDefault(); addDialog(input.value.trim()); } },
      input, h("button", { class: "btn btn-primary", type: "submit" }, icon("plus"), "Connect")),
    h("div", { class: "chips" }, h("span", { class: "hint" }, "Try:"),
      EXAMPLES.map((ex) => h("button", { class: "chip", type: "button", onclick: () => addDialog(ex.input, ex.type) }, ex.label))));
}

function integrationsPage() {
  const { integrations, enabledToolCount } = store.state;
  if (integrations.length === 0) {
    return h("div", {},
      h("section", { class: "hero" },
        h("h1", {}, "Connect your agents to ", h("em", {}, "anything"), "."),
        h("p", {}, "Paste any API or MCP server. mcpmaster turns it into tools and serves every one of them to Claude, Cursor, Codex and any other agent through a single MCP endpoint."),
        pasteBox()),
      h("div", { class: "kinds" },
        [["OpenAPI", "REST APIs from a JSON or YAML spec — URL or local file."],
         ["GraphQL", "Any endpoint with introspection. Queries and mutations become tools."],
         ["MCP · remote", "Hosted MCP servers over Streamable HTTP, JSON or SSE."],
         ["MCP · local", "Any command that starts an MCP server, like npx packages."]]
          .map(([b, s]) => h("div", { class: "kind" }, h("b", {}, b), h("span", {}, s)))));
  }
  const failing = integrations.filter((s) => s.enabled && (s.status === "failed" || s.status === "needs_auth")).length;
  return h("div", {},
    h("div", { class: "page-head" },
      h("div", {}, h("h1", {}, "Integrations"), h("p", {}, "Everything your agents can reach, through one endpoint.")),
      h("button", { class: "btn btn-primary", onclick: () => addDialog() }, icon("plus"), "Add integration")),
    h("div", { class: "stats" },
      h("div", { class: "stat" }, h("div", { class: "n" }, integrations.length), h("div", { class: "l" }, "Integrations")),
      h("div", { class: "stat" }, h("div", { class: "n" }, enabledToolCount), h("div", { class: "l" }, "Tools exposed to agents")),
      h("div", { class: "stat" }, h("div", { class: "n" }, failing), h("div", { class: "l" }, failing === 1 ? "Needs attention" : "Need attention"))),
    h("div", { class: "list" }, integrations.map((s) =>
      h("a", { class: "list-row", href: `#/integrations/${s.id}` },
        h("div", { class: "row-main" }, h("div", { class: "avatar", "aria-hidden": "true" }, s.name.slice(0, 1)),
          h("div", {},
            h("div", { class: "title" }, s.name, h("span", { class: "badge type" }, TYPE_LABEL[s.type])),
            h("div", { class: "meta mono" }, s.error && s.enabled ? s.error : target(s)))),
        h("div", { class: "right" }, `${s.toolCount} tools`, statusBadge(s))))));
}

// One tool as a row with an exposure switch. Toggling replaces just this row.
function switchRow(tool, onChange) {
  const input = h("input", { type: "checkbox", checked: tool.enabled, "aria-label": `Expose ${tool.name} to agents` });
  const row = h("div", { class: "list-row", "data-tool": tool.name },
    h("div", {}, h("div", { class: "title mono" }, tool.name, accessBadge(tool), blockBadge(tool)),
      tool.description ? h("div", { class: "meta" }, tool.description) : null),
    h("label", { class: "switch", title: tool.enabled ? "Exposed to agents" : "Hidden from agents" }, input, h("span", {})));
  input.addEventListener("change", async () => {
    const next = input.checked;
    input.disabled = true;
    try {
      const { tool: updated } = await api("PATCH", "/api/tools", { name: tool.name, enabled: next });
      const fresh = switchRow(updated, onChange);
      row.replaceWith(fresh);
      fresh.querySelector("input").focus();
      onChange(updated);
    } catch (e) {
      input.checked = !next;
      input.disabled = false;
      toast(e.message, "fail");
    }
  });
  return row;
}

const integrationSpec = {
  skeleton: "integration",
  load: (params, id) => fetchTools({ integration: id, q: params.get("q") || "" }, 0),
  view: integrationPage,
};

function integrationPage(page, params, id) {
  const source = store.state.integrations.find((s) => s.id === id);
  if (!source) return h("div", { class: "empty" }, h("b", {}, "That integration isn't here anymore"), h("a", { href: "#/integrations" }, "Back to integrations"));
  const current = () => store.state.integrations.find((s) => s.id === id) || source;

  const act = async (label, fn) => {
    try { await fn(); await render({ soft: true }); } catch (e) { toast(e.message, "fail"); }
    void label;
  };

  const sync = (btn) => act("sync", async () => {
    btn.disabled = true;
    btn.replaceChildren(h("span", { class: "spinner" }), "Syncing…");
    const { integration } = await api("POST", `/api/integrations/${id}/sync`);
    toast(integration.status === "ready" ? `Synced · ${integration.toolCount} tools` : integration.error, integration.status === "ready" ? "ok" : "fail");
  });

  const remove = async () => {
    const ok = await confirmDialog({ title: `Remove ${source.name}?`, description: "Its tools disappear from every connected agent and its stored credential is deleted. This can't be undone.", confirmLabel: "Remove", danger: true });
    if (!ok) return;
    try {
      await api("DELETE", `/api/integrations/${id}`);
      toast(`Removed ${source.name}`);
      go("/integrations");
    } catch (e) { toast(e.message, "fail"); }
  };

  // Every sign-in starts from nothing: the server discards the cached client
  // registration and tokens and registers a new client, so a stale client_id
  // is never reused. The window is opened synchronously (inside the click) so
  // popup blockers allow it, then pointed at the provider once we know where.
  const signIn = async (btn) => {
    const popup = window.open("", "_blank");
    if (popup) popup.opener = null;
    btn.disabled = true;
    btn.replaceChildren(h("span", { class: "spinner" }), "Starting sign-in…");
    try {
      const { authorizationUrl } = await api("POST", `/api/integrations/${id}/sign-in`);
      if (authorizationUrl) {
        if (popup) popup.location.href = authorizationUrl;
        else location.href = authorizationUrl;
        toast("Finish signing in in the new tab");
        watchUntilSettled(id);
      } else {
        if (popup) popup.close();
        toast(source.auth.type === "oauth2" ? "Got a new token" : "Signed in");
      }
      await render({ soft: true });
    } catch (e) {
      if (popup) popup.close();
      toast(e.message, "fail");
      btn.disabled = false;
      btn.replaceChildren("Sign in");
    }
  };

  const signOutAction = async () => {
    const description = source.auth.type === "oauth2"
      ? "Its tokens are deleted from this machine. Agents can't call its tools until you sign in again."
      : "Its tokens and client registration are deleted from this machine. Agents lose its tools until you sign in again.";
    const ok = await confirmDialog({ title: `Sign out of ${source.name}?`, description, confirmLabel: "Sign out", danger: true });
    if (!ok) return;
    act("sign-out", () => api("POST", `/api/integrations/${id}/sign-out`));
  };

  const credentialCard = () => {
    if (source.auth.type === "oauth2") {
      const auth = source.auth;
      const browser = auth.grant === "authorization_code";
      const ok = source.credential.configured;
      let host = auth.tokenUrl;
      try { host = new URL(auth.authorizeUrl || auth.tokenUrl).host; } catch { /* show it as is */ }
      return h("div", { class: "card" }, h("h2", {}, "OAuth2"),
        h("p", { class: "sub" }, browser
          ? ok ? `Signed in through ${host}. Tokens refresh automatically and are stored only on this machine.`
            : `Sign in through ${host} to let mcpmaster call it for your agents.`
          : `Client credentials${auth.clientSecretEnv ? `, secret read from $${auth.clientSecretEnv}` : ""}. mcpmaster fetches and renews tokens itself.`),
        h("dl", { class: "kv" },
          h("dt", {}, "Client ID"), auth.clientId ? h("dd", { class: "mono" }, auth.clientId) : h("dd", { class: "muted" }, "Registered by mcpmaster"),
          h("dt", {}, "Token URL"), h("dd", { class: "mono" }, auth.tokenUrl),
          auth.scope ? [h("dt", {}, "Scopes"), h("dd", { class: "mono" }, auth.scope)] : null,
          browser ? null : [h("dt", {}, "Client secret"), h("dd", {}, ok
            ? h("span", { class: "badge ok" }, h("span", { class: "dot" }), "Set")
            : h("span", { class: "badge fail" }, h("span", { class: "dot" }), auth.clientSecretEnv ? `$${auth.clientSecretEnv} isn't set` : "Missing"))]),
        h("div", { class: "toolbar" },
          h("button", { class: `btn btn-sm ${browser && !ok ? "btn-primary" : ""}`, onclick: (e) => signIn(e.currentTarget) },
            browser ? (ok ? "Sign in again" : "Sign in") : "Get a new token"),
          browser && ok ? h("button", { class: "btn btn-sm btn-ghost", onclick: signOutAction }, "Sign out") : null,
          h("button", { class: "btn btn-sm btn-ghost", onclick: () => credentialDialog(source) }, "Edit settings")));
    }
    if (source.auth.type === "oauth") {
      const signedIn = source.credential.configured;
      return h("div", { class: "card" }, h("h2", {}, "Sign-in"),
        h("p", { class: "sub" }, signedIn
          ? "Signed in with the server's own OAuth. Tokens refresh automatically and are stored only on this machine."
          : "This server uses OAuth. Sign in to let mcpmaster call it for your agents."),
        h("div", { class: "toolbar" },
          h("button", { class: `btn btn-sm ${signedIn ? "" : "btn-primary"}`, onclick: (e) => signIn(e.currentTarget) }, signedIn ? "Sign in again" : "Sign in"),
          signedIn ? h("button", { class: "btn btn-sm btn-ghost", onclick: signOutAction }, "Sign out") : null),
        h("p", { class: "hint" }, "Signing in again always starts fresh: a new client is registered and old tokens are discarded."));
    }
    if (source.type === "stdio") {
      return h("div", { class: "card" }, h("h2", {}, "Environment"),
        h("p", { class: "sub" }, "Variables passed to the process. Values are stored locally and never shown."),
        source.credential.envKeys.length
          ? h("div", { class: "chips" }, source.credential.envKeys.map((k) => h("span", { class: "badge type" }, k)))
          : h("p", { class: "hint" }, "None set."),
        h("div", {}, h("button", { class: "btn btn-sm", onclick: () => envDialog(source) }, "Replace variables")));
    }
    const auth = source.auth;
    return h("div", { class: "card" },
      h("h2", {}, "Credential"),
      h("p", { class: "sub" }, auth.type === "none" ? "No authentication." :
        `${auth.type === "bearer" ? "Bearer token" : `API key in ${auth.header || "X-API-Key"}`}, ${auth.env ? `read from $${auth.env}` : "stored locally"}.`),
      auth.type === "none" ? null : h("p", {}, source.credential.configured
        ? h("span", { class: "badge ok" }, h("span", { class: "dot" }), "Set")
        : h("span", { class: "badge fail" }, h("span", { class: "dot" }), auth.env ? `$${auth.env} isn't set` : "Missing")),
      h("button", { class: "btn btn-sm", onclick: () => credentialDialog(source) }, auth.type === "none" ? "Add a credential" : "Replace credential"));
  };

  const syncBtn = h("button", { class: "btn", onclick: (e) => sync(e.currentTarget) }, icon("refresh"), "Sync");

  // Counts that change when a single tool is switched: repainted in place.
  const exposedEl = h("dd", {});
  const accessSummaryEl = h("p", { class: "sub" });
  const paintCounts = () => {
    const s = current();
    exposedEl.textContent = `${s.exposedCount.toLocaleString()} exposed of ${s.toolCount.toLocaleString()}`;
    const parts = [[s.access.read, "read"], [s.access.write, "write"], [s.access.unknown, "unmarked"]].filter(([n]) => n).map(([n, l]) => `${n.toLocaleString()} ${l}`);
    accessSummaryEl.textContent = `${s.exposedCount.toLocaleString()} of ${plural(s.toolCount, "tool")} are exposed.${parts.length ? ` ${parts.join(", ")}.` : ""}`;
  };
  paintCounts();
  chromeWatchers.push(paintCounts);

  return h("div", {},
    h("a", { href: "#/integrations", class: "btn btn-ghost btn-sm" }, icon("back"), "Integrations"),
    h("div", { class: "page-head" },
      h("div", {},
        h("h1", {}, source.name, " ", statusBadge(source)),
        h("p", { class: "mono" }, target(source))),
      h("div", { class: "toolbar" },
        syncBtn,
        h("button", { class: "btn", onclick: () => act("toggle", () => api("PATCH", `/api/integrations/${id}`, { enabled: !source.enabled })) }, source.enabled ? "Disable" : "Enable"),
        h("button", { class: "btn btn-ghost", onclick: remove, "aria-label": `Remove ${source.name}` }, icon("trash"), "Remove"))),
    source.error && source.status === "failed" ? h("div", { class: "card" }, h("h2", {}, "Last sync failed"), h("p", { class: "sub" }, source.error),
      h("button", { class: "btn btn-sm btn-primary", onclick: (e) => sync(e.currentTarget) }, icon("refresh"), "Try again")) : null,
    h("div", { class: "card" },
      h("dl", { class: "kv" },
        h("dt", {}, "Type"), h("dd", {}, TYPE_LABEL[source.type]),
        h("dt", {}, "Tools"), exposedEl,
        h("dt", {}, "Tool prefix"), h("dd", { class: "mono" }, `${source.name}_`),
        h("dt", {}, "Last synced"), h("dd", {}, source.syncedAt ? new Date(source.syncedAt).toLocaleString() : "never"))),
    credentialCard(),
    accessCard(),
    toolsSection());

  function accessCard() {
    const toggle = (label, text, checked, key) => h("div", { class: "setting" },
      h("div", {}, h("b", {}, label), h("p", {}, text)),
      h("label", { class: "switch" },
        h("input", { type: "checkbox", checked, "aria-label": label,
          onchange: (e) => act(key, () => api("PATCH", `/api/integrations/${id}`, { [key]: e.target.checked })) }),
        h("span", {})));
    const pending = source.pendingReview || [];
    return h("div", { class: "card" },
      h("h2", {}, "Access"),
      accessSummaryEl,
      toggle("Read-only", source.type === "openapi" ? "Only GET operations." : source.type === "graphql" ? "Only queries, no mutations." : "Only tools the server marks read-only; unmarked tools are hidden too.", source.readOnly, "readOnly"),
      toggle("Hide new tools until reviewed", "Tools that first appear in a later sync stay hidden until you switch them on.", source.hideNewTools, "hideNewTools"),
      pending.length ? h("div", { class: "review" },
        h("span", { class: "badge warn" }, `${pending.length} new tool${pending.length === 1 ? "" : "s"} waiting`),
        h("span", { class: "hint" }, pending.length > 12 ? `${pending.slice(0, 12).join(", ")} and ${pending.length - 12} more` : pending.join(", ")),
        h("button", { class: "btn btn-sm btn-primary", onclick: () => act("approve", () => api("POST", `/api/integrations/${id}/approve`, {})) }, "Expose all")) : null);
  }

  // This integration's tools, a page at a time, searchable on the server.
  function toolsSection() {
    if (source.toolCount === 0) {
      return [h("div", { class: "section-title" }, h("h3", {}, "Tools")),
        h("div", { class: "list" }, h("div", { class: "empty" }, h("b", {}, "No tools yet"), "Sync this integration to read its tools."))];
    }
    const feed = createFeed({ integration: id, q: params.get("q") || "" }, page);
    const listEl = h("div", { class: "list" });
    const footEl = h("div", { class: "list-foot" });
    const search = h("input", { type: "search", "aria-label": `Search ${source.name} tools`, placeholder: `Search ${plural(source.toolCount, "tool")}…`, value: feed.query.q });
    const onChange = () => refreshChrome();
    const paint = () => {
      listEl.replaceChildren(...(feed.items.length ? feed.items.map((tool) => switchRow(tool, onChange))
        : [h("div", { class: "empty" }, h("b", {}, "Nothing matches"), "Try fewer words.")]));
      footEl.replaceChildren(...[feed.footer()].flat());
    };
    feed.onPaint = paint;
    search.addEventListener("input", debounce(() => {
      feed.query.q = search.value.trim();
      setParams({ q: feed.query.q });
      feed.reload();
    }, 200));
    paint();
    return [
      h("div", { class: "section-title" }, h("h3", {}, "Tools"),
        h("a", { href: `#/tools?integration=${encodeURIComponent(source.name)}` }, "Open in tool browser")),
      h("div", { class: "toolbar" }, search),
      h("div", { class: "feed" }, listEl, footEl),
    ];
  }
}

/**
 * A server-side paged list: the current query, the rows loaded so far, and
 * "load more". Responses that arrive after the query changed are dropped.
 */
function createFeed(query, page) {
  const feed = {
    query: { ...query },
    items: page.items,
    total: page.total,
    counts: page.counts,
    integrations: page.integrations,
    loading: false,
    seq: 0,
    onPaint: () => {},
    onLoaded: () => {},
    async reload(keep) {
      const seq = ++feed.seq;
      const limit = keep ? Math.min(200, Math.max(PAGE_SIZE, feed.items.length)) : PAGE_SIZE;
      feed.loading = true;
      feed.onPaint();
      try {
        const next = await fetchTools(feed.query, 0, limit);
        if (seq !== feed.seq) return;
        Object.assign(feed, { items: next.items, total: next.total, counts: next.counts, integrations: next.integrations });
        announce(next.total ? `${plural(next.total, "tool")} match` : "No tools match");
        feed.onLoaded(false);
      } catch (e) {
        if (seq === feed.seq) toast(e.message, "fail");
      } finally {
        if (seq === feed.seq) { feed.loading = false; feed.onPaint(); }
      }
    },
    async more() {
      const seq = feed.seq;
      feed.loading = true;
      feed.onPaint();
      try {
        const next = await fetchTools(feed.query, feed.items.length);
        if (seq !== feed.seq) return;
        const seen = new Set(feed.items.map((t) => t.name));
        feed.items = feed.items.concat(next.items.filter((t) => !seen.has(t.name)));
        feed.total = next.total;
        announce(`Showing ${feed.items.length.toLocaleString()} of ${plural(feed.total, "tool")}`);
        feed.onLoaded(true);
      } catch (e) {
        toast(e.message, "fail");
      } finally {
        if (seq === feed.seq) { feed.loading = false; feed.onPaint(); }
      }
    },
    // "Showing 50 of 1,612" plus the load-more button, which keeps focus
    // on the first new row for keyboard users.
    footer() {
      const shown = feed.items.length;
      const status = h("span", { class: "hint" }, feed.total ? `Showing ${shown.toLocaleString()} of ${plural(feed.total, "tool")}` : "");
      if (shown >= feed.total) return status;
      const btn = h("button", { class: "btn btn-sm", type: "button", disabled: feed.loading },
        feed.loading ? [h("span", { class: "spinner" }), "Loading…"] : `Show ${Math.min(PAGE_SIZE, feed.total - shown)} more`);
      btn.addEventListener("click", async () => {
        const first = shown;
        await feed.more();
        const rows = document.querySelectorAll(".feed [data-tool]");
        const target = rows[first] && rows[first].querySelector("input, button");
        if (target) target.focus();
      });
      return [status, btn];
    },
  };
  return feed;
}

let watchTimer = null;

// While a sign-in is in progress in another tab, poll until it settles.
function watchUntilSettled(id) {
  clearInterval(watchTimer);
  const started = Date.now();
  watchTimer = setInterval(async () => {
    if (Date.now() - started > 5 * 60_000) { clearInterval(watchTimer); return; }
    try {
      await refresh();
      const current = store.state.integrations.find((s) => s.id === id);
      if (!current || current.status !== "needs_auth") {
        clearInterval(watchTimer);
        if (current && current.status === "ready") toast(`Connected ${current.name} · ${current.toolCount} tools`);
        if (!document.querySelector(".overlay")) render({ soft: true });
      }
    } catch { clearInterval(watchTimer); }
  }, 2000);
}

function credentialDialog(source) {
  openDialog((close) => {
    const form = { type: source.auth.type === "none" ? "bearer" : source.auth.type, header: source.auth.header || "", useEnv: Boolean(source.auth.env), env: source.auth.env || "", token: "", oauth2: oauth2Form(source.auth) };
    const hadOAuth2 = source.auth.type === "oauth2";
    const errorEl = h("div", { class: "field-error", role: "alert" });
    const body = h("div");
    const paint = () => fill(body,
      h("div", { class: "field" }, h("label", {}, "Send it as"),
        segmentedControl([["none", "None"], ["bearer", "Bearer token"], ["api_key", "API key"], ["oauth2", "OAuth2"]], form.type, (v) => { form.type = v; paint(); })),
      form.type === "oauth2" ? oauth2Fields(form.oauth2, paint, hadOAuth2, source.url || "") : null,
      form.type === "api_key" ? h("div", { class: "field" }, h("label", { for: "c-header" }, "Header"),
        h("input", { type: "text", id: "c-header", value: form.header, placeholder: "X-API-Key", oninput: (e) => { form.header = e.target.value; } })) : null,
      form.type === "none" || form.type === "oauth2" ? null : h("div", { class: "field" },
        h("label", { for: "c-secret" }, form.useEnv ? "Environment variable" : "New value"),
        form.useEnv
          ? h("input", { type: "text", id: "c-secret", value: form.env, placeholder: "API_TOKEN", oninput: (e) => { form.env = e.target.value; } })
          : h("input", { type: "password", id: "c-secret", autocomplete: "off", oninput: (e) => { form.token = e.target.value; } }),
        h("div", { class: "hint" }, h("a", { href: "#", onclick: (e) => { e.preventDefault(); form.useEnv = !form.useEnv; paint(); } }, form.useEnv ? "Store a value instead" : "Use an environment variable instead"))));
    const save = h("button", { class: "btn btn-primary", type: "submit" }, "Save and sync");
    paint();
    return h("form", { novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      errorEl.textContent = "";
      let payload = { auth: { type: form.type, header: form.header.trim() || undefined, env: form.useEnv ? form.env.trim() : undefined } };
      if (form.type === "oauth2") {
        const oauth2 = oauth2Payload(form.oauth2, hadOAuth2);
        if (oauth2.error) { errorEl.textContent = oauth2.error; return; }
        payload = { auth: oauth2.auth, ...(oauth2.clientSecret ? { clientSecret: oauth2.clientSecret } : {}) };
      } else if (form.type !== "none" && !form.useEnv) {
        if (!form.token) { errorEl.textContent = "Enter the new value."; return; }
        payload.token = form.token;
      }
      if (form.type === "none") payload.token = "";
      save.disabled = true;
      try {
        const { integration } = await api("PATCH", `/api/integrations/${source.id}`, payload);
        close();
        toast(integration.status === "ready" ? "Credential saved" : integration.error, integration.status === "ready" ? "ok" : integration.status === "needs_auth" ? "warn" : "fail");
        await render({ soft: true });
      } catch (err) { errorEl.textContent = err.message; save.disabled = false; }
    } },
      h("h2", {}, `Credential for ${source.name}`),
      h("p", { class: "desc" }, "The current value is never shown. Saving replaces it and re-syncs the integration."),
      body, errorEl,
      h("div", { class: "dialog-actions" }, h("button", { type: "button", class: "btn", onclick: close }, "Cancel"), save));
  });
}

function envDialog(source) {
  openDialog((close) => {
    const rows = source.credential.envKeys.map((key) => ({ key, value: "" }));
    if (rows.length === 0) rows.push({ key: "", value: "" });
    const list = h("div");
    const errorEl = h("div", { class: "field-error", role: "alert" });
    const paint = () => list.replaceChildren(rows.map((pair, i) => h("div", { class: "env-row" },
      h("input", { type: "text", value: pair.key, placeholder: "NAME", "aria-label": "Variable name", oninput: (e) => { pair.key = e.target.value; } }),
      h("input", { type: "password", value: pair.value, placeholder: "value", "aria-label": "Variable value", autocomplete: "off", oninput: (e) => { pair.value = e.target.value; } }),
      h("button", { type: "button", class: "btn btn-sm btn-ghost", "aria-label": "Remove variable", onclick: () => { rows.splice(i, 1); paint(); } }, icon("trash")))),
      h("button", { type: "button", class: "btn btn-sm", onclick: () => { rows.push({ key: "", value: "" }); paint(); } }, icon("plus"), "Add variable"));
    paint();
    return h("form", { novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      const env = {};
      for (const { key, value } of rows) if (key.trim()) env[key.trim()] = value;
      try {
        await api("PATCH", `/api/integrations/${source.id}`, { env });
        close();
        toast("Environment saved");
        await render({ soft: true });
      } catch (err) { errorEl.textContent = err.message; }
    } },
      h("h2", {}, `Environment for ${source.name}`),
      h("p", { class: "desc" }, "This replaces every variable. Existing values aren't shown — re-enter the ones you keep."),
      list, errorEl,
      h("div", { class: "dialog-actions" }, h("button", { type: "button", class: "btn", onclick: close }, "Cancel"), h("button", { class: "btn btn-primary", type: "submit" }, "Save and restart")));
  });
}

function skeletonArgs(schema) {
  const out = {};
  for (const [key, prop] of Object.entries((schema && schema.properties) || {})) {
    if (!(schema.required || []).includes(key)) continue;
    const type = prop && prop.type;
    out[key] = type === "integer" || type === "number" ? 0 : type === "boolean" ? false : type === "array" ? [] : type === "object" ? {} : "";
  }
  return JSON.stringify(out, null, 2);
}

function detailSkeleton() {
  return h("div", { class: "card detail sk-stack", "aria-busy": "true" }, sk("w60"), sk("w30 thin"), sk("w80 thin"), sk("w70 thin"), sk("block"));
}

function toolDetail(tool, onChange) {
  if (!tool) return h("div", { class: "card detail" }, h("div", { class: "empty" }, h("b", {}, "Pick a tool"), "See its parameters and try it right here."));
  const props = Object.entries((tool.inputSchema && tool.inputSchema.properties) || {});
  const required = new Set((tool.inputSchema && tool.inputSchema.required) || []);
  const argsEl = h("textarea", { "aria-label": "Arguments (JSON)", spellcheck: "false", value: skeletonArgs(tool.inputSchema) });
  const resultEl = h("div");
  const run = h("button", { class: "btn btn-primary", type: "button" }, icon("play"), "Run");
  run.addEventListener("click", async () => {
    let args;
    try { args = JSON.parse(argsEl.value || "{}"); } catch { resultEl.replaceChildren(h("div", { class: "field-error" }, "Arguments must be valid JSON.")); return; }
    run.disabled = true;
    run.replaceChildren(h("span", { class: "spinner" }), "Running…");
    try {
      const outcome = await api("POST", "/api/tools/call", { name: tool.name, arguments: args });
      let text = outcome.ok ? outcome.text : outcome.error;
      try { if (outcome.ok) text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* not JSON */ }
      resultEl.replaceChildren(
        h("div", { class: "hint" }, outcome.ok ? `Returned in ${outcome.ms} ms` : `Failed after ${outcome.ms} ms`),
        h("div", { class: `code result${outcome.ok ? "" : " error"}` }, text || "(empty response)"));
    } catch (e) {
      resultEl.replaceChildren(h("div", { class: "field-error" }, e.message));
    }
    run.disabled = false;
    run.replaceChildren(icon("play"), "Run");
  });

  return h("div", { class: "card detail" },
    h("h2", {}, tool.name),
    h("p", { class: "sub" }, h("span", { class: "badge type" }, TYPE_LABEL[tool.type]), " ",
      tool.method ? h("span", { class: "badge type" }, `${tool.method} ${tool.path}`) : null,
      tool.operation ? h("span", { class: "badge type" }, tool.operation) : null,
      accessBadge(tool), " ", blockBadge(tool)),
    tool.description ? h("p", {}, tool.description) : null,
    h("div", { class: "setting exposure" },
      h("div", {}, h("b", {}, tool.enabled ? "Exposed to agents" : "Hidden from agents"),
        h("p", {}, tool.blockedBy
          ? tool.blockedBy.kind === "tool" ? "You blocked this tool." : `Hidden by ${tool.blockedBy.label}. Switch it on to allow it anyway.`
          : tool.allowedOverride ? "Allowed explicitly, over a rule that would hide it." : "Agents can find and call it.")),
      h("label", { class: "switch" },
        h("input", { type: "checkbox", checked: tool.enabled, "aria-label": `Expose ${tool.name} to agents`, onchange: async (e) => {
          const input = e.target;
          input.disabled = true;
          try {
            const { tool: updated } = await api("PATCH", "/api/tools", { name: tool.name, enabled: input.checked });
            onChange(updated);
          } catch (err) {
            input.checked = !input.checked;
            input.disabled = false;
            toast(err.message, "fail");
          }
        } }),
        h("span", {}))),
    h("h3", {}, "Parameters"),
    props.length === 0 ? h("p", { class: "hint" }, "None.") :
      h("table", { class: "params" }, h("tbody", {}, props.map(([name, prop]) => h("tr", {},
        h("td", {}, name, required.has(name) ? h("span", { class: "req" }, "required") : null),
        h("td", {}, h("div", { class: "t" }, (prop && (prop.type || (prop.enum ? "enum" : ""))) || "any"), prop && prop.description ? prop.description : null))))),
    h("label", {}, "Try it"),
    argsEl,
    h("div", { class: "dialog-actions" }, run),
    resultEl);
}

const SNIPPET_EXAMPLE = `// Find tools (an empty query lists them), then call one: await tools[path](input)
const { total, items } = await tools.search({ query: "", limit: 5 });
return { total, first: items.map((t) => t.path) };`;

// The same `execute` an agent calls, runnable from the browser — the fastest
// way to see what code mode hands back.
function snippetCard() {
  const code = h("textarea", { "aria-label": "Snippet", spellcheck: "false", value: store.snippet ?? SNIPPET_EXAMPLE });
  code.addEventListener("input", () => { store.snippet = code.value; });
  const output = h("div");
  const run = h("button", { class: "btn btn-primary btn-sm", type: "button" }, icon("play"), "Run");
  run.addEventListener("click", async () => {
    run.disabled = true;
    run.replaceChildren(h("span", { class: "spinner" }), "Running…");
    try {
      const r = await api("POST", "/api/execute", { code: code.value });
      output.replaceChildren(h("div", { class: "hint" }, r.ok ? `Returned in ${r.ms} ms` : `Failed after ${r.ms} ms`),
        h("div", { class: `code result${r.ok ? "" : " error"}` }, r.ok ? r.text : r.error));
    } catch (e) {
      output.replaceChildren(h("div", { class: "field-error" }, e.message));
    }
    run.disabled = false;
    run.replaceChildren(icon("play"), "Run");
  });
  return h("details", { class: "card snippet" },
    h("summary", {}, h("b", {}, "Run a snippet like an agent"), h("span", { class: "hint" }, " — tools.search, tools.describe.tool, tools[path](input)")),
    h("p", { class: "sub" }, "Agents get one execute tool and write code like this. It runs in a sandbox with no network or files — only your tools."),
    code, h("div", { class: "dialog-actions" }, run), output);
}

// Block rules: glob patterns on tool names that hide matching tools now AND
// any that appear in a later sync. The server previews what a rule would
// hide before it's saved.
function rulesCard() {
  const rules = store.state.blockRules;
  const HINT = "Use * for any run of characters and ? for one. Rules also hide tools added by future syncs.";
  const input = h("input", { type: "text", "aria-label": "New block rule", spellcheck: "false", autocomplete: "off", placeholder: "github_delete_*" });
  const preview = h("div", { class: "hint" }, HINT);
  const errorEl = h("div", { class: "field-error", role: "alert" });
  let previewSeq = 0;
  const updatePreview = debounce(async () => {
    const rule = input.value.trim();
    const seq = ++previewSeq;
    if (!rule) { preview.textContent = HINT; return; }
    try {
      const { valid, matches } = await api("GET", `/api/rules/preview?rule=${encodeURIComponent(rule)}`);
      if (seq !== previewSeq) return;
      preview.textContent = !valid ? "Letters, digits, _ and - only, plus * and ?."
        : `Matches ${plural(matches, "tool")} right now${rule === "*" ? " — every tool" : ""}, plus any that match later.`;
    } catch { /* keep the last preview */ }
  }, 200);
  input.addEventListener("input", () => { errorEl.textContent = ""; updatePreview(); });
  const add = async (e) => {
    e.preventDefault();
    const rule = input.value.trim();
    if (!rule) return;
    try {
      const { matches } = await api("POST", "/api/rules", { rule });
      toast(`Rule ${rule} hides ${plural(matches, "tool")}`);
      await render({ soft: true });
    } catch (err) { errorEl.textContent = err.message; }
  };
  const remove = async (rule) => {
    try { await api("DELETE", "/api/rules", { rule }); await render({ soft: true }); toast(`Removed rule ${rule}`); }
    catch (err) { toast(err.message, "fail"); }
  };
  return h("div", { class: "card rules" },
    h("h2", {}, "Block rules"),
    h("p", { class: "sub" }, "Hide tools by name pattern. You can still allow a single matching tool by switching it on."),
    rules.length ? h("div", { class: "rule-list" }, rules.map(({ rule, matches }) =>
      h("div", { class: "rule" }, h("code", {}, rule), h("span", { class: "hint" }, `${matches.toLocaleString()} hidden`),
        h("button", { class: "btn btn-sm btn-ghost", type: "button", "aria-label": `Remove rule ${rule}`, onclick: () => remove(rule) }, icon("trash"))))) : null,
    h("form", { class: "rule-form", onsubmit: add }, input, h("button", { class: "btn btn-sm", type: "submit" }, icon("plus"), "Add rule")),
    preview, errorEl);
}

function toolFilters(params) {
  return { q: params.get("q") || "", integration: params.get("integration") || "", status: params.get("status") || "", access: params.get("access") || "" };
}

const toolsSpec = {
  skeleton: "tools",
  // The first page and (when the URL names one) the open tool's detail load
  // together, so the page paints once, complete.
  load: async (params) => {
    const name = params.get("tool");
    const [page, detail] = await Promise.all([
      fetchTools(toolFilters(params), 0),
      name ? fetchTool(name).catch(() => null) : null,
    ]);
    return { page, detail };
  },
  view: toolsPage,
};

function toolsPage({ page, detail }, params) {
  const s = store.state;
  if (s.toolCount === 0) {
    return h("div", {}, h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "Tools"), h("p", {}, "Every tool your agents can call."))),
      h("div", { class: "card empty" }, h("b", {}, "No tools yet"), h("p", {}, "Connect an integration and its tools show up here."),
        h("button", { class: "btn btn-primary", onclick: () => addDialog() }, icon("plus"), "Add integration")));
  }
  const feed = createFeed(toolFilters(params), page);
  let current = detail ? detail.name : null;
  // Selection for bulk actions: explicit names, or "every tool matching".
  const selection = { names: new Set(), all: false };
  const selectedCount = () => (selection.all ? feed.total : selection.names.size);
  const clearSelection = () => { selection.names.clear(); selection.all = false; };

  const listEl = h("div", { class: "list tool-list" });
  const footEl = h("div", { class: "list-foot" });
  const bulkEl = h("div", { class: "bulkbar" });
  const detailEl = h("div");
  const headEl = h("p", {});

  const syncUrl = () => setParams({ ...feed.query, tool: current });

  const paintHead = () => {
    const st = store.state;
    headEl.textContent = st.toolMode === "execute"
      ? `${st.enabledToolCount.toLocaleString()} of ${plural(st.toolCount, "tool")} are available to agents through one execute tool. Browse, inspect and run them here.`
      : `${st.enabledToolCount.toLocaleString()} of ${plural(st.toolCount, "tool")} are listed to agents individually. Browse, inspect and run them here.`;
  };
  paintHead();
  chromeWatchers.push(paintHead);

  // --- filters -------------------------------------------------------------
  const search = h("input", { type: "search", "aria-label": "Search tools", placeholder: "Search tools by name or what they do…", value: feed.query.q });
  const integrationSelect = h("select", { "aria-label": "Filter by integration" });
  const accessSelect = h("select", { "aria-label": "Filter by access" },
    [["", "Any access"], ["read", "Reads"], ["write", "Writes"], ["unknown", "Unmarked"]].map(([v, l]) => h("option", { value: v }, l)));
  accessSelect.value = feed.query.access;
  const statusGroup = h("div", { class: "segmented", role: "group", "aria-label": "Filter by exposure" });

  const paintFilters = () => {
    const known = feed.integrations.some((i) => i.name === feed.query.integration || i.id === feed.query.integration);
    integrationSelect.replaceChildren();
    append(integrationSelect, [
      h("option", { value: "" }, "All integrations"),
      feed.integrations.map((i) => h("option", { value: i.name }, `${i.name} · ${i.count.toLocaleString()}`)),
      feed.query.integration && !known ? h("option", { value: feed.query.integration }, feed.query.integration) : null]);
    integrationSelect.value = feed.query.integration;
    statusGroup.replaceChildren(...[["", "All", feed.counts.all], ["exposed", "Exposed", feed.counts.exposed], ["hidden", "Hidden", feed.counts.hidden]]
      .map(([value, label, n]) => h("button", { type: "button", "aria-pressed": String(feed.query.status === value),
        onclick: () => setFilter("status", value) }, `${label} `, h("span", { class: "n" }, n.toLocaleString()))));
  };

  const setFilter = (key, value) => {
    if (feed.query[key] === value) return;
    feed.query[key] = value;
    clearSelection();
    syncUrl();
    feed.reload();
  };
  search.addEventListener("input", debounce(() => setFilter("q", search.value.trim()), 200));
  integrationSelect.addEventListener("change", () => setFilter("integration", integrationSelect.value));
  accessSelect.addEventListener("change", () => setFilter("access", accessSelect.value));

  // --- rows ----------------------------------------------------------------
  const row = (tool) => {
    const checked = selection.all || selection.names.has(tool.name);
    const box = h("input", { type: "checkbox", checked, "aria-label": `Select ${tool.name}` });
    box.addEventListener("change", () => {
      if (selection.all) { selection.all = false; for (const t of feed.items) selection.names.add(t.name); }
      if (box.checked) selection.names.add(tool.name); else selection.names.delete(tool.name);
      paintBulk();
    });
    return h("div", { class: `tool-row${tool.enabled ? "" : " off"}${current === tool.name ? " current" : ""}`, "data-tool": tool.name },
      h("label", { class: "check" }, box),
      h("button", { class: "tool-pick", type: "button", "aria-current": current === tool.name ? "true" : undefined, onclick: () => select(tool.name) },
        h("div", { class: "n" }, tool.name),
        tool.blockedBy ? h("div", { class: "d" }, `Hidden · ${tool.blockedBy.label}`) : tool.description ? h("div", { class: "d" }, tool.description) : null));
  };

  const paintList = () => {
    listEl.toggleAttribute("aria-busy", feed.loading);
    if (feed.items.length === 0) {
      listEl.replaceChildren(h("div", { class: "empty" }, h("b", {}, "Nothing matches"), "Try fewer words or clear a filter."));
    } else {
      // Grouped by integration, except for search results, which are ranked.
      const counts = new Map(feed.integrations.map((i) => [i.id, i.count]));
      const nodes = [];
      let group = null;
      for (const tool of feed.items) {
        if (!feed.query.q && tool.integrationId !== group) {
          group = tool.integrationId;
          nodes.push(h("div", { class: "tool-group" }, `${tool.integration} · ${(counts.get(group) ?? 0).toLocaleString()}`));
        }
        nodes.push(row(tool));
      }
      listEl.replaceChildren(...nodes);
    }
    footEl.replaceChildren(...[feed.footer()].flat());
  };

  const paintBulk = () => {
    const n = selectedCount();
    const all = h("input", { type: "checkbox", checked: selection.all, "aria-label": `Select all ${feed.total} matching tools` });
    all.indeterminate = !selection.all && n > 0;
    bulkEl.replaceChildren();
    all.addEventListener("change", () => {
      clearSelection();
      selection.all = all.checked;
      paintList();
      paintBulk();
    });
    append(bulkEl, [
      h("label", { class: "check" }, all, n ? `${n.toLocaleString()} selected` : `Select all ${feed.total.toLocaleString()} matching`),
      n ? h("div", { class: "bulk-actions" },
        h("button", { class: "btn btn-sm", type: "button", onclick: () => bulk(false) }, "Hide from agents"),
        h("button", { class: "btn btn-sm", type: "button", onclick: () => bulk(true) }, "Expose"),
        h("button", { class: "btn btn-sm btn-ghost", type: "button", onclick: () => { clearSelection(); paintList(); paintBulk(); } }, "Clear")) : null]);
  };

  feed.onPaint = () => { paintList(); };
  feed.onLoaded = (appended) => { if (!appended) paintFilters(); paintBulk(); };

  const bulk = async (enabled) => {
    const n = selectedCount();
    if (selection.all && n > 1) {
      const ok = await confirmDialog({
        title: `${enabled ? "Expose" : "Hide"} ${plural(n, "tool")}?`,
        description: enabled
          ? "Every tool matching this filter becomes available to agents, including tools a rule, read-only or review would hide."
          : "Agents lose every tool matching this filter, including ones not loaded on this page. You can switch any of them back on.",
        confirmLabel: enabled ? "Expose" : "Hide", danger: enabled,
      });
      if (!ok) return;
    }
    try {
      const body = selection.all ? { enabled, filter: feed.query } : { enabled, names: [...selection.names] };
      const { changed } = await api("POST", "/api/tools/bulk", body);
      toast(`${enabled ? "Exposed" : "Hid"} ${plural(changed, "tool")}`);
      clearSelection();
      await feed.reload(true);
      refreshChrome();
      if (current) select(current, true);
    } catch (e) { toast(e.message, "fail"); }
  };

  // --- detail ----------------------------------------------------------------
  let detailSeq = 0;
  const onToolChanged = (tool) => {
    const i = feed.items.findIndex((t) => t.name === tool.name);
    if (i !== -1) {
      const was = feed.items[i].enabled;
      feed.items[i] = { ...feed.items[i], ...tool };
      if (was !== tool.enabled) {
        feed.counts.exposed += tool.enabled ? 1 : -1;
        feed.counts.hidden += tool.enabled ? -1 : 1;
        paintFilters();
      }
      const el = listEl.querySelector(`[data-tool="${CSS.escape(tool.name)}"]`);
      if (el) el.replaceWith(row(feed.items[i]));
    }
    paintDetail(tool);
    detailEl.querySelector(".switch input")?.focus();
    refreshChrome();
  };
  const paintDetail = (tool) => detailEl.replaceChildren(toolDetail(tool, onToolChanged));

  const select = async (name, quiet) => {
    current = name;
    syncUrl();
    for (const el of listEl.querySelectorAll(".tool-row")) {
      const on = el.dataset.tool === name;
      el.classList.toggle("current", on);
      const btn = el.querySelector(".tool-pick");
      if (on) btn.setAttribute("aria-current", "true"); else btn.removeAttribute("aria-current");
    }
    const seq = ++detailSeq;
    if (!quiet) detailEl.replaceChildren(detailSkeleton());
    try {
      const tool = await fetchTool(name);
      if (seq === detailSeq) paintDetail(tool);
    } catch (e) {
      if (seq === detailSeq) detailEl.replaceChildren(h("div", { class: "card detail" }, h("div", { class: "empty" }, h("b", {}, "Couldn't open that tool"), e.message)));
    }
  };

  paintFilters();
  paintList();
  paintBulk();
  paintDetail(detail);

  const codeMode = s.toolMode === "execute";
  return h("div", {},
    h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "Tools"), headEl)),
    codeMode ? snippetCard() : null,
    rulesCard(),
    h("div", { class: "toolbar" }, search, integrationSelect, accessSelect, statusGroup),
    h("div", { class: "tools-layout" }, h("div", { class: "feed" }, bulkEl, listEl, footEl), detailEl));
}

function connectPage() {
  const { mcpUrl } = store.state;
  const launch = { command: "npx", args: ["-y", "mcpmaster@latest", "mcp"] };
  const line = [launch.command, ...launch.args].join(" ");
  const json = (key, extra) => JSON.stringify({ [key]: { mcpmaster: { ...extra, ...launch } } }, null, 2);
  const httpLine = (t) => `claude mcp add --transport http mcpmaster ${mcpUrl} --header "Authorization: Bearer ${t}"`;
  const clients = [
    ["Claude Code", () => [h("p", { class: "sub" }, "Run this in your terminal:"), codeBlock(`claude mcp add mcpmaster -- ${line}`)]],
    ["Codex", () => [h("p", { class: "sub" }, "Run this in your terminal:"), codeBlock(`codex mcp add mcpmaster -- ${line}`)]],
    ["Cursor", () => [h("p", { class: "sub" }, "Add to ~/.cursor/mcp.json:"), codeBlock(json("mcpServers", {}))]],
    ["Claude Desktop", () => [h("p", { class: "sub" }, "Settings → Developer → Edit config, then add:"), codeBlock(json("mcpServers", {}))]],
    ["VS Code", () => [h("p", { class: "sub" }, "Add to .vscode/mcp.json:"), codeBlock(json("servers", { type: "stdio" }))]],
    ["Any client · HTTP", () => [
      h("p", { class: "sub" }, "While mcpmaster is running, any Streamable HTTP client can connect with your local token:"),
      codeBlock(httpLine(token), httpLine("•".repeat(12))),
      h("dl", { class: "kv" }, h("dt", {}, "URL"), h("dd", { class: "mono" }, mcpUrl), h("dt", {}, "Header"), h("dd", { class: "mono" }, "Authorization: Bearer <mcpmaster token>"))]],
  ];
  let active = 0;
  const panel = h("div");
  const tabs = h("div", { class: "tabs", role: "tablist" });
  const paint = () => {
    tabs.replaceChildren(...clients.map(([name], i) => h("button", { role: "tab", type: "button", "aria-selected": String(i === active), onclick: () => { active = i; paint(); } }, name)));
    panel.replaceChildren(...clients[active][1]());
  };
  paint();
  return h("div", {},
    h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "Connect an agent"),
      h("p", {}, store.state.toolMode === "execute"
        ? "One entry gives an agent every integration you connect here, through a single execute tool that keeps its context small. New integrations show up without reconnecting."
        : "One entry gives an agent every integration you connect here. New integrations show up without reconnecting."))),
    h("div", { class: "card" }, tabs, panel),
    h("div", { class: "card" }, h("h2", {}, "From the terminal"),
      h("p", { class: "sub" }, "Everything here also works without the UI:"),
      codeBlock("mcpmaster connect")));
}

function settingsPage() {
  const s = store.state;
  const toggle = h("input", { type: "checkbox", checked: s.allowPrivateNetwork, "aria-label": "Allow private network access" });
  toggle.addEventListener("change", async () => {
    const next = toggle.checked;
    if (next) {
      const ok = await confirmDialog({ title: "Allow private network access?", description: "Integrations will be able to reach localhost and addresses on your local network. Only turn this on if you're wrapping an API that runs there — a spec you don't trust could then point calls at services on your network.", confirmLabel: "Allow", danger: true });
      if (!ok) { toggle.checked = false; return; }
    }
    try { await api("PATCH", "/api/settings", { allowPrivateNetwork: next }); await refresh(); toast(next ? "Private network access on" : "Private network access off"); }
    catch (e) { toggle.checked = !next; toast(e.message, "fail"); }
  });
  const modeButton = (mode, label) => h("button", { type: "button", "aria-pressed": String(s.toolMode === mode), disabled: s.toolModeOverridden,
    onclick: async () => {
      if (s.toolMode === mode) return;
      try { await api("PATCH", "/api/settings", { toolMode: mode }); await render({ soft: true }); toast(mode === "execute" ? "Agents now see one execute tool" : "Agents now see every tool"); }
      catch (e) { toast(e.message, "fail"); }
    } }, label);
  return h("div", {},
    h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "Settings"), h("p", {}, "Local settings for this machine."))),
    h("div", { class: "card" }, h("div", { class: "setting" },
      h("div", {}, h("h2", {}, "What agents see"),
        h("p", {}, s.toolMode === "execute"
          ? "One execute tool (recommended). The agent writes a short snippet that searches, reads and calls your tools and returns only what it needs, so its context stays small however many tools you connect."
          : "Every tool, listed individually. Simple for clients that can't run code, but every tool's schema lands in the agent's context."),
        s.toolModeOverridden ? h("p", { class: "hint" }, "Set by MCPMASTER_TOOL_MODE in the environment mcpmaster runs in.") : null),
      h("div", { class: "segmented", role: "group", "aria-label": "Tool mode" }, modeButton("execute", "One execute tool"), modeButton("all", "Every tool")))),
    h("div", { class: "card" }, h("div", { class: "setting" },
      h("div", {}, h("h2", {}, "Private network access"), h("p", {}, "Off by default: integrations can only reach public internet addresses, and redirects are never followed. Turn it on to wrap an API running on localhost or your LAN.")),
      h("label", { class: "switch" }, toggle, h("span", {})))),
    h("div", { class: "card" }, h("h2", {}, "This install"),
      h("dl", { class: "kv" },
        h("dt", {}, "Version"), h("dd", {}, s.version),
        h("dt", {}, "State"), h("dd", { class: "mono" }, s.home),
        h("dt", {}, "MCP endpoint"), h("dd", { class: "mono" }, s.mcpUrl),
        h("dt", {}, "Listening on"), h("dd", {}, "127.0.0.1 only"))),
    h("div", { class: "card" }, h("h2", {}, "Access token"),
      h("p", { class: "sub" }, "The web UI and the HTTP endpoint require your local token. Rotating it signs this page out and disconnects HTTP clients."),
      codeBlock("mcpmaster token --rotate && mcpmaster stop && mcpmaster up")));
}

function tokenScreen() {
  const input = h("input", { type: "password", "aria-label": "mcpmaster token", autocomplete: "off", placeholder: "mcpm_local_…" });
  return h("div", { class: "hero signin" },
    h("img", { src: "/logo.svg", alt: "", width: "44", height: "44" }),
    h("h1", {}, "Open mcpmaster from your terminal"),
    h("p", {}, "This page needs your local access token. Running the command below opens it signed in:"),
    codeBlock("mcpmaster up"),
    h("p", { class: "hint" }, "Or paste the output of ", h("code", {}, "mcpmaster token"), ":"),
    h("form", { class: "paste", onsubmit: (e) => {
      e.preventDefault();
      token = input.value.trim();
      try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* ignore */ }
      render();
    } }, input, h("button", { class: "btn btn-primary", type: "submit" }, "Open")));
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

let renderSeq = 0;

// Local calls usually answer in a few ms; a skeleton that flashes for one
// frame is worse than none, so it only appears if loading takes longer.
const SKELETON_DELAY_MS = 150;

function pageSpec(page, id) {
  if (page === "tools") return toolsSpec;
  if (page === "integrations" && id) return integrationSpec;
  const views = { integrations: integrationsPage, connect: connectPage, settings: settingsPage };
  return { skeleton: "list", view: views[page] || integrationsPage };
}

/**
 * Load the state and the page's own data together, then swap the finished
 * page in at once. A navigation shows the page's skeleton if that takes a
 * moment; a soft render (after an action) keeps the current page on screen
 * until the new one is ready, and keeps scroll position and focus.
 */
async function render({ soft = false } = {}) {
  const app = document.getElementById("app");
  const seq = ++renderSeq;
  if (!token) {
    app.className = "";
    app.replaceChildren(h("main", {}, tokenScreen()));
    return;
  }
  const { page, id, params } = route();
  const active = ["integrations", "tools", "connect", "settings"].includes(page) ? page : "integrations";
  const spec = pageSpec(active, id);

  const timer = soft ? null : setTimeout(() => {
    if (seq !== renderSeq) return;
    app.className = "shell";
    app.replaceChildren(store.state ? sidebar(active) : sidebarSkeleton(),
      h("main", { id: "main", "aria-busy": "true" }, skeleton(spec.skeleton)));
    announce("Loading…");
  }, SKELETON_DELAY_MS);

  let data;
  try {
    [, data] = await Promise.all([refresh(), spec.load ? spec.load(params, id) : null]);
  } catch (e) {
    clearTimeout(timer);
    if (seq !== renderSeq || e.status === 401) return;
    if (soft && store.state) { toast(e.message, "fail"); return; }
    app.className = "";
    app.replaceChildren(h("main", {}, h("div", { class: "hero" }, h("h1", {}, "Can't reach mcpmaster"), h("p", {}, e.message),
      h("button", { class: "btn btn-primary", onclick: () => render() }, icon("refresh"), "Retry"))));
    return;
  }
  clearTimeout(timer);
  if (seq !== renderSeq) return;

  const focusLabel = soft && document.activeElement ? document.activeElement.getAttribute("aria-label") : null;
  const scroll = window.scrollY;
  chromeWatchers = [];
  const main = h("main", { id: "main" }, spec.view(data, params, id));
  app.className = "shell";
  app.replaceChildren(sidebar(active), main);
  if (soft) {
    window.scrollTo(0, scroll);
    const again = focusLabel && main.querySelector(`[aria-label="${CSS.escape(focusLabel)}"]`);
    if (again) again.focus();
  } else {
    window.scrollTo(0, 0);
  }
}

// Pick up changes made from the CLI while this tab is open.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !token || document.querySelector(".overlay")) return;
  render({ soft: true });
});

render();
