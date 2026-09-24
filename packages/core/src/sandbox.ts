import * as nodeModule from "node:module";
import { newQuickJSWASMModuleFromVariant, shouldInterruptAfterDeadline } from "quickjs-emscripten-core";
import type { QuickJSWASMModule } from "quickjs-emscripten-core";
import releaseSyncVariant from "@jitl/quickjs-wasmfile-release-sync";

// The sandbox behind the MCP endpoint's single `execute` tool ("code mode").
//
// Why this exists: advertising every integration's tools through list_tools
// puts every tool definition into the calling agent's context window — a
// few large APIs (GitHub, Stripe, Jira, Sentry) add up to ~1,600 tool schemas
// before the agent has done anything. Code mode advertises ONE tool whose
// input is a TypeScript snippet; the snippet discovers tools on demand
// (`tools.search`, `tools.describe.tool`) and calls them (`tools[path](input)`),
// and only its final return value re-enters the agent's context.
//
// Why QuickJS-in-WebAssembly and not `node:vm`: `node:vm` is explicitly not a
// security boundary (a snippet can walk `this.constructor.constructor` back to
// the host's Function and reach `process`). QuickJS runs in its own WASM
// linear memory with no host objects at all — no `fetch`, `process`,
// `require`, filesystem or timers. The ONLY capability a snippet has is the
// `__host` bridge installed below, and every call over it lands in a
// host-side handler the caller supplies (code-mode.ts's bridge), which in
// turn dispatches through the runtime's callTool() → validatedFetch() like
// any direct tool call. It runs in-process, so there's no separate sandbox
// service to deploy or secure.
//
// Node >= 22.13's built-in type stripper; not yet in this repo's @types/node.
const stripTypeScriptTypes = (
  nodeModule as { stripTypeScriptTypes?: (code: string, options: { mode: "strip" }) => string }
).stripTypeScriptTypes;

// Deliberately free of runtime-specific imports: it's shared engine code, and
// tests/code-mode-sandbox.test.ts executes it under plain `node:test`. The
// self-hosted bundle swaps the .wasm-file QuickJS variant for the single-file
// one (packages/mcpmaster/scripts/build.mjs) — same API, WASM inlined.

export type SandboxLimits = {
  /** Wall-clock budget for the whole run, including time spent awaiting tool calls. */
  timeoutMs: number;
  /** QuickJS heap ceiling. */
  memoryBytes: number;
  /** Max host-bridge calls (search/describe/tool) per run. */
  maxHostCalls: number;
  /** Max serialized size of the returned value. */
  maxResultBytes: number;
  /** Max total size of captured console output. */
  maxLogBytes: number;
};

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  timeoutMs: 30_000,
  memoryBytes: 64 * 1024 * 1024,
  maxHostCalls: 50,
  maxResultBytes: 100_000,
  maxLogBytes: 20_000,
};

/**
 * Host-side handler for one bridge call. Resolve with any JSON-serializable
 * value; throw a `SandboxToolError` to surface a clean message to the snippet
 * as a catchable Error. Any other throw is reported to the snippet generically
 * — a host-side exception's text never crosses into the sandbox, since it can
 * carry internal detail the snippet (and the agent) must not see.
 */
export type HostHandler = (op: string, args: unknown) => Promise<unknown>;

export class SandboxToolError extends Error {}

export type SandboxResult =
  | { ok: true; value: unknown; logs: string[] }
  | { ok: false; error: string; logs: string[] };

// One WASM module per warm instance — compiling it is the expensive part
// (~tens of ms); a runtime + context per run is cheap and gives every run a
// fresh heap.
let modulePromise: Promise<QuickJSWASMModule> | null = null;
function getModule(): Promise<QuickJSWASMModule> {
  modulePromise ??= newQuickJSWASMModuleFromVariant(releaseSyncVariant).catch((err) => {
    modulePromise = null;
    throw err;
  });
  return modulePromise;
}

// Builds `tools` inside the sandbox. Every access path is accumulated, so
// `tools["github.list_issues"](x)` and `tools.github.list_issues(x)` are the
// same call. `tools.search` and `tools.describe.tool` are the two reserved
// paths. Values cross the bridge as JSON strings only — never handles to host
// objects.
const PRELUDE = `
(() => {
  const host = globalThis.__host;
  delete globalThis.__host;
  const call = async (op, args) => {
    const raw = await host(op, JSON.stringify(args === undefined ? {} : args));
    const msg = JSON.parse(raw);
    if (!msg.ok) throw new Error(msg.error);
    return msg.value;
  };
  const node = (path) => new Proxy(function () {}, {
    get(_t, key) {
      if (typeof key !== "string") return undefined;
      if (key === "then") return undefined;
      return node(path ? path + "." + key : key);
    },
    apply(_t, _this, argv) {
      if (path === "search") return call("search", argv[0]);
      if (path === "describe.tool") return call("describe", argv[0]);
      return call("call", { path, input: argv[0] === undefined ? {} : argv[0] });
    },
  });
  globalThis.tools = node("");
  const logs = [];
  const fmt = (v) => { if (typeof v === "string") return v; try { return JSON.stringify(v); } catch { return String(v); } };
  const log = (...a) => { logs.push(a.map(fmt).join(" ")); };
  globalThis.console = { log, info: log, warn: log, error: log, debug: log };
  globalThis.__logs = logs;
})();
`;

function toJavaScript(code: string): string {
  // The snippet is a function body: wrapping it lets it use top-level `await`
  // and `return` its answer, which is the whole point of code mode.
  const wrapped = `(async () => {\n${code}\n})()`;
  // Type-only syntax is erased (not transpiled — enums/namespaces are
  // rejected, which is fine for snippets). Plain JavaScript passes through
  // unchanged, so a runtime without the API still runs JS snippets.
  if (typeof stripTypeScriptTypes !== "function") return wrapped;
  return stripTypeScriptTypes(wrapped, { mode: "strip" });
}

function capLogs(logs: string[], maxBytes: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const line of logs) {
    if (used + line.length > maxBytes) {
      out.push("[further console output truncated]");
      break;
    }
    out.push(line);
    used += line.length;
  }
  return out;
}

export async function runInSandbox(
  code: string,
  handler: HostHandler,
  limits: SandboxLimits = DEFAULT_SANDBOX_LIMITS,
): Promise<SandboxResult> {
  let source: string;
  try {
    source = toJavaScript(code);
  } catch (err) {
    // A syntax error in the caller's own snippet — its message describes their
    // code, not our internals, so it is safe (and necessary) to return.
    return { ok: false, error: `Could not compile code: ${(err as Error).message}`, logs: [] };
  }

  const quickjs = await getModule();
  const runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + limits.timeoutMs;
  // Stops a synchronous busy loop; the wall-clock race below stops a snippet
  // that is merely awaiting.
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
  const vm = runtime.newContext();

  let disposed = false;
  let hostCalls = 0;
  // Deferreds still awaiting a host result. A run that times out mid-await
  // leaves these alive, and disposing a context with live handles aborts the
  // WASM instance — so they are released first (see `finally`).
  const pending = new Set<{ alive: boolean; dispose(): void }>();
  const readLogs = (): string[] => {
    if (disposed) return [];
    try {
      const h = vm.getProp(vm.global, "__logs");
      const logs = vm.dump(h) as string[];
      h.dispose();
      return capLogs(Array.isArray(logs) ? logs : [], limits.maxLogBytes);
    } catch {
      return [];
    }
  };

  try {
    const bridge = vm.newFunction("__host", (opHandle, argsHandle) => {
      const op = vm.getString(opHandle);
      const argsJson = vm.getString(argsHandle);
      const deferred = vm.newPromise();
      pending.add(deferred);

      const settle = (payload: { ok: true; value: unknown } | { ok: false; error: string }) => {
        if (disposed) return;
        let json: string;
        try {
          json = JSON.stringify(payload) ?? JSON.stringify({ ok: true, value: null });
        } catch {
          json = JSON.stringify({ ok: false, error: "Tool returned a value that could not be serialized" });
        }
        const str = vm.newString(json);
        deferred.resolve(str);
        str.dispose();
        pending.delete(deferred);
      };
      deferred.settled.then(() => {
        if (!disposed) runtime.executePendingJobs();
      });

      hostCalls += 1;
      if (hostCalls > limits.maxHostCalls) {
        settle({ ok: false, error: `Too many tool calls in one execution (limit ${limits.maxHostCalls})` });
        return deferred.handle;
      }

      let args: unknown;
      try {
        args = JSON.parse(argsJson);
      } catch {
        args = {};
      }
      handler(op, args).then(
        (value) => settle({ ok: true, value }),
        (err) =>
          settle({
            ok: false,
            error: err instanceof SandboxToolError ? err.message : "Tool call failed",
          }),
      );
      return deferred.handle;
    });
    vm.setProp(vm.global, "__host", bridge);
    bridge.dispose();
    vm.unwrapResult(vm.evalCode(PRELUDE)).dispose();

    const evaluated = vm.evalCode(source, "execute.ts");
    if (evaluated.error) {
      const err = vm.dump(evaluated.error);
      evaluated.error.dispose();
      return { ok: false, error: describeError(err), logs: readLogs() };
    }
    const promiseHandle = evaluated.value;
    const settled = vm.resolvePromise(promiseHandle);
    promiseHandle.dispose();
    runtime.executePendingJobs();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), Math.max(0, deadline - Date.now()));
    });
    const outcome = await Promise.race([settled, timeout]);
    clearTimeout(timer);

    if (outcome === "timeout") {
      return { ok: false, error: `Execution timed out after ${limits.timeoutMs / 1000}s`, logs: readLogs() };
    }
    if (outcome.error) {
      const err = vm.dump(outcome.error);
      outcome.error.dispose();
      return { ok: false, error: describeError(err), logs: readLogs() };
    }
    const value = vm.dump(outcome.value);
    outcome.value.dispose();

    const serialized = JSON.stringify(value ?? null) ?? "null";
    if (serialized.length > limits.maxResultBytes) {
      return {
        ok: false,
        error: `Result is too large (${serialized.length} bytes, limit ${limits.maxResultBytes}). Filter or summarize it inside the code before returning.`,
        logs: readLogs(),
      };
    }
    return { ok: true, value: value ?? null, logs: readLogs() };
  } finally {
    disposed = true;
    try {
      for (const deferred of pending) if (deferred.alive) deferred.dispose();
      vm.dispose();
      runtime.dispose();
    } catch {
      // Disposal failed (a leaked handle aborts the instance). Drop the cached
      // module so the next run compiles a fresh one instead of inheriting a
      // dead instance.
      modulePromise = null;
    }
  }
}

// Errors raised by the snippet itself (its own throw, a failed tool call we
// already translated, an interrupt, OOM). Only name + message — never a stack.
function describeError(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { name?: unknown; message?: unknown };
    const name = typeof e.name === "string" ? e.name : "Error";
    const message = typeof e.message === "string" ? e.message : "";
    if (name === "InternalError" && /interrupted/i.test(message)) return "Execution timed out";
    return message ? `${name}: ${message}` : name;
  }
  return String(err);
}
