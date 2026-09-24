// Executable coverage for MCP code mode: the QuickJS sandbox
// (packages/core/src/sandbox.ts) and the tools bridge (packages/core/src/code-mode.ts),
// shared by every mcpmaster runtime.
// Both modules are free of runtime-specific imports precisely so this file can run
// them for real — the properties below are behaviour, not source shape:
//   - a snippet reaches NOTHING of the host but `tools` (no process/require/fetch);
//   - runaway snippets are stopped (CPU loop, pending await, memory, call count);
//   - host-side exception text never crosses into the sandbox;
//   - list_tools cost is O(integrations), not O(tools).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SANDBOX_LIMITS, SandboxToolError, runInSandbox } from "../packages/core/src/sandbox.ts";
import { buildExecuteTool, createCodeModeHandler, searchTools } from "../packages/core/src/code-mode.ts";

const schema = { type: "object" as const, properties: {}, required: [] as string[] };
const tools = [
  { fullName: "github.list_issues", toolName: "list_issues", description: "List issues in a repository", inputSchema: schema, integrationName: "GitHub" },
  { fullName: "github.create_issue", toolName: "create_issue", description: "Create an issue", inputSchema: schema, integrationName: "GitHub" },
  { fullName: "stripe.create_refund", toolName: "create_refund", description: "Refund a charge", inputSchema: schema, integrationName: "Stripe" },
];

function handlerFor(callTool = async () => ({ ok: true as const, text: JSON.stringify({ items: [1, 2, 3] }) })) {
  const calls: string[] = [];
  const handler = createCodeModeHandler({
    tools,
    beforeCall: async () => {},
    callTool: async (tool, input) => {
      calls.push(`${tool.fullName}:${JSON.stringify(input)}`);
      return callTool();
    },
    afterCall: () => {},
  });
  return { handler, calls };
}

test("runs the documented search → describe → call workflow in TypeScript", async () => {
  const { handler, calls } = handlerFor();
  const result = await runInSandbox(
    `
    const { items } = await tools.search({ query: "issues" });
    const path: string = items[0]?.path;
    const details = await tools.describe.tool({ path });
    const result = await tools[path]({ repo: "a/b" });
    return { path, schema: details.inputSchema.type, count: result.items.length };
    `,
    handler,
  );
  assert.deepEqual(result, { ok: true, value: { path: "github.list_issues", schema: "object", count: 3 }, logs: [] });
  assert.deepEqual(calls, ['github.list_issues:{"repo":"a/b"}']);
});

test("dotted property access and bracket access reach the same tool; calls can run concurrently", async () => {
  const { handler, calls } = handlerFor();
  const result = await runInSandbox(
    `const [a, b] = await Promise.all([tools.github.create_issue({ t: 1 }), tools["stripe.create_refund"]()]);
     return [a.items.length, b.items.length];`,
    handler,
  );
  assert.deepEqual(result.ok && result.value, [3, 3]);
  assert.deepEqual(calls.sort(), ['github.create_issue:{"t":1}', "stripe.create_refund:{}"]);
});

test("the sandbox exposes no host capabilities", async () => {
  const { handler } = handlerFor();
  const result = await runInSandbox(
    `return [typeof process, typeof require, typeof fetch, typeof setTimeout, typeof __host,
             typeof (function(){ return this })().process];`,
    handler,
  );
  assert.deepEqual(result.ok && result.value, ["undefined", "undefined", "undefined", "undefined", "undefined", "undefined"]);
});

test("a tool failure surfaces as a catchable Error with the translated message only", async () => {
  const handler = createCodeModeHandler({
    tools,
    beforeCall: async () => {},
    callTool: async () => ({ ok: false as const, error: "The integration returned an error" }),
    afterCall: () => {},
  });
  const result = await runInSandbox(
    `try { await tools["github.list_issues"]({}); } catch (e) { return e.message; }`,
    handler,
  );
  assert.deepEqual(result.ok && result.value, "The integration returned an error");
});

test("a host exception's text never reaches the snippet", async () => {
  const result = await runInSandbox(`try { await tools.x.y(); } catch (e) { return e.message; }`, async () => {
    throw new Error("postgres://user:hunter2@internal-host/db");
  });
  assert.deepEqual(result.ok && result.value, "Tool call failed");
});

test("a refused call (rate limit) reaches the snippet as its own message", async () => {
  const handler = createCodeModeHandler({
    tools,
    beforeCall: async () => {
      throw new SandboxToolError("Rate limit exceeded");
    },
    callTool: async () => ({ ok: true as const, text: "{}" }),
    afterCall: () => {},
  });
  const result = await runInSandbox(`await tools["github.list_issues"]({});`, handler);
  assert.deepEqual(result, { ok: false, error: "Error: Rate limit exceeded", logs: [] });
});

test("unknown tool paths are refused without dispatching", async () => {
  const { handler, calls } = handlerFor();
  const result = await runInSandbox(`return await tools["nope.nothing"]({});`, handler);
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.error : "", /Unknown tool: nope\.nothing/);
  assert.deepEqual(calls, []);
});

test("a synchronous infinite loop is interrupted", async () => {
  const { handler } = handlerFor();
  const started = Date.now();
  const result = await runInSandbox(`while (true) {}`, handler, { ...DEFAULT_SANDBOX_LIMITS, timeoutMs: 300 });
  assert.deepEqual(result, { ok: false, error: "Execution timed out", logs: [] });
  assert.ok(Date.now() - started < 3000);
});

test("a snippet stuck awaiting a tool is timed out, and the sandbox still works afterwards", async () => {
  const never: Promise<unknown> = new Promise(() => {});
  const result = await runInSandbox(`await tools.a.b(); return 1;`, async () => never, {
    ...DEFAULT_SANDBOX_LIMITS,
    timeoutMs: 200,
  });
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.error : "", /timed out/);
  const again = await runInSandbox(`return 2;`, async () => null);
  assert.deepEqual(again, { ok: true, value: 2, logs: [] });
});

test("memory and tool-call budgets are enforced", async () => {
  const { handler } = handlerFor();
  const oom = await runInSandbox(`const a = []; while (true) a.push({ i: a.length, v: [1, 2, 3] });`, handler, {
    ...DEFAULT_SANDBOX_LIMITS,
    memoryBytes: 8 * 1024 * 1024,
  });
  assert.deepEqual(oom, { ok: false, error: "InternalError: out of memory", logs: [] });

  const fanout = await runInSandbox(
    `for (let i = 0; i < 10; i++) await tools["github.list_issues"]({});`,
    handler,
    { ...DEFAULT_SANDBOX_LIMITS, maxHostCalls: 3 },
  );
  assert.equal(fanout.ok, false);
  assert.match(!fanout.ok ? fanout.error : "", /Too many tool calls/);
});

test("oversized results are refused with a hint; console output is captured", async () => {
  const result = await runInSandbox(`console.log("hi", { a: 1 }); return "x".repeat(200000);`, async () => null);
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.error : "", /too large/);
  assert.deepEqual(result.logs, ['hi {"a":1}']);
});

test("syntax errors are reported, not thrown", async () => {
  const result = await runInSandbox(`const = ;`, async () => null);
  assert.equal(result.ok, false);
});

test("the execute tool lists connection prefixes, not tools", () => {
  const many = Array.from({ length: 1600 }, (_, i) => ({
    ...tools[0],
    fullName: `${["github", "stripe", "jira", "sentry"][i % 4]}.tool_${i}`,
    integrationName: ["GitHub", "Stripe", "Jira", "Sentry"][i % 4],
  }));
  const tool = buildExecuteTool(many);
  assert.equal(tool.name, "execute");
  assert.match(tool.description, /- github: GitHub \(400 tools\)/);
  assert.match(tool.description, /- sentry: Sentry \(400 tools\)/);
  assert.ok(tool.description.length < 2000, "description must not grow with tool count");
});

test("search ranks by name, honours prefix and caps results", () => {
  assert.equal(searchTools(tools, { query: "refund" }).items[0].path, "stripe.create_refund");
  assert.deepEqual(
    searchTools(tools, { query: "issue", prefix: "github" }).items.map((i) => i.path).sort(),
    ["github.create_issue", "github.list_issues"],
  );
  assert.equal(searchTools(tools, { query: "", limit: 1 }).items.length, 1);
  assert.equal(searchTools(tools, { query: "", limit: 1000 }).total, 3);
});
