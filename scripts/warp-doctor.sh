#!/data/data/com.termux/files/usr/bin/bash
# Doctor — what is alive and what needs attention.
set -u

DEST="${OUC_WARP_DEST:-$HOME/.local/share/opencode-unlimited-warp}"
PROXY="${OUC_WARP_PROXY:-http://127.0.0.1:8789}"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }

echo ""
echo "  ==============================="
echo "  opencode-unlimited warp — doctor"
echo "  ==============================="
echo ""

command -v proot >/dev/null 2>&1 && ok "proot present" || bad "proot missing — pkg install proot"

REAL=""
for c in /data/data/com.termux/files/usr/bin/opencode \
         "${PREFIX:-/data/data/com.termux/files/usr}/bin/opencode" \
         "$HOME/.opencode/bin/opencode"; do
  [ -x "$c" ] && REAL="$c" && break
done
if [ -n "$REAL" ]; then
  ok "opencode: $REAL ($("$REAL" --version 2>/dev/null | head -n1))"
else
  bad "opencode missing — see docs/OPENCODE-INSTALL.md"
fi

if [ -f "$HOME/.local/bin/opencode" ] && grep -q "opencode-unlimited-warp" "$HOME/.local/bin/opencode" 2>/dev/null; then
  ok "shim: ~/.local/bin/opencode -> lane"
else
  bad "shim missing/broken — rerun install-warp-lane.sh"
fi

case ":$PATH:" in
  *":$HOME/.local/bin:"*) ok "PATH includes ~/.local/bin" ;;
  *)
    if grep -q "# opencode-unlimited-warp PATH" "$HOME/.bashrc" 2>/dev/null \
       || grep -q "# opencode-unlimited-warp PATH" "$HOME/.profile" 2>/dev/null; then
      ok "PATH configured in shell rc (naye shells ke liye)"
    else
      warn "PATH missing — ~/.bashrc mein add karo ya installer dobara chalao"
    fi
    ;;
esac

if curl -s --noproxy '*' -m 2 "$PROXY/health" 2>/dev/null | grep -q '"healthy":[1-9]'; then
  HEALTH=$(curl -s --noproxy '*' -m 3 "$PROXY/health")
  ACTIVE=$(printf '%s' "$HEALTH" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("active","?"))' 2>/dev/null)
  ok "warp-minimal: healthy (active=$ACTIVE)"
else
  bad "warp-minimal not healthy — bash $DEST/scripts/warp-start.sh"
fi

TRACE=$(curl -sS --noproxy "" -m 15 -x "$PROXY" https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null)
IP=$(printf '%s\n' "$TRACE" | grep '^ip=' | cut -d= -f2)
WARP=$(printf '%s\n' "$TRACE" | grep '^warp=' | cut -d= -f2)
if [ "$WARP" = "on" ]; then
  ok "egress through WARP: ${IP} (warp=on)"
else
  bad "egress is not WARP — trace: ${TRACE:-no answer}"
fi

EXITS=$(curl -s --noproxy '*' -m 3 "$PROXY/exits" 2>/dev/null)
if [ -n "$EXITS" ]; then
  printf '%s' "$EXITS" | python3 -c '
import json,sys
try:
    d=json.load(sys.stdin)
    for e in d:
        print(f"    {e.get(\"id\")}  {e.get(\"state\")}  ip={e.get(\"ip\")}  served={e.get(\"served\")}")
except Exception:
    pass
' 2>/dev/null
fi

pgrep -f "$DEST/scripts/warp-guard.sh" >/dev/null 2>&1 \
  && ok "guard running" \
  || warn "guard not running (lane start karega)"

if [ -d "$HOME/.config/opencode/plugins/opencode-warp-retry" ]; then
  ok "v2 retry plugin installed (opencode v2 only)"
fi

echo ""
echo "  rotate:  opencode-unlimited-hop"
echo "  restart: opencode-unlimited-stop && opencode-unlimited-start"
echo ""
