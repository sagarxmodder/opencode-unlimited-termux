#!/data/data/com.termux/files/usr/bin/bash
# Remove the warp lane. Leaves opencode and its sessions untouched.
set -u

DEST="${OUC_WARP_DEST:-$HOME/.local/share/opencode-unlimited-warp}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

bash "$DEST/scripts/warp-stop.sh" >/dev/null 2>&1 || true

for f in opencode-unlimited-hop opencode-unlimited-doctor \
         opencode-unlimited-start opencode-unlimited-stop \
         oc; do
  rm -f "$HOME/.local/bin/$f" 2>/dev/null || true
done

if [ -f "$HOME/.local/bin/opencode" ] && grep -q "opencode-unlimited-warp" "$HOME/.local/bin/opencode" 2>/dev/null; then
  rm -f "$HOME/.local/bin/opencode"
  echo "[ok] shim removed (stock opencode still at \$(command -v opencode) via /usr/bin)"
fi

CFG_DIR="$HOME/.config/opencode"
CFG_TOOL="$SRC/scripts/config-util.py"
[ -f "$CFG_TOOL" ] || CFG_TOOL="$DEST/scripts/config-util.py"
find_cfg() {
  for f in "$CFG_DIR/opencode.json" "$CFG_DIR/opencode.jsonc"; do
    [ -f "$f" ] && printf '%s\n' "$f" && return 0
  done
  return 1
}

PLUGIN_DIR="$HOME/.config/opencode/plugins/opencode-warp-retry"
if [ -d "$PLUGIN_DIR" ]; then
  rm -rf "$PLUGIN_DIR"
  CFG="$(find_cfg || true)"
  if [ -n "$CFG" ] && [ -f "$CFG_TOOL" ]; then
    OUT="$(python3 "$CFG_TOOL" v2-remove "$CFG" "$PLUGIN_DIR" 2>&1 || true)"
    echo "[ok] v2 plugin config: $OUT ($(basename "$CFG"))"
  fi
  echo "[ok] v2 retry plugin removed"
fi

rm -rf "$DEST"
echo "[ok] runtime removed: $DEST"

rm -f "$HOME/.config/opencode/plugins/opencode-unlimited-lane.ts" 2>/dev/null || true
rm -rf "$HOME/.config/opencode/plugins/opencode-unlimited-tokens" 2>/dev/null || true

echo "[ok] gone. ~/.bashrc ka PATH line reh sakta hai (harmless)."
