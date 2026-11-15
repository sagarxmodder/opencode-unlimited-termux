#!/data/data/com.termux/files/usr/bin/bash
# opencode-unlimited warp lane — Termux installer
#
# Installs a no-root, no-systemd, no-TUN lane:
#   opencode -> localhost HTTP proxy -> warp-minimal (Cloudflare WARP MASQUE)
#
# Files stay on /sdcard as the distribution copy; runtime lives in
# ~/.local/share/opencode-unlimited-warp.
set -u

SRC="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
DEST="${OUC_WARP_DEST:-$HOME/.local/share/opencode-unlimited-warp}"
PROXY="http://127.0.0.1:8789"
NO_OPENCODE=0

for arg in "$@"; do
  case "$arg" in
    --no-opencode) NO_OPENCODE=1 ;;
    -h|--help) echo "usage: bash install-warp-lane.sh [--no-opencode]"; exit 0 ;;
  esac
done

if [ -t 1 ]; then
  C0=$'\033[0m'; CB=$'\033[1m'; CD=$'\033[2m'
  CC=$'\033[38;5;51m'; CG=$'\033[38;5;46m'; CY=$'\033[38;5;226m'
  CR=$'\033[38;5;203m'; CGY=$'\033[38;5;245m'
else
  C0=""; CB=""; CD=""; CC=""; CG=""; CY=""; CR=""; CGY=""
fi

STEP=0
section() {
  STEP=$((STEP + 1))
  printf '\n  %s[%d/6]%s %s%s%s\n' "$CC" "$STEP" "$C0" "$CB" "$*" "$C0"
}
ok()   { printf '        %s✓%s %s\n' "$CG" "$C0" "$*"; }
warn() { printf '        %s!%s %s\n' "$CY" "$C0" "$*"; }
bad()  { printf '        %s✗%s %s\n' "$CR" "$C0" "$*"; }
say()  { printf '        %s\n' "$*"; }
die()  { bad "$*"; printf '\n'; exit 1; }

banner() {
  printf '\n'
  printf '  %s╭──────────────────────────────────────────────╮%s\n' "$CC" "$C0"
  printf '    %sOPENCODE UNLIMITED%s  %s·  WARP LANE%s\n' "$CB" "$C0" "$CGY" "$C0"
  printf '    Termux / no-root                 %s@ItzSagarOp%s\n' "$CD" "$C0"
  printf '  %s╰──────────────────────────────────────────────╯%s\n' "$CC" "$C0"
  printf '    %sinstaller%s\n' "$CD" "$C0"
}

banner

# ---------------------------------------------------------------- 1. env
section "Environment"
case "$(uname -m 2>/dev/null)" in
  aarch64|arm64) ok "architecture: $(uname -m)" ;;
  *) die "this build is arm64 only (device: $(uname -m 2>/dev/null))" ;;
esac

if [ -n "${PREFIX:-}" ]; then
  case "$PREFIX" in
    *com.termux*) ok "Termux prefix: $PREFIX" ;;
    *) warn "non-Termux prefix: $PREFIX" ;;
  esac
else
  warn "PREFIX not set — Termux ke bahar ho?"
fi

command -v python3 >/dev/null 2>&1 || die "python3 chahiye: pkg install python"
command -v curl    >/dev/null 2>&1 || die "curl chahiye: pkg install curl"
ok "python3 + curl present"

if ! command -v proot >/dev/null 2>&1; then
  say "proot install kar raha hoon..."
  if command -v pkg >/dev/null 2>&1; then
    pkg install -y proot >/dev/null 2>&1 || die "proot install fail — 'pkg install proot' chalao"
  else
    die "proot missing — manually install karo"
  fi
fi
ok "proot: $(command -v proot)"

CERT="${PREFIX:-/data/data/com.termux/files/usr}/etc/tls/cert.pem"
if [ -s "$CERT" ]; then
  ok "CA bundle present"
else
  warn "CA bundle missing — 'pkg install ca-certificates'"
fi

# ---------------------------------------------------------------- 2. opencode
section "opencode"
REAL=""
for c in /data/data/com.termux/files/usr/bin/opencode \
         "${PREFIX:-/data/data/com.termux/files/usr}/bin/opencode" \
         "$HOME/.opencode/bin/opencode"; do
  [ -x "$c" ] && REAL="$c" && break
done

if [ -z "$REAL" ] && [ "$NO_OPENCODE" = 0 ]; then
  warn "opencode install nahi hai — auto-install try kar raha hoon"
  if [ -x "$SRC/scripts/install-opencode.sh" ]; then
    bash "$SRC/scripts/install-opencode.sh" || true
  fi
  for c in /data/data/com.termux/files/usr/bin/opencode \
           "${PREFIX:-/data/data/com.termux/files/usr}/bin/opencode" \
           "$HOME/.opencode/bin/opencode"; do
    [ -x "$c" ] && REAL="$c" && break
  done
fi

if [ -z "$REAL" ]; then
  warn "opencode install nahi hai"
  printf '\n'
  sed 's/^/      /' "$SRC/docs/OPENCODE-INSTALL.md" 2>/dev/null | head -n 30
  printf '\n'
  if [ "$NO_OPENCODE" = 0 ]; then
    die "opencode install fail — docs dekho, ya: bash install-warp-lane.sh --no-opencode"
  fi
  warn "components install ho rahe hain bina opencode ke (--no-opencode)"
else
  ok "opencode: $("$REAL" --version 2>/dev/null | head -n1)  ($REAL)"
fi

# ---------------------------------------------------------------- 3. files
section "Runtime files"
if [ -f "$SRC/bin/warp-minimal.sha256" ]; then
  if CHECK_OUT=$(cd "$SRC" && sha256sum -c bin/warp-minimal.sha256 2>&1); then
    ok "binary checksum verified"
  else
    say "$CHECK_OUT"
    die "warp-minimal checksum mismatch — file corrupt"
  fi
else
  warn "checksum file missing — verify skipped"
fi

mkdir -p "$DEST"/{bin,scripts,etc,logs,run,guard,plugin}
cp "$SRC/bin/warp-minimal" "$DEST/bin/warp-minimal"
cp "$SRC/bin/opencode-shim" "$DEST/bin/opencode-shim"
cp "$SRC/scripts/"*.sh "$DEST/scripts/"
[ -f "$SRC/scripts/config-util.py" ] && cp "$SRC/scripts/config-util.py" "$DEST/scripts/"
cp -r "$SRC/plugin/opencode-warp-retry" "$DEST/plugin/"
chmod 700 "$DEST/bin/warp-minimal" "$DEST/bin/opencode-shim" "$DEST/scripts/"*.sh
chmod 700 "$DEST/scripts/config-util.py" 2>/dev/null || true
ok "runtime → $DEST"

python3 - "$DEST" <<'PY'
import json, os, sys
dest = sys.argv[1]
cfg = {
    "listen": "127.0.0.1:8789",
    "pool_size": 2,
    "stack": "ipv6",
    "log_path": os.path.join(dest, "logs", "warp-minimal.log"),
}
json.dump(cfg, open(os.path.join(dest, "config.json"), "w"), indent=2)
PY

TERMUX_ETC="${PREFIX:-/data/data/com.termux/files/usr}/etc"
if [ -s "$TERMUX_ETC/resolv.conf" ]; then
  cp "$TERMUX_ETC/resolv.conf" "$DEST/etc/resolv.conf"
else
  printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > "$DEST/etc/resolv.conf"
fi
printf '127.0.0.1 localhost\n' > "$DEST/etc/hosts"
ok "config + DNS files ready"

# ---------------------------------------------------------------- 4. tunnel
section "WARP tunnel"
bash "$DEST/scripts/warp-stop.sh" >/dev/null 2>&1 || true
if ! bash "$DEST/scripts/warp-start.sh"; then
  warn "pehli koshish fail — 3s baad retry"
  sleep 3
  bash "$DEST/scripts/warp-start.sh" || die "WARP tunnel start nahi hua (logs upar)"
fi

TRACE=$(curl -sS -m 15 -x "$PROXY" https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null)
IP=$(printf '%s\n' "$TRACE" | grep '^ip=' | cut -d= -f2)
WARP=$(printf '%s\n' "$TRACE" | grep '^warp=' | cut -d= -f2)
if [ "$WARP" = "on" ]; then
  ok "egress via WARP: $IP"
else
  warn "egress trace unexpected: ${TRACE:-no answer}"
fi

# ---------------------------------------------------------------- 5. launcher
section "Launcher + PATH"
mkdir -p "$HOME/.local/bin"
if [ -f "$HOME/.local/bin/opencode" ] && ! grep -q "opencode-unlimited-warp" "$HOME/.local/bin/opencode" 2>/dev/null; then
  cp "$HOME/.local/bin/opencode" "$HOME/.local/bin/opencode.bak.$(date +%Y%m%d-%H%M%S)"
  warn "old shim backed up"
fi
cp "$DEST/bin/opencode-shim" "$HOME/.local/bin/opencode"
chmod 700 "$HOME/.local/bin/opencode"
ok "opencode → launcher menu"

for name in "opencode-unlimited-hop:$DEST/scripts/warp-hop.sh" \
            "opencode-unlimited-doctor:$DEST/scripts/warp-doctor.sh" \
            "opencode-unlimited-start:$DEST/scripts/warp-start.sh" \
            "opencode-unlimited-stop:$DEST/scripts/warp-stop.sh" \
            "oc:$DEST/scripts/menu.sh"; do
  ln -sf "${name#*:}" "$HOME/.local/bin/${name%%:*}"
done
ok "oc · hop · doctor · start · stop"

for rc in "$HOME/.bashrc" "$HOME/.profile"; do
  if ! grep -q "# opencode-unlimited-warp PATH" "$rc" 2>/dev/null; then
    [ -f "$rc" ] && cp "$rc" "$rc.bak.$(date +%Y%m%d-%H%M%S)"
    printf '\n# opencode-unlimited-warp PATH\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$rc"
    ok "PATH → ${rc/#$HOME/~}"
  else
    ok "PATH already in ${rc/#$HOME/~}"
  fi
done

# ---------------------------------------------------------------- 6. plugin
section "opencode plugin"
CFG_DIR="$HOME/.config/opencode"
find_cfg() {
  for f in "$CFG_DIR/opencode.json" "$CFG_DIR/opencode.jsonc"; do
    [ -f "$f" ] && printf '%s\n' "$f" && return 0
  done
  return 1
}
CFG_TOOL="$SRC/scripts/config-util.py"
[ -f "$CFG_TOOL" ] || CFG_TOOL="$DEST/scripts/config-util.py"
if [ -n "$REAL" ]; then
  VER=$("$REAL" --version 2>/dev/null | head -n1)
  MAJ=$(printf '%s' "$VER" | grep -oE '[0-9]+' | head -n1)
  if [ "${MAJ:-0}" -ge 2 ]; then
    PLUGIN_DIR="$HOME/.config/opencode/plugins/opencode-warp-retry"
    mkdir -p "$PLUGIN_DIR"
    cp -r "$SRC/plugin/opencode-warp-retry/." "$PLUGIN_DIR/"
    CFG="$(find_cfg || true)"
    if [ -n "$CFG" ]; then
      OUT="$(python3 "$CFG_TOOL" v2-add "$CFG" "$PLUGIN_DIR" "$PROXY" 2>&1 || true)"
      case "$OUT" in
        changed*)  ok "v2 retry plugin + config updated ($(basename "$CFG"))" ;;
        unchanged) ok "v2 retry plugin + config already set ($(basename "$CFG"))" ;;
        *)         warn "config update skipped: $OUT" ;;
      esac
    else
      warn "opencode.json/.jsonc nahi mila — plugin copy only"
    fi
  else
    PLUGINS="$HOME/.config/opencode/plugins"
    mkdir -p "$PLUGINS"
    # opencode 1.19.5 imports plugins/<dir>/index.ts but never calls it;
    # a flat .ts file is the only shape that actually runs on v1.
    rm -rf "$PLUGINS/opencode-unlimited-tokens"
    rm -f "$PLUGINS/unlimited-tokens.ts"
    cp "$SRC/plugin/opencode-unlimited-lane/index.ts" "$PLUGINS/opencode-unlimited-lane.ts"
    chmod 600 "$PLUGINS/opencode-unlimited-lane.ts"
    CFG="$(find_cfg || true)"
    if [ -n "$CFG" ]; then
      OUT="$(python3 "$CFG_TOOL" v1-compaction "$CFG" 2>&1 || true)"
      case "$OUT" in
        changed*)  ok "config updated ($(basename "$CFG")): compaction.auto on, v2-only plugins key removed" ;;
        unchanged) ok "config already set ($(basename "$CFG"))" ;;
        *)         warn "config update skipped: $OUT" ;;
      esac
      ok "v1 lane plugin (all-model quota bypass + context guard)"
    else
      warn "opencode.json/.jsonc nahi mila — plugin copy only"
    fi
    say "wall aane par plugin khud WARP rotate karke continue karta hai"
  fi
else
  warn "opencode missing — plugin skipped"
fi

date '+%Y-%m-%d %H:%M:%S' > "$DEST/INSTALLED"

# ---------------------------------------------------------------- ready
printf '\n'
printf '  %s╭──────────────────────────────────────────────╮%s\n' "$CG" "$C0"
printf '    %sREADY%s  %s·  warp lane installed%s\n' "$CB" "$C0" "$CG" "$C0"
printf '  %s╰──────────────────────────────────────────────╯%s\n' "$CG" "$C0"
printf '    %s%-26s%s %s\n' "$CB" "opencode" "$C0" "menu (1 run · 2 install)"
printf '    %s%-26s%s %s\n' "$CB" "oc" "$C0" "menu shortcut"
printf '    %s%-26s%s %s\n' "$CB" "opencode run \"...\"" "$C0" "direct lane"
printf '    %s%-26s%s %s\n' "$CB" "opencode-unlimited-hop" "$C0" "fresh WARP /64"
printf '    %s%-26s%s %s\n' "$CB" "opencode-unlimited-doctor" "$C0" "status"
printf '\n'
printf '    %snote:%s Termux band/reboot hone par pehli opencode run lane khud start karegi.\n' "$CD" "$C0"
printf '\n'
