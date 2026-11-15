#!/bin/bash
# Opencode Unlimited Usage — Termux-adapted installer
# Made by @ItzSagarOp
# Source: https://github.com/sagarxmodder/opencode-unlimited-termux
set -u

BRAND="opencode-unlimited"
DEST="$HOME/.local/share/$BRAND"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KOPIER="$SCRIPT_DIR"

say(){ echo -e "  $*"; }
ok(){ echo -e "  ✓ $*"; }
bad(){ echo -e "  ✗ $*"; }
die(){ bad "$*"; exit 1; }

echo ""
echo "  ============================="
echo "  Opencode Unlimited Usage — Termux"
echo "  ============================="
echo ""

command -v opencode >/dev/null 2>&1 || die "opencode not found"
[ -e /dev/net/tun ] || die "/dev/net/tun missing"
command -v unshare >/dev/null 2>&1 || die "unshare missing"
command -v python3 >/dev/null 2>&1 || die "python3 required"
command -v curl >/dev/null 2>&1 || die "curl required"

WARP=""
if command -v warp-cli >/dev/null 2>&1; then WARP="$(command -v warp-cli)"; fi
if [ -z "$WARP" ] && [ -x "$HOME/.local/bin/warp-cli" ]; then WARP="$HOME/.local/bin/warp-cli"; fi
if [ -n "$WARP" ]; then
  ok "warp-cli found: $WARP"
else
  say "warp-cli not found — manual placement required (Cloudflare static build); skipping"
fi

ok "opencode present"
ok "unshare present"
ok "/dev/net/tun present"
ok "python3 present"
ok "curl present"

say "Termux-adapted: no systemd, running processes as plain background jobs"
say "DEST=$DEST"
say "SHIM=$HOME/.local/bin/opencode"
say "SCRIPTS=$KOPIER/scripts"

echo "  ok — Termux-adapted installer stage reached checks OK"
echo "  NOTE: full self-heal/keeper/guard logic still needs Termux background-runner wiring"
echo "  NOTE: WARP tunnel login (warp-cli register/login) is external prerequisite"

exit 0
