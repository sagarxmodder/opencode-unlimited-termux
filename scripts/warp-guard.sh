#!/data/data/com.termux/files/usr/bin/bash
# Quota-wall guard. Tails opencode's own log and recycles the WARP pool when a
# free-limit line lands. warp-minimal already rotates on upstream 429/403; this
# is the belt-and-suspenders path and gives you a timestamped record.
set -u

DEST="${OUC_WARP_DEST:-$HOME/.local/share/opencode-unlimited-warp}"
PROXY="${OUC_WARP_PROXY:-http://127.0.0.1:8789}"
LOGF="$HOME/.local/share/opencode/log/opencode.log"
STATE_DIR="$DEST/guard"
OFF_FILE="$STATE_DIR/offset"
LAST_FILE="$STATE_DIR/last-rotate"
GLOG="$STATE_DIR/guard.log"
COOLDOWN=90
mkdir -p "$STATE_DIR"

log() { printf '%s %s\n' "$(date '+%m-%d %H:%M:%S')" "$*" >> "$GLOG"; }

SIZE=0
[ -f "$LOGF" ] && SIZE=$(wc -c < "$LOGF" 2>/dev/null || echo 0)
if [ ! -f "$OFF_FILE" ]; then
  echo "$SIZE" > "$OFF_FILE"
fi

log "guard up (cooldown ${COOLDOWN}s)"

while true; do
  sleep 15
  [ -f "$LOGF" ] || continue

  SIZE=$(wc -c < "$LOGF" 2>/dev/null || echo 0)
  OFF=$(cat "$OFF_FILE" 2>/dev/null || echo 0)
  case "$OFF" in ''|*[!0-9]*) OFF="$SIZE" ;; esac
  [ "$SIZE" -lt "$OFF" ] && OFF=0

  if [ "$SIZE" -gt "$OFF" ]; then
    HIT=0
    if tail -c +"$((OFF + 1))" "$LOGF" 2>/dev/null \
      | tail -c 200000 \
      | grep -aqiE 'level=ERROR.*(QuotaExceeded|Free usage limit reached|FreeUsageLimitError|provider\.free-limit)'; then
      HIT=1
    fi

    if [ "$HIT" = 1 ]; then
      NOW=$(date +%s)
      LAST=$(cat "$LAST_FILE" 2>/dev/null || echo 0)
      case "$LAST" in ''|*[!0-9]*) LAST=0 ;; esac
      if [ $((NOW - LAST)) -ge "$COOLDOWN" ]; then
        echo "$NOW" > "$LAST_FILE"
        log "wall detected — recycling WARP exits"
        if curl -s --noproxy '*' -m 10 -X POST "$PROXY/recycle" >/dev/null 2>&1; then
          log "recycle requested"
        else
          log "recycle failed (daemon down?)"
        fi
      fi
    fi
  fi

  echo "$SIZE" > "$OFF_FILE"
done
