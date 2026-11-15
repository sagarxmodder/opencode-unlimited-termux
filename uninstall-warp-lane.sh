#!/data/data/com.termux/files/usr/bin/bash
# Remove the warp lane. Leaves opencode and its sessions untouched.
set -u

DEST="${OUC_WARP_DEST:-$HOME/.local/share/opencode-unlimited-warp}"

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

rm -rf "$DEST"
echo "[ok] runtime removed: $DEST"

PLUGIN_DIR="$HOME/.config/opencode/plugins/opencode-warp-retry"
if [ -d "$PLUGIN_DIR" ]; then
  rm -rf "$PLUGIN_DIR"
  CFG="$HOME/.config/opencode/opencode.json"
  if [ -f "$CFG" ]; then
    python3 - "$CFG" "$PLUGIN_DIR" <<'PY'
import json, shutil, sys, time
cfg, path = sys.argv[1], sys.argv[2]
try:
    d = json.load(open(cfg))
except Exception:
    raise SystemExit(0)
before = d.get("plugins", [])
after = [p for p in before if not (isinstance(p, dict) and p.get("package") == path)]
if len(after) != len(before):
    d["plugins"] = after
    shutil.copy2(cfg, cfg + ".bak." + time.strftime("%Y%m%d-%H%M%S"))
    json.dump(d, open(cfg, "w"), indent=2)
PY
  fi
  echo "[ok] v2 retry plugin removed"
fi

rm -f "$HOME/.config/opencode/plugins/opencode-unlimited-lane.ts" 2>/dev/null || true
rm -rf "$HOME/.config/opencode/plugins/opencode-unlimited-tokens" 2>/dev/null || true

echo "[ok] gone. ~/.bashrc ka PATH line reh sakta hai (harmless)."
