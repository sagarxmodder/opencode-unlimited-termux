#!/data/data/com.termux/files/usr/bin/bash
# opencode-unlimited warp lane — Termux uninstaller
#
# Removes the lane runtime, launchers and opencode config hooks.
# opencode itself, its auth and its sessions stay untouched.
set -u

DEST="${OUC_WARP_DEST:-$HOME/.local/share/opencode-unlimited-warp}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

case "${1:-}" in
  -h|--help)
    printf '\n  opencode unlimited · warp lane uninstaller\n\n'
    printf '  usage: bash uninstall-warp-lane.sh\n\n'
    printf '  removes runtime + launchers; opencode and sessions stay.\n\n'
    exit 0
    ;;
esac

if [ -t 1 ]; then
  C0=$'\033[0m'; CB=$'\033[1m'; CD=$'\033[2m'
  CC=$'\033[38;5;51m'; CG=$'\033[38;5;46m'; CY=$'\033[38;5;226m'
  CR=$'\033[38;5;203m'; CGY=$'\033[38;5;245m'
else
  C0=""; CB=""; CD=""; CC=""; CG=""; CY=""; CR=""; CGY=""
fi

STEP=0
REMOVED=0

section() {
  STEP=$((STEP + 1))
  printf '\n  %s─[%d/4]%s %s%s%s\n' "$CY" "$STEP" "$C0" "$CB" "$*" "$C0"
}
ok()   { printf '    %s✓%s %s\n' "$CG" "$C0" "$*"; }
warn() { printf '    %s!%s %s\n' "$CY" "$C0" "$*"; }
say()  { printf '    %s%s%s\n' "$CGY" "$*" "$C0"; }

printf '\n'
printf '  %s╭────────────────────────────────────────────────────────────╮%s\n' "$CR" "$C0"
printf '    %sOPENCODE UNLIMITED%s  %s·  WARP LANE%s\n' "$CB" "$C0" "$CGY" "$C0"
printf '    Termux · no-root · no-systemd                 %s@ItzSagarOp%s\n' "$CD" "$C0"
printf '  %s╰────────────────────────────────────────────────────────────╯%s\n' "$CR" "$C0"
printf '    %suninstaller%s  %sopencode + sessions safe rahenge%s\n' "$CB" "$C0" "$CD" "$C0"

# ---------------------------------------------------------------- 1. lane
section "Stop lane"
if [ -x "$DEST/scripts/warp-stop.sh" ]; then
  bash "$DEST/scripts/warp-stop.sh" >/dev/null 2>&1 || true
  ok "warp-minimal + guard stopped"
  REMOVED=$((REMOVED + 1))
else
  say "runtime already gone — stop skipped"
fi

# ---------------------------------------------------------------- 2. launchers
section "Launchers"
for f in opencode-unlimited-hop opencode-unlimited-doctor \
         opencode-unlimited-start opencode-unlimited-stop \
         oc; do
  if [ -e "$HOME/.local/bin/$f" ] || [ -L "$HOME/.local/bin/$f" ]; then
    rm -f "$HOME/.local/bin/$f" 2>/dev/null || true
    ok "removed ~/.local/bin/$f"
    REMOVED=$((REMOVED + 1))
  fi
done

if [ -f "$HOME/.local/bin/opencode" ] && grep -q "opencode-unlimited-warp" "$HOME/.local/bin/opencode" 2>/dev/null; then
  rm -f "$HOME/.local/bin/opencode"
  hash -r 2>/dev/null || true
  stock=""
  for c in "${PREFIX:-/data/data/com.termux/files/usr}/bin/opencode" \
           /data/data/com.termux/files/usr/bin/opencode \
           "$HOME/.opencode/bin/opencode"; do
    [ -x "$c" ] && stock="$c" && break
  done
  ok "menu shim removed${stock:+ · stock opencode: $stock}"
  REMOVED=$((REMOVED + 1))
else
  say "menu shim not present"
fi

for w in "${PREFIX:-$HOME/.local}/bin/freecode" "$HOME/.local/bin/freecode"; do
  if [ -f "$w" ] && grep -qF "$DEST/freecode" "$w" 2>/dev/null; then
    rm -f "$w"
    ok "freecode wrapper removed ($w)"
    REMOVED=$((REMOVED + 1))
  fi
done

if [ -d "$DEST/freecode" ]; then
  rm -rf "$DEST/freecode"
  ok "retired freecode runtime removed"
  REMOVED=$((REMOVED + 1))
fi

# ---------------------------------------------------------------- 3. config
section "opencode config"
CFG_DIR="$HOME/.config/opencode"
CFG_TOOL="$SRC/scripts/config-util.py"
[ -f "$CFG_TOOL" ] || CFG_TOOL="$DEST/scripts/config-util.py"
find_cfg() {
  for f in "$CFG_DIR/opencode.json" "$CFG_DIR/opencode.jsonc"; do
    [ -f "$f" ] && printf '%s\n' "$f" && return 0
  done
  return 1
}

PLUGIN_DIR="$CFG_DIR/plugins/opencode-warp-retry"
if [ -d "$PLUGIN_DIR" ]; then
  rm -rf "$PLUGIN_DIR"
  CFG="$(find_cfg || true)"
  if [ -n "$CFG" ] && [ -f "$CFG_TOOL" ]; then
    OUT="$(python3 "$CFG_TOOL" v2-remove "$CFG" "$PLUGIN_DIR" 2>&1 || true)"
    ok "v2 plugin + config cleared ($(basename "$CFG"): $OUT)"
  else
    ok "v2 retry plugin removed"
  fi
  REMOVED=$((REMOVED + 1))
fi

if [ -f "$CFG_DIR/plugins/opencode-unlimited-lane.ts" ]; then
  rm -f "$CFG_DIR/plugins/opencode-unlimited-lane.ts"
  ok "v1 lane plugin removed"
  REMOVED=$((REMOVED + 1))
fi
if [ -d "$CFG_DIR/plugins/opencode-unlimited-tokens" ]; then
  rm -rf "$CFG_DIR/plugins/opencode-unlimited-tokens"
  ok "legacy plugin dir removed"
  REMOVED=$((REMOVED + 1))
fi
[ "$REMOVED" -gt 0 ] || say "no opencode hooks found"

# ---------------------------------------------------------------- 4. runtime
section "Runtime"
if [ -d "$DEST" ]; then
  rm -rf "$DEST"
  ok "removed $DEST"
  REMOVED=$((REMOVED + 1))
else
  say "runtime already gone"
fi

printf '\n'
printf '  %s╭────────────────────────────────────────────────────────────╮%s\n' "$CG" "$C0"
printf '    %sUNINSTALLED%s  %s·  runtime only%s\n' "$CB" "$C0" "$CG" "$C0"
printf '  %s╰────────────────────────────────────────────────────────────╯%s\n' "$CG" "$C0"
printf '    %s%-9s%s %s\n' "$CGY" "removed" "$C0" "$REMOVED items"
printf '    %s%-9s%s %s\n' "$CGY" "kept" "$C0" "opencode binary · auth · sessions"
printf '    %s%-9s%s %s\n' "$CGY" "reinstall" "$C0" "bash install-warp-lane.sh"
printf '    %s%-9s%s %s\n' "$CGY" "note" "$C0" "~/.bashrc PATH line reh sakta hai (harmless)"
printf '\n'
