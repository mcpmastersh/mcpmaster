---
name: mcpmaster
description: Use when the user wants to connect an API, a GraphQL endpoint or an MCP server to their agents, when an MCP server called `mcpmaster` is connected, or when a task needs a tool that is not in the current tool list. Explains the one-endpoint model, code mode, and how credentials are handled.
---

# One MCP endpoint for every tool: mcpmaster

The user runs `mcpmaster` locally. Every API and MCP server they add is served
through one endpoint, `http://127.0.0.1:7437/mcp`, so every agent uses the same
tools with one config.

## Code mode: why you see one tool

The endpoint advertises a single `execute` tool instead of hundreds of
schemas, so your context holds one tool, not every integration's full list.
Inside the snippet you pass to it, search for the tool you need, call it, and
return only what matters. Do not ask for the full flat list to be enabled; it
costs the user tokens on every message.

## Commands

```
mcpmaster status                          # is it running?
mcpmaster up                              # start it (background) and open the web UI
mcpmaster stop                            # stop it
mcpmaster list                            # connected integrations
mcpmaster tools --limit 20                # a sample of the tools they provide
mcpmaster add <openapi-url-or-file> --name <slug>
mcpmaster add <graphql-url> --type graphql --name <slug>
mcpmaster add <remote-mcp-url> --type mcp --name <slug>
mcpmaster add -- <local stdio MCP command>
mcpmaster connect                         # client config snippets
```

## Credentials: used, never shown

- API keys and tokens for integrations are stored locally with owner-only
  permissions and are never displayed — not in the web UI, not in the CLI —
  and they are stripped from any response before you see it.
- Pass a credential by variable name (`--token-env GITHUB_TOKEN`) or on stdin
  (`--token-stdin`), never as an argument, and never ask the user to paste one
  into the chat.
- The web UI and the endpoint listen on 127.0.0.1 and require the local token.
  It belongs in a client config file, not in a message.
- Calls to private or local-network addresses are blocked by default so an
  integration cannot be pointed at something on this machine. Enabling it is
  the user's decision: ask, and explain why, before suggesting it.

## Upgrading

An upgrade that "did nothing" is nearly always a stale npm cache, an older copy
earlier on the PATH, or a running server that was never restarted. If
`npm i -g` fails with EEXIST, the curl installer already owns that path: use
`mcpmaster update` instead of npm. In order:

```
mcpmaster --version                                  # what actually runs today
which -a mcpmaster                                   # every copy that could answer
mcpmaster update                                     # newest version, straight from the registry
npm i -g mcpmaster@latest --prefer-online            # or via npm, bypassing the cached answer
mcpmaster stop && mcpmaster up                       # the old server keeps running until restarted
mcpmaster --version                                  # confirm it changed
```

Integrations and credentials are kept across an upgrade. If the version is
unchanged, a second copy is earlier on the PATH: tell the user which one.

## Rules

- Run `mcpmaster --help` before using a flag you have not seen here. Do not guess.
- If a command fails, quote what it printed and suggest the next step; do not
  retry with invented flags.
