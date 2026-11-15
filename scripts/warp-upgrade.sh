#!/data/data/com.termux/files/usr/bin/bash
# Check GitHub for a newer warp-minimal release and upgrade safely.
set -u

DEST="${OUC_WARP_DEST:-$HOME/.local/share/opencode-unlimited-warp}"
PKG_DIR="${OUC_PKG_DIR:-/storage/emulated/0/opencode-unlimited-termux}"
BIN="$DEST/bin/warp-minimal"
REPO="Deury08/warp-minimal"
API="https://api.github.com/repos/$REPO/releases/latest"

if [ -t 1 ]; then
  CG=$'\033[38;5;46m'; CY=$'\033[38;5;226m'; CR=$'\033[38;5;203m'; CD=$'\033[2m'; C0=$'\033[0m'
else
  CG=""; CY=""; CR=""; CD=""; C0=""
fi
ok()   { printf '        %s✓%s %s\n' "$CG" "$C0" "$*"; }
warn() { printf '        %s!%s %s\n' "$CY" "$C0" "$*"; }
bad()  { printf '        %s✗%s %s\n' "$CR" "$C0" "$*"; }

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

printf '\n   %sCHECK UPDATES%s  %s·  warp-minimal%s\n\n' "$CD" "$C0" "$CD" "$C0"

CURRENT="$("$BIN" -version 2>/dev/null | awk '{print $2}')"
[ -n "$CURRENT" ] || CURRENT="unknown"

LATEST="$(curl -fsSL --noproxy '*' -m 20 -H 'User-Agent: opencode-unlimited' "$API" 2>/dev/null \
  | python3 -c 'import json,sys;print(json.load(sys.stdin).get("tag_name",""))' 2>/dev/null)"
if [ -z "$LATEST" ]; then
  bad "GitHub release check fail (network/rate limit)"
  exit 1
fi

ok "installed: ${CURRENT}"
ok "latest:    ${LATEST}"

if [ "$CURRENT" = "$LATEST" ]; then
  ok "already latest"
  exit 0
fi

HIGHER="$(printf '%s\n%s\n' "$CURRENT" "$LATEST" | sort -V 2>/dev/null | tail -n1)"
if [ "$HIGHER" = "$CURRENT" ] && [ "$CURRENT" != "unknown" ]; then
  ok "installed version is newer — nothing to do"
  exit 0
fi

if [ "$CHECK_ONLY" = 1 ]; then
  warn "update available: $CURRENT → $LATEST"
  exit 0
fi

TMP="$(mktemp -d "${TMPDIR:-/data/data/com.termux/files/usr/tmp}/warp-upgrade.XXXXXX")" || exit 1
trap 'rm -rf "$TMP"' EXIT

URL="https://github.com/$REPO/releases/download/$LATEST/warp-minimal_${LATEST}_linux_arm64.tar.gz"
SUMURL="https://github.com/$REPO/releases/download/$LATEST/checksums.txt"

printf '        %s…%s downloading %s ' "$CD" "$C0" "$LATEST"
if ! curl -fsSL --noproxy '*' -m 180 "$URL" -o "$TMP/wm.tar.gz"; then
  printf '\n'; bad "download fail: $URL"; exit 1
fi
printf 'ok\n'

if curl -fsSL --noproxy '*' -m 60 "$SUMURL" -o "$TMP/checksums.txt" 2>/dev/null; then
  EXPECT="$(grep 'linux_arm64.tar.gz' "$TMP/checksums.txt" | awk '{print $1}' | head -n1)"
  ACTUAL="$(sha256sum "$TMP/wm.tar.gz" | awk '{print $1}')"
  if [ -n "$EXPECT" ] && [ "$EXPECT" = "$ACTUAL" ]; then
    ok "checksum verified"
  else
    bad "checksum mismatch — abort"
    exit 1
  fi
else
  warn "checksums.txt nahi mila — checksum skip"
fi

tar -xzf "$TMP/wm.tar.gz" -C "$TMP" || { bad "extract fail"; exit 1; }
NEW="$(find "$TMP" -type f -name warp-minimal | head -n1)"
[ -n "$NEW" ] || { bad "binary archive mein nahi mila"; exit 1; }

BACKUP="$DEST/bin/warp-minimal.bak.$(date +%Y%m%d-%H%M%S)"
cp "$BIN" "$BACKUP" 2>/dev/null || true

bash "$DEST/scripts/warp-stop.sh" >/dev/null 2>&1 || true
cp "$NEW" "$BIN" && chmod 700 "$BIN" || { bad "replace fail"; exit 1; }
sha256sum "$BIN" > "$DEST/bin/warp-minimal.sha256" 2>/dev/null || true

printf '        %s…%s starting upgraded daemon ' "$CD" "$C0"
if ! bash "$DEST/scripts/warp-start.sh" >/dev/null 2>&1; then
  printf '\n'
  bad "upgraded binary start fail — rollback"
  cp "$BACKUP" "$BIN" 2>/dev/null
  chmod 700 "$BIN" 2>/dev/null
  bash "$DEST/scripts/warp-start.sh" >/dev/null 2>&1 || true
  exit 1
fi
printf 'ok\n'

TRACE="$(curl -sS --noproxy "" -m 15 -x "http://127.0.0.1:8789" https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null)"
if printf '%s\n' "$TRACE" | grep -q '^warp=on$'; then
  ok "upgraded to $LATEST · warp=on"
else
  warn "binary upgraded but egress trace unexpected"
fi

# keep the /sdcard distribution copy in sync when writable
if [ -d "$PKG_DIR/bin" ]; then
  if cp "$BIN" "$PKG_DIR/bin/warp-minimal" 2>/dev/null; then
    (cd "$PKG_DIR" && sha256sum bin/warp-minimal > bin/warp-minimal.sha256) 2>/dev/null || true
    ok "package copy updated"
  fi
fi
