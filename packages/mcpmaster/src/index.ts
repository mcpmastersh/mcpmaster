#!/usr/bin/env node
import { main } from "./cli.ts";

// The code-mode sandbox uses node:module's stripTypeScriptTypes to accept
// TypeScript snippets. Node flags it experimental on every call; that warning
// is noise to a person and, on `mcpmaster mcp`, clutter in an agent's server
// log. Every other warning still prints.
const emitWarning = process.emitWarning.bind(process) as (...args: unknown[]) => void;
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning?.message ?? "";
  if (text.includes("stripTypeScriptTypes")) return;
  emitWarning(warning, ...rest);
}) as typeof process.emitWarning;

void main(process.argv.slice(2));
