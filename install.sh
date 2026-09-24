#!/bin/sh
# mcpmaster installer — connect your agents to anything.
#
#   curl -fsSL https://raw.githubusercontent.com/mcpmastersh/mcpmaster/main/install.sh | sh
#
# Downloads the single-file mcpmaster build from the npm registry (no npm
# install, no dependencies to resolve), puts a `mcpmaster` command on your
# PATH, and starts it in the background with the web UI.
#
# Environment:
#   MCPMASTER_VERSION     version to install (default: latest)
#   MCPMASTER_INSTALL_DIR where the command goes (default: ~/.local/bin)
#   MCPMASTER_HOME        state directory (default: ~/.mcpmaster)
#   MCPMASTER_NO_START=1  install only, don't start the background server
#   MCPMASTER_CONNECT=1   also register mcpmaster with Claude Code / Codex if installed

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

cat > "$BIN_DIR/mcpmaster" <<WRAPPER
#!/bin/sh
exec node "$HOME_DIR/bin/mcpmaster.mjs" "\$@"
WRAPPER
chmod +x "$BIN_DIR/mcpmaster"

say "+ Installed $("$BIN_DIR/mcpmaster" --version) to $BIN_DIR/mcpmaster"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "! $BIN_DIR isn't on your PATH — add this to your shell profile:"
     say "    export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

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
