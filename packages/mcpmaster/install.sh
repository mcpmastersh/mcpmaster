#!/bin/sh
# mcpmaster installer — connect your agents to anything.
#
#   curl -fsSL https://raw.githubusercontent.com/mcpmastersh/mcpmaster/main/install.sh | sh
#
# Downloads the single-file mcpmaster build from the npm registry (no npm
# install, no dependencies to resolve), puts a `mcpmaster` command on your
# PATH, and starts it in the background with the web UI. Running it again
# upgrades: it always fetches the newest published version (no npm cache in
# the way), restarts the background server, and keeps your integrations.
#
# Environment:
#   MCPMASTER_VERSION     version to install (default: latest)
#   MCPMASTER_INSTALL_DIR where the command goes (default: ~/.local/bin)
#   MCPMASTER_HOME        state directory (default: ~/.mcpmaster)
#   MCPMASTER_NO_START=1  install only, don't start the background server
#   MCPMASTER_CONNECT=1   also register mcpmaster with Claude Code / Codex if installed
#   MCPMASTER_SKILL=1     also save the agent skill to ~/.claude/skills/mcpmaster (Claude Code)

set -eu

say() { printf '  %s\n' "$*" >&2; }
fail() { printf '  x %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "mcpmaster needs Node.js 20 or later — install it from https://nodejs.org and run this again."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || fail "mcpmaster needs Node.js 20 or later (found $(node --version))."
command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v tar >/dev/null 2>&1 || fail "tar is required."

VERSION="${MCPMASTER_VERSION:-latest}"
HOME_DIR="${MCPMASTER_HOME:-$HOME/.mcpmaster}"
BIN_DIR="${MCPMASTER_INSTALL_DIR:-$HOME/.local/bin}"
REGISTRY="${MCPMASTER_REGISTRY:-https://registry.npmjs.org}"

PREVIOUS=""
PREVIOUS_BIN="$BIN_DIR/mcpmaster"
if [ -x "$BIN_DIR/mcpmaster" ]; then PREVIOUS=$("$BIN_DIR/mcpmaster" --version 2>/dev/null || true); fi

say "Installing mcpmaster ($VERSION)…"

TARBALL=$(curl -fsSL "$REGISTRY/mcpmaster/$VERSION" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s);if(!m.dist||!m.dist.tarball)process.exit(1);process.stdout.write(m.dist.tarball)})') \
  || fail "Couldn't find mcpmaster $VERSION on the npm registry."

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$TARBALL" -o "$TMP/pkg.tgz" || fail "Download failed — check your connection and try again."
tar -xzf "$TMP/pkg.tgz" -C "$TMP"
[ -f "$TMP/package/dist/mcpmaster.mjs" ] || fail "That package doesn't contain the mcpmaster build."

umask 077
mkdir -p "$HOME_DIR/bin"
umask 022
mkdir -p "$BIN_DIR"
cp "$TMP/package/dist/mcpmaster.mjs" "$HOME_DIR/bin/mcpmaster.mjs"

# Replace the file, never write through it: an earlier `npm i -g` may have left
# a symlink here that points into npm's own package directory.
rm -f "$BIN_DIR/mcpmaster"
cat > "$BIN_DIR/mcpmaster" <<WRAPPER
#!/bin/sh
exec node "$HOME_DIR/bin/mcpmaster.mjs" "\$@"
WRAPPER
chmod +x "$BIN_DIR/mcpmaster"

CURRENT=$("$BIN_DIR/mcpmaster" --version)
if [ -z "$PREVIOUS" ]; then
  say "+ Installed mcpmaster $CURRENT to $BIN_DIR/mcpmaster"
elif [ "$PREVIOUS" = "$CURRENT" ]; then
  say "+ mcpmaster $CURRENT is already the newest version"
else
  say "+ Upgraded mcpmaster $PREVIOUS -> $CURRENT (your integrations are kept)"
  # A server started by the old version keeps running the old code.
  "$PREVIOUS_BIN" stop >/dev/null 2>&1 || true
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "! $BIN_DIR isn't on your PATH — add this to your shell profile:"
     say "    export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

# Another mcpmaster earlier on the PATH (npm -g, pnpm, Homebrew) would keep answering.
FIRST=$(command -v mcpmaster 2>/dev/null || true)
if [ -n "$FIRST" ] && [ "$FIRST" != "$BIN_DIR/mcpmaster" ]; then
  say "! A different mcpmaster answers first: $FIRST"
  say "  Remove it, or run the one just installed: $BIN_DIR/mcpmaster"
fi

if [ "${MCPMASTER_SKILL:-0}" = "1" ]; then
  if [ -f "$TMP/package/skills/mcpmaster/SKILL.md" ]; then
    mkdir -p "$HOME/.claude/skills/mcpmaster"
    cp "$TMP/package/skills/mcpmaster/SKILL.md" "$HOME/.claude/skills/mcpmaster/SKILL.md"
    say "+ Saved the agent skill to ~/.claude/skills/mcpmaster/SKILL.md"
  else
    say "! This version doesn't ship an agent skill."
  fi
fi

if [ "${MCPMASTER_CONNECT:-0}" = "1" ]; then
  if command -v claude >/dev/null 2>&1; then
    claude mcp add mcpmaster -- "$BIN_DIR/mcpmaster" mcp >/dev/null 2>&1 && say "+ Connected to Claude Code" || say "! Couldn't register with Claude Code (already added?)"
  fi
  if command -v codex >/dev/null 2>&1; then
    codex mcp add mcpmaster -- "$BIN_DIR/mcpmaster" mcp >/dev/null 2>&1 && say "+ Connected to Codex" || say "! Couldn't register with Codex (already added?)"
  fi
fi

if [ "${MCPMASTER_NO_START:-0}" != "1" ]; then
  "$BIN_DIR/mcpmaster" up || say "! Couldn't start it now — run: mcpmaster up"
else
  say ""
  say "-> mcpmaster up        start it and open the web UI"
fi
say "-> mcpmaster connect   hook up your agent"
