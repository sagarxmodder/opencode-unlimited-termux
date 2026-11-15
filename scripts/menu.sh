#!/data/data/com.termux/files/usr/bin/bash
# opencode-unlimited warp lane — launcher UI v3
set -u

DEST="${OUC_WARP_DEST:-$HOME/.local/share/opencode-unlimited-warp}"
PROXY="${OUC_WARP_PROXY:-http://127.0.0.1:8789}"
PKG_DIR="${OUC_PKG_DIR:-/storage/emulated/0/opencode-unlimited-termux}"
LANE_NO_PROXY="localhost,127.0.0.1,::1,github.com,api.github.com,raw.githubusercontent.com,registry.npmjs.org,registry.npmjs.com,pypi.org,files.pythonhosted.org"
MENU_VER="3.1"
PLUGIN_LOG="$HOME/.config/opencode/memory/unlimited-tokens.log"

if [ -t 1 ]; then
  C0=$'\033[0m'; CB=$'\033[1m'; CD=$'\033[2m'
  CC=$'\033[38;5;51m'; CG=$'\033[38;5;46m'; CY=$'\033[38;5;226m'
  CR=$'\033[38;5;203m'; CGY=$'\033[38;5;245m'; CU=$'\033[38;5;39m'
  CP=$'\033[38;5;141m'
  TTY=1
else
  C0=""; CB=""; CD=""; CC=""; CG=""; CY=""; CR=""; CGY=""; CU=""; CP=""; TTY=0
fi

trap 'stty sane 2>/dev/null; echo; exit 130' INT TERM

ITEMS=(
  "Run opencode|unlimited lane kholo"
  "Run freecode|keyless free-model agent"
  "Unlimited status|models · retries · context"
  "Restart WARP lane|daemon + guard"
  "Rotate WARP /64|naya identity"
  "Doctor|health + egress"
  "Logs|opencode · lane · plugin"
  "About / updates|credits · GitHub main"
  "Uninstall lane|runtime only"
  "Exit|"
)

find_opencode() {
  for c in /data/data/com.termux/files/usr/bin/opencode \
           "${PREFIX:-/data/data/com.termux/files/usr}/bin/opencode" \
           "$HOME/.opencode/bin/opencode"; do
    [ -x "$c" ] && { printf '%s\n' "$c"; return 0; }
  done
  return 1
}

run_freecode() {
  local exe=""
  if command -v freecode >/dev/null 2>&1; then
    exe="$(command -v freecode)"
  elif [ -f "$PKG_DIR/freecode/install.sh" ] && command -v node >/dev/null 2>&1; then
    bash "$PKG_DIR/freecode/install.sh" >/dev/null 2>&1 || true
    hash -r
    command -v freecode >/dev/null 2>&1 && exe="$(command -v freecode)"
  fi
  if [ -z "$exe" ] && command -v node >/dev/null 2>&1 && [ -f "$PKG_DIR/freecode/bin/freecode" ]; then
    exe="node:$PKG_DIR/freecode/bin/freecode"
  fi
  if [ -z "$exe" ]; then
    printf '  %s✗ freecode missing — pkg install nodejs, phir: bash freecode/install.sh%s\n' "$CR" "$C0"
    pause_key
    return 0
  fi
  local -a cmd
  case "$exe" in
    node:*) cmd=(node "${exe#node:}") ;;
    *) cmd=("$exe") ;;
  esac
  local -a envp=()
  if health_json 2>/dev/null | grep -q '"healthy":[1-9]'; then
    envp=(HTTPS_PROXY="$PROXY" HTTP_PROXY="$PROXY" ALL_PROXY="$PROXY"
          https_proxy="$PROXY" http_proxy="$PROXY" all_proxy="$PROXY"
          NO_PROXY="$LANE_NO_PROXY" no_proxy="$LANE_NO_PROXY")
  fi
  env "${envp[@]}" "${cmd[@]}" || true
  stty sane 2>/dev/null || true
}

health_json() { curl -s --noproxy '*' -m 2 "$PROXY/health" 2>/dev/null; }
lane_running() { pgrep -f "$DEST/bin/warp-minimal" >/dev/null 2>&1; }
guard_running() { pgrep -f "$DEST/scripts/warp-guard.sh" >/dev/null 2>&1; }

ACTIVE=0; HEALTHY=0; SERVED=0; STREAMS=0; COOLING=0; POOL=0
IP=""; WARP=""; LAT=""; OC=""; OCV=""; WARP_VER=""; GUARD=0; UP=""
PLUGIN="off"; CTX="—"; RETRY="0"; PLUG_AT=""

json_get() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)" 2>/dev/null; }

refresh_status() {
  local tmp H EJ TR T0 T1 pid
  OC="$(find_opencode || true)"
  tmp="${TMPDIR:-${PREFIX:-/tmp}/tmp}/ocmenu.$$"
  mkdir -p "$tmp" 2>/dev/null || tmp="/data/data/com.termux/files/usr/tmp"

  ( health_json > "$tmp/h" ) & local ph=$!
  ( curl -s --noproxy '*' -m 3 "$PROXY/exits" > "$tmp/e" 2>/dev/null ) & local pe=$!
  ( T0="$(date +%s%3N 2>/dev/null || echo 0)"
    curl -sS --noproxy "" -m 6 -x "$PROXY" https://www.cloudflare.com/cdn-cgi/trace > "$tmp/t" 2>/dev/null
    T1="$(date +%s%3N 2>/dev/null || echo 0)"
    printf '%s %s\n' "$T0" "$T1" > "$tmp/lat" ) & local pt=$!
  ( if [ -n "$OC" ]; then
      "$OC" --version 2>/dev/null | head -n1 > "$tmp/v"
    else
      printf 'missing\n' > "$tmp/v"
    fi ) & local pv=$!
  ( "$DEST/bin/warp-minimal" -version 2>/dev/null | awk '{print $2}' > "$tmp/wv" ) & local pw=$!
  wait "$ph" "$pe" "$pt" "$pv" "$pw" 2>/dev/null

  H="$(cat "$tmp/h" 2>/dev/null)"
  if [ -n "$H" ]; then
    ACTIVE="$(printf '%s' "$H" | json_get 'd.get("active",0)')"
    HEALTHY="$(printf '%s' "$H" | json_get 'd.get("healthy",0)')"
    COOLING="$(printf '%s' "$H" | json_get 'd.get("cooling_down",0)')"
    POOL="$(printf '%s' "$H" | json_get 'd.get("pool_size",0)')"
  else
    ACTIVE=0; HEALTHY=0; COOLING=0; POOL=0
  fi
  EJ="$(cat "$tmp/e" 2>/dev/null)"
  SERVED="$(printf '%s' "$EJ" | python3 -c 'import json,sys;print(sum(int(e.get("served",0)) for e in json.load(sys.stdin)))' 2>/dev/null)"
  STREAMS="$(printf '%s' "$EJ" | python3 -c 'import json,sys;print(sum(int(e.get("streams",0)) for e in json.load(sys.stdin)))' 2>/dev/null)"
  TR="$(cat "$tmp/t" 2>/dev/null)"
  read -r T0 T1 < "$tmp/lat" 2>/dev/null || { T0=0; T1=0; }
  if [ "${T0:-0}" -gt 0 ] 2>/dev/null && [ "${T1:-0}" -ge "${T0:-0}" ] 2>/dev/null; then
    LAT="$((T1 - T0)) ms"
  else
    LAT="—"
  fi
  IP="$(printf '%s\n' "$TR" | grep '^ip=' | cut -d= -f2)"
  WARP="$(printf '%s\n' "$TR" | grep '^warp=' | cut -d= -f2)"
  OCV="$(cat "$tmp/v" 2>/dev/null)"; OCV="${OCV:-missing}"
  WARP_VER="$(cat "$tmp/wv" 2>/dev/null)"
  guard_running && GUARD=1 || GUARD=0

  UP=""; pid="$(cat "$DEST/run/warp-minimal.pid" 2>/dev/null)"
  if [ -n "$pid" ]; then
    local et
    et="$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')"
    [ -n "$et" ] && UP="$((et / 60))m"
  fi

  PLUGIN="off"; CTX="—"; RETRY="0"; PLUG_AT=""
  if [ -f "$PLUGIN_LOG" ]; then
    if tail -n 400 "$PLUGIN_LOG" 2>/dev/null | grep -q "lane plugin loaded"; then PLUGIN="on"; fi
    local line
    line="$(grep "usage " "$PLUGIN_LOG" 2>/dev/null | tail -n1)"
    if [ -n "$line" ]; then
      CTX="$(printf '%s' "$line" | grep -oE '\([0-9.]+%\)' | tr -d '()')"
    fi
    RETRY="$(tail -n 400 "$PLUGIN_LOG" 2>/dev/null | grep -c "auto-continue sent")"
    PLUG_AT="$(tail -n1 "$PLUGIN_LOG" 2>/dev/null | cut -c1-19)"
  fi

  rm -rf "$tmp" 2>/dev/null || true
}

pause_key() {
  [ "$TTY" = 1 ] || return 0
  printf '\n  %sEnter dabao…%s' "$CD" "$C0"
  read -rsn1 _ || true
}

banner() {
  printf '\n'
  printf '  %s╭────────────────────────────────────────────────────────────╮%s\n' "$CC" "$C0"
  printf '   %s%s▄▀█ █▀▀ █▀▀ █▀█ █▀▀%s  %sOPENCODE%s  %sUNLIMITED%s  %s·%s  %sWARP LANE%s\n' \
    "$CB" "$CY" "$C0" "$CB" "$C0" "$CG" "$C0" "$CGY" "$C0" "$CP" "$C0"
  printf '   %s%s█▀█ █▄▄ ██▄ █▀▀ ██▄%s  %sTermux / no-root%s                %sUI %s%s\n' \
    "$CB" "$CY" "$C0" "$CD" "$C0" "$CD" "$MENU_VER" "$C0"
  printf '   %sunlimited usage  ·  unlimited chat  ·  auto-retry on errors%s\n' "$CGY" "$C0"
  printf '  %s╰────────────────────────────────────────────────────────────╯%s\n' "$CC" "$C0"
}

status_panel() {
  local lane_txt lane_col eg_txt eg_col guard_txt plug_txt plug_col now
  now="$(date '+%H:%M:%S')"
  if [ "${ACTIVE:-0}" -ge 1 ] 2>/dev/null; then lane_txt="● ONLINE"; lane_col="$CG"; else lane_txt="● OFFLINE"; lane_col="$CR"; fi
  if [ "$WARP" = "on" ]; then eg_txt="warp=on"; eg_col="$CG"; else eg_txt="warp=off"; eg_col="$CR"; fi
  if [ "$GUARD" = 1 ]; then guard_txt="${CG}●${C0}"; else guard_txt="${CR}○${C0}"; fi
  if [ "$PLUGIN" = "on" ]; then plug_txt="${CG}on${C0}"; else plug_txt="${CR}off${C0}"; fi

  printf '\n'
  printf '   %s%s%s  %s%s%s  %sexits %s/%s%s  %sserved %s%s  %sstreams %s%s\n' \
    "$lane_col" "$lane_txt" "$C0" "$eg_col" "$eg_txt" "$C0" \
    "$CGY" "$HEALTHY" "$POOL" "$C0" "$CGY" "$SERVED" "$C0" "$CGY" "$STREAMS" "$C0"
  printf '   %slat %s%s  %scool %s%s  %sup %s%s  %sguard%s %s  %splugin%s %s  %sctx%s %s\n' \
    "$CGY" "$LAT" "$C0" "$CGY" "$COOLING" "$C0" "$CGY" "${UP:-—}" "$C0" "$CGY" "$C0" "$guard_txt" "$CGY" "$C0" "$plug_txt" "$CGY" "$C0" "$CTX"
  printf '   %segress%s %s%s%s\n' "$CGY" "$C0" "$CU" "${IP:-—}" "$C0"
  printf '   %sopen %s%s  %swarp %s%s  %sretries %s%s  %s%s%s\n' \
    "$CGY" "$OCV" "$C0" "$CGY" "${WARP_VER:-?}" "$C0" "$CGY" "$RETRY" "$C0" "$CD" "$now" "$C0"
}

draw_items() {
  local i label hint num
  printf '\n   %s────────────────────────────────────────────────────────────%s\n' "$CD" "$C0"
  for i in "${!ITEMS[@]}"; do
    label="${ITEMS[$i]%%|*}"
    hint="${ITEMS[$i]#*|}"
    num=$(( (i + 1) % 10 ))
    if [ "$TTY" = 1 ] && [ "$i" = "$SEL" ]; then
      printf '  %s%s ▸ %s  %-26s%s %-26s %s%s\n' "$CB" "$CC" "$num" "$label" "$C0" "$hint" "$CD" "$C0"
    else
      printf '     %s  %-26s %s%s%s\n' "$num" "$label" "$CD" "$hint" "$C0"
    fi
  done
  printf '   %s────────────────────────────────────────────────────────────%s\n' "$CD" "$C0"
}

draw_footer() {
  printf '   %s↑↓ / j k move · Enter select · 0-9 jump · r refresh · q quit%s\n' "$CD" "$C0"
}

draw() {
  [ "$TTY" = 1 ] && clear
  banner
  status_panel
  draw_items
  draw_footer
}

unlimited_screen() {
  local c line
  while true; do
    [ "$TTY" = 1 ] && clear
    printf '\n  %s╭────────────────────────────────────────────────────────────╮%s\n' "$CG" "$C0"
    printf '    %sUNLIMITED%s  %s·  all free models%s\n' "$CB" "$C0" "$CG" "$C0"
    printf '  %s╰────────────────────────────────────────────────────────────╯%s\n' "$CG" "$C0"
    printf '\n'
    printf '   %sPolicy%s\n' "$CB" "$C0"
    printf '     quota / 429 / 5xx   → %sWARP /64 rotate → auto-continue%s\n' "$CG" "$C0"
    printf '     network reset/timeout → retry, rotate after 2nd hit\n'
    printf '     context wall        → %smaxOutputTokens cap → handoff → compact%s\n' "$CG" "$C0"
    printf '     retries             → %sunlimited%s (%s45s cooldown per session)\n' "$CG" "$C0" "$CD" "$C0"
    printf '     model families      → deepseek · flint · glm · minimax · any free\n'
    printf '\n'
    printf '   %sLive%s\n' "$CB" "$C0"
    printf '     plugin   %s        ctx %s        auto-continues %s\n' "$PLUGIN" "$CTX" "$RETRY"
    printf '     exits    %s/%s healthy · %s cooling · served %s · streams %s\n' "$HEALTHY" "$POOL" "$COOLING" "$SERVED" "$STREAMS"
    printf '     egress   %s%s\n' "$IP" "$C0"
    if [ -n "$PLUG_AT" ]; then printf '     last log %s%s%s\n' "$CD" "$PLUG_AT" "$C0"; fi
    printf '\n   %sRecent plugin log%s\n' "$CB" "$C0"
    tail -n 5 "$PLUGIN_LOG" 2>/dev/null | sed 's/^/     /' || printf '     (no log yet)\n'
    printf '\n'
    printf '    %s1%s Rotate WARP now   %s2%s Tokens (in TUI: /tokens)   %s0%s Back\n' "$CB" "$C0" "$CB" "$C0" "$CB" "$C0"
    printf '\n  Choose [0-2]: '
    IFS= read -r c || return 0
    case "$c" in
      1) [ "$TTY" = 1 ] && clear; bash "$DEST/scripts/warp-hop.sh"; pause_key; refresh_status ;;
      2) printf '\n  TUI ke andar %s/tokens%s tool context %s batata hai.\n' "$CG" "$C0" "$C0"; pause_key ;;
      0|"") return 0 ;;
    esac
  done
}

install_menu() {
  local c
  while true; do
    [ "$TTY" = 1 ] && clear
    printf '\n  %s╭────────────────────────────────────────────────────────────╮%s\n' "$CY" "$C0"
    printf '    %sINSTALL / REPAIR%s\n' "$CB" "$C0"
    printf '  %s╰────────────────────────────────────────────────────────────╯%s\n' "$CY" "$C0"
    if [ -n "$OC" ]; then
      printf '\n   current: %s%s%s  (%s)\n' "$CG" "$OCV" "$C0" "$OC"
    else
      printf '\n   current: %sopencode missing%s\n' "$CR" "$C0"
    fi
    printf '\n'
    printf '    %s1%s  Install opencode             %spkg install opencode%s\n' "$CB" "$C0" "$CD" "$C0"
    printf '    %s2%s  Update opencode              %spkg upgrade opencode%s\n' "$CB" "$C0" "$CD" "$C0"
    printf '    %s3%s  Recent Termux builds         %slinks / Android 11+ fix%s\n' "$CB" "$C0" "$CD" "$C0"
    printf '    %s4%s  Freeflow fallback (optional)  %s58 providers, keys chahiye%s\n' "$CB" "$C0" "$CD" "$C0"
    printf '    %s5%s  Repair WARP lane             %sinstall-warp-lane.sh%s\n' "$CB" "$C0" "$CD" "$C0"
    printf '    %s0%s  Back\n' "$CB" "$C0"
    printf '\n  Choose [0-5]: '
    IFS= read -r c || return 0
    case "$c" in
      1) [ "$TTY" = 1 ] && clear
         if [ -f "$PKG_DIR/scripts/install-opencode.sh" ]; then
           bash "$PKG_DIR/scripts/install-opencode.sh" || true
         elif command -v pkg >/dev/null 2>&1; then
           pkg install -y opencode || printf '  ✗ install fail\n'
         else
           printf '  ✗ pkg nahi mila\n'
         fi
         pause_key ;;
      2) [ "$TTY" = 1 ] && clear; command -v pkg >/dev/null 2>&1 && pkg upgrade -y opencode || printf '  ✗ pkg nahi mila\n'; pause_key ;;
      3) [ "$TTY" = 1 ] && clear
         if [ -f "$PKG_DIR/docs/OPENCODE-INSTALL.md" ]; then sed -n '1,80p' "$PKG_DIR/docs/OPENCODE-INSTALL.md"
         else printf '  https://github.com/jcz2020/opencode-termux\n'; fi
         pause_key ;;
      4) [ "$TTY" = 1 ] && clear; install_freeflow; pause_key ;;
      5) [ "$TTY" = 1 ] && clear
         if [ -f "$PKG_DIR/install-warp-lane.sh" ]; then OC_MENU_SKIP=1 bash "$PKG_DIR/install-warp-lane.sh"
         else bash "$DEST/scripts/warp-start.sh"; fi
         pause_key ;;
      0|"") return 0 ;;
    esac
    refresh_status
  done
}

install_freeflow() {
  printf '\n  %sFREEFLOW — optional 58-provider fallback%s\n\n' "$CB" "$C0"
  printf '  WARP lane primary rahega; freeflow Plan B hai (WARP block/pool empty).\n'
  printf '  Providers ke free API keys chahiye (Groq, Gemini, NVIDIA, ...).\n\n'
  if ! command -v node >/dev/null 2>&1; then printf '  %s✗ node missing — pehle: pkg install nodejs%s\n' "$CR" "$C0"; return 0; fi
  local NV MAJ ans
  NV="$(node --version 2>/dev/null | sed 's/^v//')"; MAJ="${NV%%.*}"
  if [ "${MAJ:-0}" -lt 22 ] 2>/dev/null; then printf '  %s✗ Node %s mila, 22+ chahiye — pkg install nodejs%s\n' "$CR" "$NV" "$C0"; return 0; fi
  printf '  Node v%s OK\n\n  Install: npm install -g github:Ethos6/freeflow  [y/N]: ' "$NV"
  IFS= read -r ans || ans=""
  case "$ans" in
    y|Y) npm install -g github:Ethos6/freeflow 2>&1 | tail -n 15
         printf '\n  freeflow open · freeflow key groq · freeflow use groq/... · freeflow opencode\n' ;;
    *) printf '  skipped\n' ;;
  esac
}

logs_menu() {
  local c f
  while true; do
    [ "$TTY" = 1 ] && clear
    printf '\n  %s╭────────────────────────────────────────────────────────────╮%s\n' "$CU" "$C0"
    printf '    %sLOGS%s\n' "$CB" "$C0"
    printf '  %s╰────────────────────────────────────────────────────────────╯%s\n' "$CU" "$C0"
    printf '\n'
    printf '    %s1%s  opencode.log        %s%s%s\n' "$CB" "$C0" "$CD" "$HOME/.local/share/opencode/log/opencode.log" "$C0"
    printf '    %s2%s  warp-minimal.log    %s%s%s\n' "$CB" "$C0" "$CD" "$DEST/logs/warp-minimal.log" "$C0"
    printf '    %s3%s  guard.log           %s%s%s\n' "$CB" "$C0" "$CD" "$DEST/guard/guard.log" "$C0"
    printf '    %s4%s  daemon.log          %s%s%s\n' "$CB" "$C0" "$CD" "$DEST/logs/daemon.log" "$C0"
    printf '    %s5%s  plugin.log          %s%s%s\n' "$CB" "$C0" "$CD" "$PLUGIN_LOG" "$C0"
    printf '    %s0%s  Back\n' "$CB" "$C0"
    printf '\n  Choose [0-5]: '
    IFS= read -r c || return 0
    case "$c" in
      1) f="$HOME/.local/share/opencode/log/opencode.log" ;;
      2) f="$DEST/logs/warp-minimal.log" ;;
      3) f="$DEST/guard/guard.log" ;;
      4) f="$DEST/logs/daemon.log" ;;
      5) f="$PLUGIN_LOG" ;;
      0|"") return 0 ;;
      *) continue ;;
    esac
    [ "$TTY" = 1 ] && clear
    printf '\n  %s== %s ==%s\n\n' "$CD" "$f" "$C0"
    tail -n 40 "$f" 2>/dev/null || printf '  (file nahi hai)\n'
    pause_key
  done
}

about_screen() {
  [ "$TTY" = 1 ] && clear
  local c guard_txt="stopped"
  [ "${GUARD:-0}" = 1 ] && guard_txt="running"
  printf '\n  %s╭────────────────────────────────────────────────────────────╮%s\n' "$CG" "$C0"
  printf '    %sABOUT%s  %s·  OpenCode Unlimited%s  %s·  WARP lane%s\n' "$CB" "$C0" "$CG" "$C0" "$CGY" "$C0"
  printf '  %s╰────────────────────────────────────────────────────────────╯%s\n' "$CG" "$C0"
  printf '\n   %sFree-model lane for opencode on Android / Termux.%s\n' "$CD" "$C0"
  printf '   No root, no TUN. Egress through Cloudflare WARP;\n'
  printf '   fresh /64 on quota walls + automatic model failover.\n'
  printf '   %sFEATURES%s  unlimited usage  ·  unlimited chat  ·  auto-retry\n' "$CGY" "$C0"
  printf '\n'
  printf '   %sBUILD%s     UI %s  ·  WARP %s  ·  guard %s\n' "$CGY" "$C0" "$MENU_VER" "${WARP_VER:-?}" "$guard_txt"
  printf '   %sRUNTIME%s   opencode %s\n' "$CGY" "$C0" "$OCV"
  printf '   %sPROXY%s     %s\n' "$CGY" "$C0" "$PROXY"
  printf '   %sLICENSE%s   MIT\n' "$CGY" "$C0"
  printf '   %sREPO%s      %s\n' "$CGY" "$C0" 'github.com/sagarxmodder/opencode-unlimited-termux'
  printf '   %sCREDIT%s    ItzSagarOp\n' "$CGY" "$C0"
  printf '\n   %sSOURCES (recent first)%s\n' "$CB" "$C0"
  printf '     2026-11-15  Ethos6/freeflow             optional fallback (58 providers)\n'
  printf '     2026-11-14  Deury08/warp-minimal        core egress (v0.4.0)\n'
  printf '     2026-11-14  lipey1/opencode-warp-retry  v2 retry hook (adapted)\n'
  printf '     2026-11-11  Suydev/opencode-unlimited-termux  lane layout reference\n'
  printf '\n   %sDocs%s  README-WARP-LANE.md · docs/RECOVERY.md\n' "$CB" "$C0"
  printf '\n    %s1%s Check updates (GitHub main)   %s0%s Back\n' "$CB" "$C0" "$CB" "$C0"
  printf '\n  Choose [0-1]: '
  IFS= read -r c || return 0
  case "$c" in
    1) [ "$TTY" = 1 ] && clear; bash "$DEST/scripts/warp-upgrade.sh"; pause_key ;;
  esac
}

uninstall_confirm() {
  local ans
  printf '\n  %sUninstall lane? opencode + sessions safe rahenge. [y/N]: %s' "$CR" "$C0"
  IFS= read -r ans || ans=""
  case "$ans" in
    y|Y)
      [ "$TTY" = 1 ] && clear
      if [ -f "$PKG_DIR/uninstall-warp-lane.sh" ]; then bash "$PKG_DIR/uninstall-warp-lane.sh"
      else bash "$DEST/scripts/warp-stop.sh"; rm -rf "$DEST"; fi
      exit 0
      ;;
  esac
}

run_action() {
  local idx="$1"
  case "$idx" in
    0) [ "$TTY" = 1 ] && clear
       if [ -z "$OC" ] && [ "$TTY" = 1 ] && [ -f "$PKG_DIR/scripts/install-opencode.sh" ]; then
         printf '  %sopencode missing — auto-install try kar raha hoon%s\n\n' "$CY" "$C0"
         bash "$PKG_DIR/scripts/install-opencode.sh" || true
         hash -r 2>/dev/null || true
         refresh_status
       fi
       if [ -z "$OC" ]; then
         printf '  %s✗ opencode missing — Install/repair (2) chalao%s\n' "$CR" "$C0"; pause_key
       else
         bash "$DEST/scripts/lane.sh" || true
         stty sane 2>/dev/null || true
       fi
       refresh_status ;;
    1) [ "$TTY" = 1 ] && clear; run_freecode; refresh_status ;;
    2) unlimited_screen; refresh_status ;;
    3) [ "$TTY" = 1 ] && clear; bash "$DEST/scripts/warp-start.sh"; pause_key; refresh_status ;;
    4) [ "$TTY" = 1 ] && clear; bash "$DEST/scripts/warp-hop.sh"; pause_key; refresh_status ;;
    5) [ "$TTY" = 1 ] && clear; bash "$DEST/scripts/warp-doctor.sh"; pause_key; refresh_status ;;
    6) logs_menu; refresh_status ;;
    7) about_screen ;;
    8) uninstall_confirm ;;
    9) [ "$TTY" = 1 ] && clear; exit 0 ;;
  esac
}

refresh_status

if [ "$TTY" = 1 ]; then
  SEL=0
  while true; do
    draw
    IFS= read -rsn1 key || exit 0
    case "$key" in
      $'\x1b')
        read -rsn2 -t 0.05 k2 || k2=""
        case "$k2" in
          '[A'|'OA') SEL=$(( (SEL + 9) % 10 )) ;;
          '[B'|'OB') SEL=$(( (SEL + 1) % 10 )) ;;
        esac
        ;;
      j|J) SEL=$(( (SEL + 1) % 10 )) ;;
      k|K) SEL=$(( (SEL + 9) % 10 )) ;;
      '') run_action "$SEL" ;;
      [0-9]) if [ "$key" = 0 ]; then run_action 9; else run_action $((key - 1)); fi ;;
      r|R) refresh_status ;;
      q|Q) clear; exit 0 ;;
    esac
  done
else
  while true; do
    banner; status_panel; draw_items
    printf '\n  Choose [0-9]: '
    IFS= read -r choice || exit 0
    case "$choice" in
      0) run_action 9 ;;
      1|2|3|4|5|6|7|8|9) run_action $((choice - 1)); refresh_status ;;
    esac
  done
fi
