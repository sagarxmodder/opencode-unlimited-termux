#!/data/data/com.termux/files/usr/bin/bash
# Start warp-minimal (under proot for /etc/resolv.conf) + the log guard.
set -u

DEST="${OUC_WARP_DEST:-$HOME/.local/share/opencode-unlimited-warp}"
PROXY="${OUC_WARP_PROXY:-http://127.0.0.1:8789}"
BIN="$DEST/bin/warp-minimal"
CONF="$DEST/config.json"
RUN="$DEST/run"
LOGS="$DEST/logs"
mkdir -p "$RUN" "$LOGS" "$DEST/guard"

if [ -t 1 ]; then
  CG=$'\033[38;5;46m'; CY=$'\033[38;5;226m'; CR=$'\033[38;5;203m'; CD=$'\033[2m'; C0=$'\033[0m'
else
  CG=""; CY=""; CR=""; CD=""; C0=""
fi
ok()   { printf '        %s✓%s %s\n' "$CG" "$C0" "$*"; }
warn() { printf '        %s!%s %s\n' "$CY" "$C0" "$*"; }
bad()  { printf '        %s✗%s %s\n' "$CR" "$C0" "$*"; }

# Go (warp-minimal) must see Termux's CA bundle; some shells don't export it.
CERT="${PREFIX:-/data/data/com.termux/files/usr}/etc/tls/cert.pem"
if [ -s "$CERT" ]; then
  export SSL_CERT_FILE="$CERT"
else
  warn "CA bundle missing: $CERT — run: pkg install ca-certificates"
fi

# healthy = server is up AND has at least one usable exit.
healthy() {
  curl -s --noproxy '*' -m 2 "$PROXY/health" 2>/dev/null | grep -q '"healthy":[1-9]'
}

# alive = something is answering on the port, even with zero exits. Without
# this, a lane stuck at healthy=0 looks dead, start spawns a second copy, and
# that copy dies with "bind: address already in use".
alive() {
  [ -n "$(curl -s --noproxy '*' -m 2 "$PROXY/health" 2>/dev/null)" ]
}

if healthy && pgrep -f "$DEST/bin/warp-minimal" >/dev/null 2>&1; then
  ok "warp-minimal already running"
else
  if alive || pgrep -f "$DEST/bin/warp-minimal" >/dev/null 2>&1; then
    if alive; then
      warn "another instance owns $PROXY — restarting with this lane's config"
    else
      warn "stale warp-minimal process found — restarting"
    fi
    pkill -f "$DEST/bin/warp-minimal" 2>/dev/null || true
    pkill -x warp-minimal 2>/dev/null || true
    pkill -f 'warp-minimal.*-config' 2>/dev/null || true
    k=0
    while alive && [ "$k" -lt 10 ]; do
      sleep 1
      k=$((k + 1))
    done
    if alive; then
      bad "port 8789 still held after 10s — 'opencode-unlimited-stop' chalao"
      exit 1
    fi
    rm -f "$RUN/warp-minimal.pid"
    sleep 1
  fi

  if ! command -v proot >/dev/null 2>&1; then
    bad "proot missing: pkg install proot"
    exit 1
  fi
  if [ ! -x "$BIN" ]; then
    bad "binary missing: $BIN"
    exit 1
  fi

  if [ ! -s "$DEST/etc/resolv.conf" ]; then
    mkdir -p "$DEST/etc"
    if [ -s "${PREFIX:-/data/data/com.termux/files/usr}/etc/resolv.conf" ]; then
      cp "${PREFIX:-/data/data/com.termux/files/usr}/etc/resolv.conf" "$DEST/etc/resolv.conf"
    else
      printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > "$DEST/etc/resolv.conf"
    fi
  fi
  if [ ! -s "$DEST/etc/hosts" ]; then
    printf '127.0.0.1 localhost\n' > "$DEST/etc/hosts"
  fi

  nohup proot \
    -b "$DEST/etc/resolv.conf:/etc/resolv.conf" \
    -b "$DEST/etc/hosts:/etc/hosts" \
    "$BIN" -config "$CONF" >> "$LOGS/daemon.log" 2>&1 &
  echo $! > "$RUN/warp-minimal.pid"

  [ -t 1 ] && printf '        %s…%s starting daemon (pid %s) ' "$CD" "$C0" "$(cat "$RUN/warp-minimal.pid")"
  i=0
  while [ "$i" -lt 60 ]; do
    if healthy; then break; fi
    if [ -t 1 ]; then printf '.'; fi
    sleep 1
    i=$((i + 1))
  done
  [ -t 1 ] && printf '\n'

  if ! healthy; then
    bad "tunnel start nahi hua ($i s)"
    printf '\n        %s── last daemon.log ──%s\n' "$CD" "$C0"
    tail -n 6 "$LOGS/daemon.log" 2>/dev/null | sed 's/^/          /'
    printf '\n        %s── last warp-minimal.log ──%s\n' "$CD" "$C0"
    tail -n 10 "$LOGS/warp-minimal.log" 2>/dev/null | sed 's/^/          /'
    printf '\n'
    if alive; then
      bad "server is up but 0 WARP exits (registration/API problem, not the port)"
    else
      bad "nothing listening on 8789 either — daemon crashed at boot"
    fi
    bad "hints: pkg install proot ca-certificates · internet/UDP 443 check karo · phir retry"
    pkill -f "$DEST/bin/warp-minimal" 2>/dev/null || true
    pkill -x warp-minimal 2>/dev/null || true
    rm -f "$RUN/warp-minimal.pid"
    exit 1
  fi

  # pool size 2: give the second slot a few seconds, don't block forever
  j=0; EXITS=0
  while [ "$j" -lt 8 ]; do
    EXITS=$(curl -s --noproxy '*' -m 3 "$PROXY/health" 2>/dev/null | python3 -c \
      'import json,sys;print(json.load(sys.stdin).get("healthy",0))' 2>/dev/null)
    [ "${EXITS:-0}" -ge 2 ] && break
    sleep 1
    j=$((j + 1))
  done
  ok "WARP tunnel ready (${EXITS:-?} exits)"
fi

if ! pgrep -f "$DEST/scripts/warp-guard.sh" >/dev/null 2>&1; then
  nohup bash "$DEST/scripts/warp-guard.sh" >> "$LOGS/guard.log" 2>&1 &
  echo $! > "$RUN/guard.pid"
  ok "guard started"
fi
