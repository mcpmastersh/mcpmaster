# Changelog

All notable changes to `mcpmaster` are listed here, newest first. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

## [Unreleased]

## [0.3.3] - 2026-09-29

### Changed

- The command cheat sheet covers every day-to-day command (tools, policy,
  sync, login, settings, update and more), not just the first eight.
- The command cheat sheet is at the top of the Connect page, open by default, and
  the sidebar shows how many integrations need attention.
- A new logo: a bold M whose strokes meet in one node, clearer at favicon size.

## [0.3.2] - 2026-09-29

### Added

- `mcpmaster update` upgrades an install in place, with troubleshooting for
  `EEXIST` and stale-version errors.
- A curl installer (`install.sh`), an agent setup prompt and an agent skill.
- The local UI has a numbered first-run guide with samples, expected results
  and a command cheat sheet.

### Changed

- Long tool descriptions in the local UI wrap, with a "Show more" toggle shown
  only when the text is actually cut off, and the exposure switch stays pinned
  in view.

## [0.3.1] - 2026-09-28

### Added

- OAuth2 sign-in sends the RFC 8707 resource indicator.

### Changed

- The local UI always asks you to choose a URL's type instead of offering
  "Detect automatically".

## [0.3.0] - 2026-09-28

### Added

- An OAuth2 client is registered dynamically when no client ID is given.

## [0.1.0] - 2026-09-24

First public release.

### Added

- One local MCP endpoint (stdio and HTTP) for OpenAPI, GraphQL and MCP
  integrations, with a local web UI to manage them.
- Code mode: one `execute` tool by default, running in a WASM sandbox.
- Tool blocking: rules, a read-only mode and review of newly discovered tools.
- OAuth2 with your own client (client credentials, or authorization code with
  PKCE), and endpoint discovery from the provider's published metadata.
- Server-side paged tool listing and bulk actions in the local UI.
