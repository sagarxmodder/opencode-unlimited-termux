#!/data/data/com.termux/files/usr/bin/bash
# Stop the lane daemon and guard.
set -u

DEST="${OUC_WARP_DEST:-$HOME/.local/share/opencode-unlimited-warp}"
RUN="$DEST/run"

if [ -f "$RUN/warp-minimal.pid" ]; then
  kill "$(cat "$RUN/warp-minimal.pid")" 2>/dev/null || true
fi
pkill -f "$DEST/scripts/warp-guard.sh" 2>/dev/null || true
pkill -f "$DEST/bin/warp-minimal" 2>/dev/null || true
pkill -x warp-minimal 2>/dev/null || true
pkill -f 'warp-minimal.*-config' 2>/dev/null || true
sleep 1
rm -f "$RUN/warp-minimal.pid" "$RUN/guard.pid" 2>/dev/null || true
echo "[ok] stopped"
