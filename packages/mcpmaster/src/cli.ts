// `mcpmaster` — connect your agents to anything.
//
// This file owns argument parsing, the command table, and the one place a
// failure becomes a rendered error and an exit code (0 ok / 1 failed / 2 the
// invocation was wrong). Behaviour lives in engine.ts; the servers in mcp.ts
// and server.ts; presentation in term.ts.

import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  EngineError,
  addSource,
  aggregateTools,
  DEFAULT_PAGE_SIZE,
  filterTools,
  type ToolAccess,
  type ToolQuery,
  addBlockRule,
  aggregateTools as allTools,
  applySettings,
  approveNewTools,
  callTool,
  describeBlock,
  removeBlockRule,
  setToolEnabled,
  executeCode,
  setToolMode,
  toolMode,
  closeAllStdio,
  describeCredential,
  findSource,
  removeSource,
  signOut,
  startSignIn,
  syncSource,
  updateSource,
  type AddSourceInput,
} from "./engine.ts";
import { createMcpServer } from "./mcp.ts";
import { DEFAULT_PORT, startServer } from "./server.ts";
import { adminToken, ensureHome, homeDir, loadConfig, updateConfig, type Source, type SourceType } from "./store.ts";
import {
  CliError,
  accent,
  action,
  bold,
  glyph,
  heading,
  muted,
  note,
  out,
  pad,
  row,
  say,
  setPlain,
  spinner,
} from "./term.ts";
import { VERSION } from "./version.ts";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

type Parsed = { positionals: string[]; rest: string[]; flags: Map<string, string[]> };

/** Flags that take a value; everything else is boolean. */
const VALUE_FLAGS = new Set(["name", "type", "port", "token-env", "header", "env", "api-key", "integration", "access", "limit", "offset"]);

function parseArgs(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  let rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") {
      rest = argv.slice(i + 1);
      break;
    }
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const key = token.slice(2, eq === -1 ? undefined : eq);
      let value = eq === -1 ? undefined : token.slice(eq + 1);
      if (value === undefined && VALUE_FLAGS.has(key)) {
        value = argv[++i];
        if (value === undefined) throw new CliError(`--${key} needs a value`, ["mcpmaster help"], 2);
      }
      flags.set(key, [...(flags.get(key) ?? []), value ?? "true"]);
    } else if (token === "-h") {
      flags.set("help", ["true"]);
    } else {
      positionals.push(token);
    }
  }
  return { positionals, rest, flags };
}

const flag = (p: Parsed, key: string) => p.flags.get(key)?.at(-1);
const has = (p: Parsed, key: string) => p.flags.has(key);

function quoteArg(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(arg)) return arg;
  return `"${arg.replace(/(["\\])/g, "\\$1")}"`;
}

// ---------------------------------------------------------------------------
// Background server
// ---------------------------------------------------------------------------

const serverFile = () => join(homeDir(), "server.json");

async function health(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(800) });
    const body = (await res.json()) as { name?: string };
    return body.name === "mcpmaster";
  } catch {
    return false;
  }
}

function recordedServer(): { pid: number; port: number } | null {
  try {
    return JSON.parse(readFileSync(serverFile(), "utf8"));
  } catch {
    return null;
  }
}

async function ensureBackground(port: number): Promise<{ port: number; started: boolean }> {
  const recorded = recordedServer();
  if (recorded && (await health(recorded.port))) return { port: recorded.port, started: false };
  if (await health(port)) return { port, started: false };

  const log = openSync(join(ensureHome(), "server.log"), "a", 0o600);
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], "start", "--port", String(port), "--quiet"], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();
  closeSync(log);

  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await health(port)) return { port, started: true };
    if (child.exitCode !== null) break;
  }
  throw new CliError(`Couldn't start mcpmaster on port ${port}`, [`mcpmaster start --port ${port + 1}`], 1);
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // No browser available — the URL is printed anyway.
  }
}

function uiUrl(port: number): string {
  return `http://127.0.0.1:${port}/#token=${adminToken()}`;
}

function portFlag(p: Parsed): number {
  const raw = flag(p, "port") ?? process.env.MCPMASTER_PORT;
  if (raw === undefined) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CliError("--port must be 1–65535", [], 2);
  return port;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdUp(p: Parsed): Promise<void> {
  const { port, started } = await ensureBackground(portFlag(p));
  const url = uiUrl(port);
  say(heading("up", `http://127.0.0.1:${port}`));
  say();
  say(row("ok", started ? "Started in the background" : "Already running", `port ${port}`));
  say(row("info", "Web UI", url));
  say(row("info", "MCP (HTTP)", `http://127.0.0.1:${port}/mcp`));
  say();
  say(action("mcpmaster connect", "hook up your agent"));
  if (!has(p, "no-open") && process.stdout.isTTY) openBrowser(url);
}

async function cmdStart(p: Parsed): Promise<void> {
  const port = portFlag(p);
  let started;
  try {
    started = await startServer(port);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new CliError(`Port ${port} is already in use`, ["mcpmaster up", `mcpmaster start --port ${port + 1}`]);
    }
    throw error;
  }
  ensureHome();
  writeFileSync(serverFile(), JSON.stringify({ pid: process.pid, port: started.port }), { mode: 0o600 });
  const cleanup = () => {
    const recorded = recordedServer();
    if (recorded?.pid === process.pid) rmSync(serverFile(), { force: true });
    void closeAllStdio().finally(() => process.exit(0));
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  if (has(p, "quiet")) return;
  say(heading("start", started.url));
  say();
  say(row("ok", "Listening", "127.0.0.1 only", 12));
  say(row("info", "Web UI", uiUrl(started.port), 12));
  say(row("info", "MCP (HTTP)", started.mcpUrl, 12));
  say();
  say(note("Ctrl+C to stop. Run `mcpmaster up` instead to keep it in the background."));
  if (has(p, "open")) openBrowser(uiUrl(started.port));
}

async function cmdStop(): Promise<void> {
  const recorded = recordedServer();
  if (!recorded || !(await health(recorded.port))) {
    rmSync(serverFile(), { force: true });
    say(row("info", "mcpmaster isn't running in the background"));
    return;
  }
  try {
    process.kill(recorded.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  rmSync(serverFile(), { force: true });
  say(row("ok", "Stopped", `port ${recorded.port}`));
}

async function cmdStatus(p: Parsed): Promise<void> {
  const recorded = recordedServer();
  const running = recorded ? await health(recorded.port) : false;
  const config = loadConfig();
  const tools = aggregateTools(config);
  if (has(p, "json")) {
    out(JSON.stringify({ running, port: running ? recorded!.port : null, integrations: config.sources.length, tools: tools.length }));
    return;
  }
  say(heading("status"));
  say();
  say(row(running ? "ok" : "info", "Server", running ? `http://127.0.0.1:${recorded!.port}` : "not running", 14));
  say(row("info", "Integrations", String(config.sources.length), 14));
  say(row("info", "Tools", `${tools.filter((t) => t.enabled).length} exposed of ${tools.length}`, 14));
  say(row("info", "Home", homeDir(), 14));
  if (!running) {
    say();
    say(action("mcpmaster up"));
  }
}

async function cmdMcp(): Promise<void> {
  // stdout is the protocol stream from here on — nothing else may write to it.
  applySettings();
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  const shutdown = () => void closeAllStdio().finally(() => process.exit(0));
  process.stdin.on("end", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await server.connect(transport);
}

function typeFlag(p: Parsed): SourceType | undefined {
  const type = flag(p, "type");
  if (type === undefined) return undefined;
  if (!["openapi", "graphql", "mcp", "stdio"].includes(type)) {
    throw new CliError("--type is one of openapi, graphql, mcp, stdio", [], 2);
  }
  return type as SourceType;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new CliError("--token-stdin needs the token piped in", ["printf %s \"$TOKEN\" | mcpmaster add … --bearer --token-stdin"], 2);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function authFromFlags(p: Parsed): Promise<Pick<AddSourceInput, "auth" | "token">> {
  const bearer = has(p, "bearer");
  const apiKey = has(p, "api-key");
  if (!bearer && !apiKey) {
    if (has(p, "token-env") || has(p, "token-stdin")) throw new CliError("Say how to send the token: --bearer or --api-key", [], 2);
    return {};
  }
  if (bearer && apiKey) throw new CliError("Pick one of --bearer or --api-key", [], 2);
  const env = flag(p, "token-env");
  if (!env && !has(p, "token-stdin")) {
    throw new CliError("Pass the token with --token-env NAME or pipe it with --token-stdin", [], 2);
  }
  const token = has(p, "token-stdin") ? await readStdin() : undefined;
  const header = apiKey && flag(p, "api-key") !== "true" ? flag(p, "api-key") : flag(p, "header");
  return { auth: { type: bearer ? "bearer" : "api_key", header, env }, token };
}

function envFlags(p: Parsed): Record<string, string> | undefined {
  const pairs = p.flags.get("env");
  if (!pairs) return undefined;
  const env: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new CliError(`--env takes KEY=VALUE (got "${pair}")`, [], 2);
    env[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return env;
}

function describeTarget(source: Source): string {
  if (source.type === "stdio") return [source.command ?? "", ...(source.args ?? [])].map(quoteArg).join(" ");
  return source.url ?? "";
}

async function cmdAdd(p: Parsed): Promise<void> {
  const parts = [...p.positionals, ...p.rest];
  if (parts.length === 0) {
    throw new CliError("Tell mcpmaster what to connect", [
      "mcpmaster add https://petstore3.swagger.io/api/v3/openapi.json",
      "mcpmaster add https://api.example.com/graphql --bearer --token-env EXAMPLE_TOKEN",
      "mcpmaster add -- npx -y @modelcontextprotocol/server-filesystem ~/code",
    ], 2);
  }
  const input = parts.length === 1 ? parts[0] : parts.map(quoteArg).join(" ");
  const auth = await authFromFlags(p);
  const json = has(p, "json");
  if (!json) say(heading("add", input));
  const spin = json ? { stop() {} } : spinner("Connecting and reading its tools…");
  let source: Source;
  try {
    source = await addSource({
      input,
      name: flag(p, "name"),
      type: typeFlag(p),
      env: envFlags(p),
      readOnly: has(p, "read-only"),
      hideNewTools: has(p, "hide-new-tools"),
      ...auth,
    });
  } finally {
    spin.stop();
  }
  if (json) {
    out(JSON.stringify({ ok: true, integration: { id: source.id, name: source.name, type: source.type, status: source.status, tools: source.toolCount } }));
    return;
  }
  if (source.status === "needs_auth") {
    say();
    say(row("info", `${bold(source.name)} uses OAuth`, "opening its sign-in page"));
    const signedIn = await signInFlow(source, p);
    say(row("ok", `Connected ${bold(signedIn.name)}`, `mcp · ${signedIn.toolCount} tools`));
    say();
    say(action(`mcpmaster tools ${signedIn.name}`, "see what agents can call"));
    return;
  }
  say();
  say(row("ok", `Connected ${bold(source.name)}`, `${source.type} · ${source.toolCount} tools`));
  say();
  say(action(`mcpmaster tools ${source.name}`, "see what agents can call"));
}

async function cmdList(p: Parsed): Promise<void> {
  const sources = loadConfig().sources;
  if (has(p, "json")) {
    out(JSON.stringify(sources.map((s) => ({
      id: s.id, name: s.name, type: s.type, target: describeTarget(s), enabled: s.enabled,
      status: s.status, error: s.error, tools: s.toolCount, credential: describeCredential(s),
    }))));
    return;
  }
  say(heading("list"));
  say();
  if (sources.length === 0) {
    say(row("info", "No integrations yet"));
    say();
    say(action("mcpmaster add <url | spec file | -- command>"));
    return;
  }
  const width = Math.max(...sources.map((s) => s.name.length));
  for (const s of sources) {
    const kind = !s.enabled ? "info" : s.status === "ready" ? "ok" : s.status === "failed" ? "fail" : "warn";
    const detail = `${s.type} · ${s.toolCount} tools${s.enabled ? "" : " · disabled"}${s.error ? ` · ${s.error}` : ""}`;
    say(row(kind, s.name, detail, width));
    if (s.status === "needs_auth") say(note(`sign in: mcpmaster login ${s.name}`));
  }
}

function isRule(ref: string): boolean {
  return /[*?]/.test(ref);
}

async function cmdToolsBlock(p: Parsed, refs: string[], block: boolean): Promise<void> {
  if (refs.length === 0) {
    throw new CliError(`Which tools? mcpmaster tools ${block ? "block" : "unblock"} <tool | rule>…`, [
      "mcpmaster tools block github_delete_repo",
      "mcpmaster tools block 'github_delete_*'",
    ], 2);
  }
  say(heading(`tools ${block ? "block" : "unblock"}`));
  say();
  for (const ref of refs) {
    if (isRule(ref)) {
      if (block) {
        const matches = addBlockRule(ref);
        say(row("ok", `Rule ${bold(ref)}`, `hides ${matches} tool${matches === 1 ? "" : "s"} now, and any that match later`));
      } else if (removeBlockRule(ref)) {
        say(row("ok", `Removed rule ${bold(ref)}`));
      } else {
        throw new CliError(`There's no rule "${ref}"`, ["mcpmaster tools rules"]);
      }
      continue;
    }
    const tool = setToolEnabled(ref, !block);
    if (block) say(row("ok", `Blocked ${bold(tool.fullName)}`));
    else say(row("ok", `Unblocked ${bold(tool.fullName)}`, tool.allowedOverride ? "allowed over its rule" : ""));
  }
}

async function cmdToolsRules(p: Parsed): Promise<void> {
  const config = loadConfig();
  const tools = allTools(config);
  if (has(p, "json")) {
    out(JSON.stringify({
      rules: config.blockRules,
      blocked: config.disabledTools,
      allowed: config.allowedTools,
      readOnly: config.sources.filter((s) => s.readOnly).map((s) => s.name),
      hideNewTools: config.sources.filter((s) => s.hideNewTools).map((s) => s.name),
    }));
    return;
  }
  say(heading("tools rules"));
  say();
  const width = 12;
  if (config.blockRules.length === 0) say(row("info", "Rules", "none", width));
  for (const rule of config.blockRules) {
    const n = tools.filter((t) => t.blockedBy?.kind === "rule" && t.blockedBy.rule === rule).length;
    say(row("info", "Rule", `${rule}  (${n} now)`, width));
  }
  for (const s of config.sources.filter((x) => x.readOnly)) say(row("info", "Read-only", s.name, width));
  for (const s of config.sources.filter((x) => x.hideNewTools)) {
    say(row("info", "Review new", `${s.name}${s.pendingReview?.length ? `  (${s.pendingReview.length} waiting)` : ""}`, width));
  }
  for (const name of config.disabledTools) say(row("info", "Blocked", name, width));
  for (const name of config.allowedTools) say(row("info", "Allowed", `${name}  (over a rule)`, width));
  say();
  say(action("mcpmaster tools block '<integration>_delete_*'", "hide tools by pattern, now and in future syncs"));
}

async function cmdTools(p: Parsed): Promise<void> {
  const [verb, ...refs] = p.positionals;
  if (verb === "block" || verb === "unblock") return cmdToolsBlock(p, refs, verb === "block");
  if (verb === "rules") return cmdToolsRules(p);
  const query = p.positionals.join(" ");
  const access = flag(p, "access");
  if (access !== undefined && !["read", "write", "unknown"].includes(access)) {
    throw new CliError("--access is read, write or unknown", ["mcpmaster tools --access write"], 2);
  }
  const integration = flag(p, "integration");
  if (integration !== undefined && !loadConfig().sources.some((s) => s.name === integration)) {
    throw new CliError(`There's no integration "${integration}"`, ["mcpmaster list"], 2);
  }
  const hidden = has(p, "blocked") || has(p, "hidden");
  const filter: ToolQuery = {
    q: query || undefined,
    integration,
    status: hidden ? "hidden" : has(p, "exposed") ? "exposed" : undefined,
    access: access as ToolAccess | undefined,
  };
  const number = (key: string, fallback: number) => {
    const value = flag(p, key);
    if (value === undefined) return fallback;
    if (!/^\d{1,6}$/.test(value)) throw new CliError(`--${key} is a whole number`, [`mcpmaster tools --${key} 50`], 2);
    return Number(value);
  };
  // A terminal gets one page (--all for everything); --json gets everything
  // unless it asks for a page, so scripts don't silently miss tools.
  const json = has(p, "json");
  const offset = number("offset", 0);
  const limit = has(p, "all") || (json && !has(p, "limit")) ? Number.MAX_SAFE_INTEGER : number("limit", DEFAULT_PAGE_SIZE);
  const tools = filterTools(aggregateTools(), filter);
  const page = tools.slice(offset, offset + limit);

  if (json) {
    // A bare array, like most CLIs' --json lists: `jq '.[]'` just works.
    out(JSON.stringify(page.map((t) => ({
      name: t.fullName, integration: t.source.name, description: t.description, enabled: t.enabled,
      access: t.access, blockedBy: t.blockedBy ? describeBlock(t.blockedBy) : null, inputSchema: t.inputSchema,
    }))));
    return;
  }
  say(heading("tools", query || integration || undefined));
  say();
  if (tools.length === 0) {
    const filtered = Boolean(query || integration || filter.status || access);
    say(row("info", filtered ? "No tools match that" : "No tools yet"));
    say();
    say(action(filtered ? "mcpmaster tools" : "mcpmaster add <url>"));
    return;
  }
  if (page.length === 0) {
    say(row("info", `Only ${tools.length} tools match`, `--offset ${offset} is past the end`));
    return;
  }
  const width = Math.min(48, Math.max(...page.map((t) => t.fullName.length)));
  for (const t of page) {
    const desc = t.blockedBy ? `(${describeBlock(t.blockedBy)})` : t.description.replace(/\s+/g, " ").slice(0, 72);
    say(`  ${t.enabled ? accent("●") : muted("○")} ${pad(t.fullName, width)}  ${muted(desc)}`);
  }
  say();
  const hiddenCount = tools.filter((t) => !t.enabled).length;
  const shown = offset + page.length < tools.length || offset > 0
    ? `${offset + 1}–${offset + page.length} of ${tools.length} tools`
    : `${tools.length} tools`;
  say(note(`${shown}${hiddenCount && !hidden ? `, ${hiddenCount} hidden from agents` : ""}. Call one: mcpmaster call <name> '{"arg":"value"}'`));
  if (offset + page.length < tools.length) {
    const next = ["mcpmaster tools", query && quoteArg(query), integration && `--integration ${quoteArg(integration)}`,
      hidden && "--hidden", filter.status === "exposed" && "--exposed", access && `--access ${access}`,
      has(p, "limit") && `--limit ${limit}`, `--offset ${offset + page.length}`].filter(Boolean).join(" ");
    say(action(next, "next page (or --all)"));
  }
}

async function cmdCall(p: Parsed): Promise<void> {
  const [name, rawArgs] = p.positionals;
  if (!name) throw new CliError("Which tool?", ["mcpmaster tools"], 2);
  let args: Record<string, unknown> = {};
  if (rawArgs) {
    try {
      args = JSON.parse(rawArgs);
    } catch {
      throw new CliError("Arguments must be a JSON object", [`mcpmaster call ${name} '{"key":"value"}'`], 2);
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new CliError("Arguments must be a JSON object", [], 2);
  }
  const outcome = await callTool(name, args);
  if (has(p, "json")) {
    (outcome.ok ? out : (t: string) => process.stderr.write(`${t}\n`))(JSON.stringify(outcome));
    if (!outcome.ok) process.exitCode = 1;
    return;
  }
  if (!outcome.ok) throw new CliError(outcome.error, [`mcpmaster tools ${name.split("_")[0]}`]);
  out(outcome.text);
}

function requireSource(ref: string | undefined, command: string): Source {
  if (!ref) throw new CliError(`Which integration? mcpmaster ${command} <name>`, ["mcpmaster list"], 2);
  const source = findSource(ref);
  if (!source) throw new CliError(`No integration named "${ref}"`, ["mcpmaster list"]);
  return source;
}

async function cmdSync(p: Parsed): Promise<void> {
  const targets = p.positionals.length ? p.positionals.map((ref) => requireSource(ref, "sync")) : loadConfig().sources;
  say(heading("sync"));
  say();
  let failed = 0;
  for (const target of targets) {
    const spin = spinner(`Syncing ${target.name}…`);
    const source = await syncSource(target.id).finally(() => spin.stop());
    if (source.status === "ready") say(row("ok", source.name, `${source.toolCount} tools`));
    else {
      failed++;
      say(row("fail", source.name, source.error ?? "failed"));
    }
  }
  if (failed) process.exitCode = 1;
}

/**
 * Runs an OAuth sign-in to completion: the callback lands on the local
 * server, so make sure one is running, open the provider's page, and wait
 * for the server to record the result. Every sign-in registers a fresh
 * client (engine.startSignIn) — nothing cached is ever reused.
 */
async function signInFlow(source: Source, p: Parsed): Promise<Source> {
  const { port } = await ensureBackground(portFlag(p));
  const url = await startSignIn(source.id, port);
  if (url) {
    say(row("info", "Sign in", url));
    if (process.stdout.isTTY || process.stderr.isTTY) openBrowser(url);
    const spin = spinner("Waiting for you to finish signing in…");
    try {
      const deadline = Date.now() + 5 * 60_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        const current = loadConfig().sources.find((s) => s.id === source.id);
        if (!current) throw new CliError("That integration was removed while signing in");
        if (current.status === "ready") return current;
        if (current.status === "failed") throw new CliError(current.error ?? "The sign-in didn't finish", [`mcpmaster login ${source.name}`]);
      }
    } finally {
      spin.stop();
    }
    throw new CliError("Timed out waiting for the sign-in", [`mcpmaster login ${source.name}`]);
  }
  const current = loadConfig().sources.find((s) => s.id === source.id)!;
  if (current.status !== "ready") throw new CliError(current.error ?? "The sign-in didn't finish", [`mcpmaster login ${source.name}`]);
  return current;
}

async function cmdLogin(p: Parsed): Promise<void> {
  const source = requireSource(p.positionals[0], "login");
  say(heading("login", source.name));
  say();
  const signedIn = await signInFlow(source, p);
  say(row("ok", `Signed in to ${bold(signedIn.name)}`, `${signedIn.toolCount} tools`));
}

async function cmdLogout(p: Parsed): Promise<void> {
  const source = requireSource(p.positionals[0], "logout");
  await signOut(source.id);
  say(row("ok", `Signed out of ${source.name}`, "its client registration and tokens are deleted"));
  say(action(`mcpmaster login ${source.name}`, "sign in again (registers a new client)"));
}

function onOff(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (["true", "on", "yes"].includes(value)) return true;
  if (["off", "false", "no"].includes(value)) return false;
  throw new CliError(`--${name} takes on or off`, [], 2);
}

async function cmdPolicy(p: Parsed): Promise<void> {
  const source = requireSource(p.positionals[0], "policy");
  const readOnly = onOff(flag(p, "read-only"), "read-only");
  const hideNew = onOff(flag(p, "hide-new-tools"), "hide-new-tools");
  if (readOnly !== undefined || hideNew !== undefined) await updateSource(source.id, { readOnly, hideNewTools: hideNew });
  if (has(p, "approve")) approveNewTools(source.id);

  const current = findSource(source.id)!;
  const tools = allTools().filter((t) => t.source.id === source.id);
  say(heading("policy", current.name));
  say();
  say(row(current.readOnly ? "ok" : "info", "Read-only", current.readOnly ? "on — only reading tools are exposed" : "off", 16));
  say(row(current.hideNewTools ? "ok" : "info", "Hide new tools", current.hideNewTools ? "on — tools from later syncs wait for review" : "off", 16));
  if (current.pendingReview?.length) {
    say(row("warn", "Waiting review", current.pendingReview.join(", "), 16));
  }
  say(row("info", "Exposed", `${tools.filter((t) => t.enabled).length} of ${tools.length} tools`, 16));
  say();
  if (current.pendingReview?.length) say(action(`mcpmaster policy ${current.name} --approve`, "expose the new tools"));
  else if (!current.readOnly) say(action(`mcpmaster policy ${current.name} --read-only`, "expose only tools that read"));
}

async function cmdRemove(p: Parsed): Promise<void> {
  const source = requireSource(p.positionals[0], "remove");
  await removeSource(source.id);
  say(row("ok", `Removed ${source.name}`));
}

async function cmdToggle(p: Parsed, enabled: boolean): Promise<void> {
  const source = requireSource(p.positionals[0], enabled ? "enable" : "disable");
  await updateSource(source.id, { enabled });
  say(row("ok", `${enabled ? "Enabled" : "Disabled"} ${source.name}`));
}

function stdioLaunch(): { command: string; args: string[] } {
  return { command: "npx", args: ["-y", "mcpmaster@latest", "mcp"] };
}

export function connectSnippets(mcpUrl: string, token: string): Record<string, string> {
  const { command, args } = stdioLaunch();
  const line = [command, ...args].join(" ");
  const json = (key: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ [key]: { mcpmaster: { ...extra, command, args } } }, null, 2);
  return {
    "claude-code": `claude mcp add mcpmaster -- ${line}`,
    codex: `codex mcp add mcpmaster -- ${line}`,
    cursor: json("mcpServers"),
    "claude-desktop": json("mcpServers"),
    vscode: json("servers", { type: "stdio" }),
    http: `claude mcp add --transport http mcpmaster ${mcpUrl} --header "Authorization: Bearer ${token}"`,
  };
}

async function cmdConnect(p: Parsed): Promise<void> {
  const client = p.positionals[0];
  const recorded = recordedServer();
  const port = recorded?.port ?? DEFAULT_PORT;
  const snippets = connectSnippets(`http://127.0.0.1:${port}/mcp`, has(p, "show-token") ? adminToken() : "$(mcpmaster token)");
  if (client) {
    const snippet = snippets[client];
    if (!snippet) throw new CliError(`Unknown client "${client}"`, [`mcpmaster connect (one of: ${Object.keys(snippets).join(", ")})`], 2);
    out(snippet);
    return;
  }
  say(heading("connect"));
  say();
  say(`  ${bold("Claude Code")}`);
  say(`    ${accent(snippets["claude-code"])}`);
  say(`  ${bold("Codex")}`);
  say(`    ${accent(snippets.codex)}`);
  say(`  ${bold("Cursor, Claude Desktop, Windsurf")} ${muted("— add to the mcpServers config")}`);
  for (const line of snippets.cursor.split("\n")) say(`    ${line}`);
  say(`  ${bold("Over HTTP")} ${muted("— while `mcpmaster up` is running")}`);
  say(`    ${accent(snippets.http)}`);
  say();
  say(note("Print one on stdout: mcpmaster connect claude-code | sh"));
}

async function cmdToken(p: Parsed): Promise<void> {
  out(adminToken(has(p, "rotate")));
  if (has(p, "rotate")) say(row("warn", "Rotated — restart the server and re-open the web UI", "mcpmaster stop && mcpmaster up"));
}

async function cmdSettings(p: Parsed): Promise<void> {
  const [key, value] = p.positionals;
  if (key === "private-network" && (value === "on" || value === "off")) {
    updateConfig((c) => {
      c.allowPrivateNetwork = value === "on";
    });
    say(row(value === "on" ? "warn" : "ok", `Private network access ${value}`,
      value === "on" ? "integrations may now reach localhost and LAN addresses" : "only public addresses are reachable"));
    return;
  }
  if (key === "tools" && (value === "execute" || value === "all")) {
    setToolMode(value);
    say(row("ok", `Agents now see ${value === "execute" ? "one `execute` tool" : "every tool individually"}`,
      value === "execute" ? "flat context cost, however many tools you connect" : "for clients that can't run code-mode snippets"));
    say(note("Connected agents pick this up on their next tools/list — reconnect if yours caches the list."));
    return;
  }
  if (key !== undefined) {
    throw new CliError(`Unknown setting "${[key, value].filter(Boolean).join(" ")}"`, ["mcpmaster settings"], 2);
  }
  const config = loadConfig();
  say(heading("settings"));
  say();
  say(row("info", "tools", `${toolMode(config)}${toolMode(config) !== config.toolMode ? " (MCPMASTER_TOOL_MODE)" : ""}`, 16));
  say(row("info", "private-network", config.allowPrivateNetwork ? "on" : "off", 16));
  say();
  say(action("mcpmaster settings tools execute | all", "one code-mode tool (default) or every tool"));
  say(action("mcpmaster settings private-network on", "reach APIs on localhost / your LAN"));
}

async function readCodeArg(p: Parsed): Promise<string> {
  const code = p.positionals.join(" ");
  if (code && code !== "-") return code;
  if (process.stdin.isTTY) {
    throw new CliError("Pass the snippet as an argument, or pipe it in", [
      "mcpmaster execute 'return await tools.search({ query: \"issues\" })'",
      "mcpmaster execute - < snippet.ts",
    ], 2);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function cmdExecute(p: Parsed): Promise<void> {
  const outcome = await executeCode(await readCodeArg(p));
  if (has(p, "json")) {
    (outcome.ok ? out : (t: string) => process.stderr.write(`${t}\n`))(JSON.stringify(outcome));
    if (!outcome.ok) process.exitCode = 1;
    return;
  }
  if (!outcome.ok) throw new CliError(outcome.error, ["mcpmaster tools"]);
  out(outcome.text);
}

function help(): void {
  const cmd = (name: string, text: string) => say(`    ${pad(accent(name), 34)}${muted(text)}`);
  say(`  ${accent(bold("mcpmaster"))}  ${bold("connect your agents to anything")}   ${muted(`v${VERSION}`)}`);
  say();
  say(`  ${bold("GET GOING")}`);
  cmd("up", "Start in the background and open the web UI");
  cmd("add <url | file | -- command>", "Connect an OpenAPI, GraphQL or MCP integration");
  cmd("connect [client]", "Hook mcpmaster up to Claude, Cursor, Codex, VS Code…");
  say();
  say(`  ${bold("USE")}`);
  cmd("tools [query] [--integration name] [--hidden|--exposed] [--access read|write]", "Search and filter tools, 50 at a time (--offset n, --limit n, --all)");
  cmd("tools block | unblock <tool | rule>", "Hide or show tools; rules like 'github_delete_*'");
  cmd("tools rules", "Every block rule, block and override in effect");
  cmd("call <tool> [json]", "Call a tool; the result goes to stdout");
  cmd("execute <code | ->", "Run a code-mode snippet, exactly as an agent would");
  cmd("mcp", "Serve MCP over stdio (what agents launch)");
  say();
  say(`  ${bold("MANAGE")}`);
  cmd("list", "Integrations and their status");
  cmd("sync [name]", "Re-read an integration's tools");
  cmd("enable | disable <name>", "Expose or hide an integration");
  cmd("policy <name> [--read-only] [--hide-new-tools]", "Read-only, review new tools (--approve)");
  cmd("login | logout <name>", "OAuth sign-in for a remote MCP server (always fresh)");
  cmd("remove <name>", "Delete an integration and its credential");
  cmd("settings", "Tool mode (execute | all), private network access");
  cmd("start | stop | status", "Run in the foreground, stop, inspect");
  cmd("token [--rotate]", "Print the local admin token");
  say();
  say(`  ${bold("ADD FLAGS")}`);
  cmd("--name <slug>", "Name (also the tool prefix agents see)");
  cmd("--type openapi|graphql|mcp|stdio", "Skip auto-detection");
  cmd("--bearer | --api-key[=Header]", "How to send a credential");
  cmd("--token-env NAME | --token-stdin", "Where the credential comes from");
  cmd("--env KEY=VALUE", "Environment for a local command (repeatable)");
  cmd("--read-only | --hide-new-tools", "Start with read-only / new-tool review on");
  say();
  say(`  ${muted("Global: --json (machine output) · --plain (no color) · MCPMASTER_HOME (state dir)")}`);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const COMMANDS: Record<string, (p: Parsed) => Promise<void>> = {
  up: cmdUp,
  web: cmdUp,
  start: cmdStart,
  stop: cmdStop,
  status: cmdStatus,
  mcp: cmdMcp,
  add: cmdAdd,
  list: cmdList,
  ls: cmdList,
  tools: cmdTools,
  call: cmdCall,
  execute: cmdExecute,
  exec: cmdExecute,
  sync: cmdSync,
  remove: cmdRemove,
  rm: cmdRemove,
  policy: cmdPolicy,
  login: cmdLogin,
  logout: cmdLogout,
  enable: (p) => cmdToggle(p, true),
  disable: (p) => cmdToggle(p, false),
  connect: cmdConnect,
  token: cmdToken,
  settings: cmdSettings,
};

export async function main(argv: string[]): Promise<void> {
  if (argv.includes("--plain") || argv.includes("--json")) setPlain();
  const [command, ...rest] = argv.filter((a) => a !== "--plain");
  try {
    if (!command || command === "help" || command === "--help" || command === "-h") return help();
    if (command === "--version" || command === "-v" || command === "version") return out(VERSION);
    const run = COMMANDS[command];
    if (!run) throw new CliError(`Unknown command "${command}"`, ["mcpmaster help"], 2);
    const parsed = parseArgs(rest);
    if (has(parsed, "help")) return help();
    await run(parsed);
  } catch (error) {
    const cli =
      error instanceof CliError
        ? error
        : error instanceof EngineError
          ? new CliError(error.message, ["mcpmaster list"])
          : new CliError("Something went wrong", ["MCPMASTER_DEBUG=1 mcpmaster " + argv.map(quoteArg).join(" ")]);
    if (argv.includes("--json")) {
      process.stderr.write(`${JSON.stringify({ ok: false, error: cli.message, actions: cli.actions })}\n`);
    } else {
      say(`  ${glyph("fail")} ${cli.message}`);
      for (const next of cli.actions) say(action(next));
    }
    if (process.env.MCPMASTER_DEBUG === "1" && error instanceof Error) say(muted(error.stack ?? ""));
    process.exitCode = cli.exitCode;
  } finally {
    // A one-shot command that touched a local (stdio) integration leaves its
    // process running; close it so the CLI exits. Long-running commands keep
    // theirs — they own the pool for their lifetime.
    if (!LONG_RUNNING.has(command)) await closeAllStdio();
  }
}

const LONG_RUNNING = new Set(["start", "mcp"]);
