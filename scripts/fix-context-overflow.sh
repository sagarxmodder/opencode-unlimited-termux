#!/data/data/com.termux/files/usr/bin/bash
# Fix "Your request resulted in more tokens than this model's maximum context
# length allows" on the free lane.
#
# Two changes, both needed:
#   1. Install opencode v2.3.0 (bionic build). It catches the provider's
#      context-overflow error, compacts the session, and retries instead of
#      aborting the turn.
#   2. Clamp the free model's context limit in ~/.config/opencode so proactive
#      compaction fires before the gateway rejects the request (upstream
#      enforces a smaller window than models.dev advertises).
#
# Idempotent. Old binary stays as $PREFIX/bin/opencode.bak.1.19.5 (or .bak.v2).
set -euo pipefail

VERSION="2.3.0"
SHA256="8d0352e55539858ddf33f5c57d54609008c29f3f507d0dbc2d521e8b4c07717d"
URL="https://github.com/bd-loser/opencode-bionic/releases/download/v${VERSION}/opencode"
PREFIX_BIN="${PREFIX:-/data/data/com.termux/files/usr}/bin"
TARGET="$PREFIX_BIN/opencode-${VERSION}"
CFG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
CFG="$CFG_DIR/opencode.jsonc"

say() { printf '  %s\n' "$*"; }

say "target  $TARGET"

if [ -x "$TARGET" ] && [ "$("$TARGET" --version 2>/dev/null | grep -c "$VERSION")" -ge 1 ]; then
  say "v$VERSION already installed"
else
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/oc${VERSION}.XXXXXX")"
  trap 'rm -rf "$tmp"' EXIT
  say "downloading v$VERSION (209 MB) …"
  if ! curl -fsSL --noproxy '*' -m 900 -o "$tmp/opencode" "$URL"; then
    say "direct download failed, retrying through the lane proxy"
    curl -fsSL -m 900 -o "$tmp/opencode" "$URL"
  fi
  got="$(sha256sum "$tmp/opencode" | cut -d' ' -f1)"
  if [ "$got" != "$SHA256" ]; then
    echo "[x] checksum mismatch: $got" >&2
    exit 1
  fi
  if [ -x "$PREFIX_BIN/opencode" ] && [ ! -e "$PREFIX_BIN/opencode.bak.v1" ]; then
    cp "$PREFIX_BIN/opencode" "$PREFIX_BIN/opencode.bak.v1" || true
  fi
  install -m 755 "$tmp/opencode" "$TARGET"
  say "installed $("$TARGET" --version)"
fi

mkdir -p "$CFG_DIR"
if [ -f "$CFG" ]; then
  cp "$CFG" "$CFG.bak.$(date +%Y%m%d-%H%M%S)"
fi

node - "$CFG" <<'NODE'
const { writeFileSync, readFileSync, existsSync } = require("node:fs")
const file = process.argv[2]

const strip = (text) => {
  let out = ""
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const next = text[i + 1]
    if (inString) {
      out += c
      if (escaped) escaped = false
      else if (c === "\\") escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      continue
    }
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++
      out += "\n"
      continue
    }
    if (c === "/" && next === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i++
      continue
    }
    out += c
  }
  return out.replace(/,\s*([}\]])/g, "$1")
}

let existing = {}
if (existsSync(file)) {
  const raw = readFileSync(file, "utf8")
  const body = strip(raw).trim()
  if (body) {
    try {
      existing = JSON.parse(body)
    } catch {
      console.error("existing config is not valid JSONC; leaving it alone")
      process.exit(1)
    }
  }
}

const config = {
  ...existing,
  $schema: existing.$schema ?? "https://opencode.ai/config.json",
  compaction: {
    ...(existing.compaction ?? {}),
    auto: true,
    prune: true,
    // Small head keeps the summary request itself under the gateway cap.
    buffer: 4000,
    keep: { tokens: 2000 }
  },
  provider: {
    ...(existing.provider ?? {}),
    opencode: {
      ...((existing.provider ?? {}).opencode ?? {}),
      models: {
        ...(((existing.provider ?? {}).opencode ?? {}).models ?? {}),
        "deepseek-v4.1-flash-free": {
          ...((((existing.provider ?? {}).opencode ?? {}).models ?? {})["deepseek-v4.1-flash-free"] ?? {}),
          limit: { context: 60000, output: 8000 }
        }
      }
    }
  }
}

writeFileSync(file, JSON.stringify(config, null, 2) + "\n")
console.log(`  wrote ${file}`)
NODE

say "done — restart opencode (or press r in the launcher) to pick up v$VERSION"
say "rollback: cp $PREFIX_BIN/opencode.bak.v1 $PREFIX_BIN/opencode-2.3.0"
