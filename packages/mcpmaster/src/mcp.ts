// The MCP surface agents talk to. One server factory, two transports:
// stdio (`mcpmaster mcp`, what an agent launches) and Streamable HTTP
// (`/mcp` on the local web server). Both read the live config on every
// request, so an integration added in the web UI or CLI shows up in an
// already-connected agent's next tools/list.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { EXECUTE_TOOL_NAME, agentTools, callTool, executeCode, executeToolDefinition, publicInputSchema, toolMode } from "./engine.ts";
import { loadConfig } from "./store.ts";
import { VERSION } from "./version.ts";

export function createMcpServer(): Server {
  const server = new Server(
    { name: "mcpmaster", version: VERSION },
    {
      capabilities: { tools: { listChanged: false } },
      instructions:
        "mcpmaster gives you every integration this user connected. Tools are named <integration>_<tool>. " +
        "When only the `execute` tool is listed, write a short snippet that finds tools with tools.search, " +
        "reads them with tools.describe.tool and calls them as tools[path](input), returning only what you need.",
    },
  );

  // Code mode is the default: ONE `execute` tool, so an agent's context cost
  // stays flat no matter how many integrations (and thousands of tools) are
  // connected. "all" mode lists every tool for clients that can't run code.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const config = loadConfig();
    if (toolMode(config) === "execute") return { tools: [executeToolDefinition(config)] };
    return {
      tools: agentTools(config).map((tool) => ({
        name: tool.fullName,
        description: tool.description || `${tool.toolName} (${tool.source.name})`,
        inputSchema: publicInputSchema(tool.inputSchema) as { type: "object"; [key: string]: unknown },
      })),
    };
  });

  // `execute` works in both modes, and a direct call by full name works in
  // both too — it's the same path code mode uses, just not advertised.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const outcome =
      request.params.name === EXECUTE_TOOL_NAME ? await executeCode(args.code) : await callTool(request.params.name, args);
    return outcome.ok
      ? { content: [{ type: "text" as const, text: outcome.text }] }
      : { content: [{ type: "text" as const, text: outcome.error }], isError: true };
  });

  return server;
}
