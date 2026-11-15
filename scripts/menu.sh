#!/data/data/com.termux/files/usr/bin/bash
# opencode-unlimited warp lane — launcher UI v2
set -u

DEST="${OUC_WARP_DEST:-$HOME/.local/share/opencode-unlimited-warp}"
PROXY="${OUC_WARP_PROXY:-http://127.0.0.1:8789}"
PKG_DIR="${OUC_PKG_DIR:-/storage/emulated/0/opencode-unlimited-termux}"
MENU_VER="2.0"

if [ -t 1 ]; then
  C0=$'\033[0m'; CB=$'\033[1m'; CD=$'\033[2m'; CRV=$'\033[7m'
  CC=$'\033[38;5;51m'; CG=$'\033[38;5;46m'; CY=$'\033[38;5;226m'
  CR=$'\033[38;5;203m'; CGY=$'\033[38;5;245m'; CU=$'\033[38;5;39m'
  TTY=1
else
  C0=""; CB=""; CD=""; CRV=""; CC=""; CG=""; CY=""; CR=""; CGY=""; CU=""; TTY=0
fi

trap 'stty sane 2>/dev/null; echo; exit 130' INT TERM

ITEMS=(
  "Run opencode|TUI kholo"
  "Install / repair opencode|pkg · builds · lane"
  "Start / restart WARP lane|daemon + guard"
  "Rotate WARP /64|naya identity"
  "Doctor|health + egress"
  "Logs|opencode · lane · guard"
  "Check updates / upgrade|GitHub releases"
  "About / credits|sources + versions"
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

health_json() { curl -s --noproxy '*' -m 2 "$PROXY/health" 2>/dev/null; }
trace() { curl -sS --noproxy "" -m 6 -x "$PROXY" https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null; }
lane_running() { pgrep -f "$DEST/bin/warp-minimal" >/dev/null 2>&1; }
guard_running() { pgrep -f "$DEST/scripts/warp-guard.sh" >/dev/null 2>&1; }

ACTIVE=0; HEALTHY=0; SERVED=0; IP=""; WARP=""; LAT=""; OC=""; OCV=""; WARP_VER=""; GUARD=0

refresh_status() {
  local H TR T0 T1 EJ
  H="$(health_json)"
  if [ -n "$H" ]; then
    ACTIVE="$(printf '%s' "$H" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("active",0))' 2>/dev/null)"
    HEALTHY="$(printf '%s' "$H" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("healthy",0))' 2>/dev/null)"
  else
    ACTIVE=0; HEALTHY=0
  fi
  EJ="$(curl -s --noproxy '*' -m 3 "$PROXY/exits" 2>/dev/null)"
  SERVED="$(printf '%s' "$EJ" | python3 -c 'import json,sys;print(sum(int(e.get("served",0)) for e in json.load(sys.stdin)))' 2>/dev/null)"
  T0="$(date +%s%3N 2>/dev/null || echo 0)"
  TR="$(trace)"
  T1="$(date +%s%3N 2>/dev/null || echo 0)"
  if [ "$T0" -gt 0 ] 2>/dev/null && [ "$T1" -ge "$T0" ] 2>/dev/null; then
    LAT="$((T1 - T0)) ms"
  else
    LAT="—"
  fi
  IP="$(printf '%s\n' "$TR" | grep '^ip=' | cut -d= -f2)"
  WARP="$(printf '%s\n' "$TR" | grep '^warp=' | cut -d= -f2)"
  if OC="$(find_opencode)"; then
    OCV="$("$OC" --version 2>/dev/null | head -n1)"
  else
    OC=""; OCV="missing"
  fi
  WARP_VER="$("$DEST/bin/warp-minimal" -version 2>/dev/null | awk '{print $2}')"
  guard_running && GUARD=1 || GUARD=0
}

pause_key() {
  [ "$TTY" = 1 ] || return 0
  printf '\n  %sEnter dabao…%s' "$CD" "$C0"
  read -rsn1 _ || true
}

banner() {
  printf '\n'
  printf '  %s╭────────────────────────────────────────────────────────╮%s\n' "$CC" "$C0"
  printf '    %sOPENCODE UNLIMITED%s  %s·  WARP LANE%s            %sUI %s%s\n' \
    "$CB" "$C0" "$CGY" "$C0" "$CD" "$MENU_VER" "$C0"
  printf '    Termux / no-root                          %s@ItzSagarOp%s\n' "$CD" "$C0"
  printf '  %s╰────────────────────────────────────────────────────────╯%s\n' "$CC" "$C0"
}

status_panel() {
  local lane_txt lane_col eg_txt eg_col guard_txt now
  now="$(date '+%H:%M:%S')"
  if [ "${ACTIVE:-0}" -ge 1 ] 2>/dev/null; then
    lane_txt="● ONLINE"; lane_col="$CG"
  else
    lane_txt="● OFFLINE"; lane_col="$CR"
  fi
  if [ "$WARP" = "on" ]; then eg_txt="warp=on"; eg_col="$CG"; else eg_txt="warp=off"; eg_col="$CR"; fi
  if [ "$GUARD" = 1 ]; then guard_txt="${CG}●${C0}"; else guard_txt="${CR}○${C0}"; fi

  printf '\n'
  printf '   %s%s%s   %s%s%s   %sexits %s/%s%s   %sserved %s%s   %s⚡ %s%s   %sguard%s %s\n' \
    "$lane_col" "$lane_txt" "$C0" "$eg_col" "$eg_txt" "$C0" \
    "$CGY" "$HEALTHY" "$ACTIVE" "$C0" "$CGY" "$SERVED" "$C0" "$CY" "$LAT" "$C0" "$CGY" "$C0" "$guard_txt"
  printf '   %sEGRESS%s    %s%s%s\n' "$CGY" "$C0" "$CU" "${IP:-—}" "$C0"
  printf '   %sOPENCODE%s  %s%s%s    %sWARP%s %s%s%s    %s%s%s\n' \
    "$CGY" "$C0" "$CG" "$OCV" "$C0" "$CGY" "$C0" "$CG" "${WARP_VER:-?}" "$C0" "$CD" "$now" "$C0"
}

draw_items() {
  local i label hint num
  printf '\n   %s────────────────────────────────────────────────────────%s\n' "$CD" "$C0"
  for i in "${!ITEMS[@]}"; do
    label="${ITEMS[$i]%%|*}"
    hint="${ITEMS[$i]#*|}"
    num=$(( (i + 1) % 10 ))
    if [ "$TTY" = 1 ] && [ "$i" = "$SEL" ]; then
      printf '  %s\033[7m ▸ %s  %-42s %-20s \033[0m%s\n' "$CB" "$num" "$label" "$hint" "$C0"
    else
      printf '     %s  %-42s %s%s%s\n' "$num" "$label" "$CD" "$hint" "$C0"
    fi
  done
  printf '   %s────────────────────────────────────────────────────────%s\n' "$CD" "$C0"
}

draw_footer() {
  printf '   %s↑↓ move · Enter select · 0-9 jump · r refresh · q quit%s\n' "$CD" "$C0"
}

draw() {
  [ "$TTY" = 1 ] && clear
  banner
  status_panel
  draw_items
  draw_footer
}

install_menu() {
  local c
  while true; do
    [ "$TTY" = 1 ] && clear
    printf '\n'
    printf '  %s╭────────────────────────────────────────────────────────╮%s\n' "$CY" "$C0"
    printf '    %sINSTALL / REPAIR%s\n' "$CB" "$C0"
    printf '  %s╰────────────────────────────────────────────────────────╯%s\n' "$CY" "$C0"
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
      1)
        [ "$TTY" = 1 ] && clear
        command -v pkg >/dev/null 2>&1 && pkg install -y opencode || printf '  ✗ pkg nahi mila\n'
        pause_key
        ;;
      2)
        [ "$TTY" = 1 ] && clear
        command -v pkg >/dev/null 2>&1 && pkg upgrade -y opencode || printf '  ✗ pkg nahi mila\n'
        pause_key
        ;;
      3)
        [ "$TTY" = 1 ] && clear
        if [ -f "$PKG_DIR/docs/OPENCODE-INSTALL.md" ]; then
          sed -n '1,80p' "$PKG_DIR/docs/OPENCODE-INSTALL.md"
        else
          printf '  https://github.com/jcz2020/opencode-termux\n'
          printf '  https://github.com/C04-wq/opencode-termux\n'
          printf '  https://github.com/Spectra010s/opencode-termux\n'
          printf '  https://github.com/bd-loser/opencode-bionic\n'
        fi
        pause_key
        ;;
      4)
        [ "$TTY" = 1 ] && clear
        install_freeflow
        pause_key
        ;;
      5)
        [ "$TTY" = 1 ] && clear
        if [ -f "$PKG_DIR/install-warp-lane.sh" ]; then
          OC_MENU_SKIP=1 bash "$PKG_DIR/install-warp-lane.sh"
        else
          bash "$DEST/scripts/warp-start.sh"
        fi
        pause_key
        ;;
      0|"") return 0 ;;
    esac
    refresh_status
  done
}

install_freeflow() {
  printf '\n  %sFREEFLOW — optional 58-provider fallback%s\n\n' "$CB" "$C0"
  printf '  WARP lane primary rahega; freeflow Plan B hai (WARP block/pool empty).\n'
  printf '  Providers ke free API keys chahiye (Groq, Gemini, NVIDIA, ...).\n\n'
  if ! command -v node >/dev/null 2>&1; then
    printf '  %s✗ node missing — pehle: pkg install nodejs%s\n' "$CR" "$C0"
    return 0
  fi
  local NV MAJ
  NV="$(node --version 2>/dev/null | sed 's/^v//')"
  MAJ="${NV%%.*}"
  if [ "${MAJ:-0}" -lt 22 ] 2>/dev/null; then
    printf '  %s✗ Node %s mila, 22+ chahiye — pkg install nodejs%s\n' "$CR" "$NV" "$C0"
    return 0
  fi
  printf '  Node v%s OK\n\n' "$NV"
  printf '  Install: npm install -g github:Ethos6/freeflow  [y/N]: '
  local ans
  IFS= read -r ans || ans=""
  case "$ans" in
    y|Y)
      npm install -g github:Ethos6/freeflow 2>&1 | tail -n 15
      printf '\n  Setup:\n'
      printf '    freeflow open            # dashboard (browser)\n'
      printf '    freeflow key groq        # API key add karo\n'
      printf '    freeflow use groq/...    # default model\n'
      printf '    freeflow opencode        # fallback ke saath opencode\n'
      ;;
    *) printf '  skipped\n' ;;
  esac
}

logs_menu() {
  local c f
  while true; do
    [ "$TTY" = 1 ] && clear
    printf '\n  %s╭────────────────────────────────────────────────────────╮%s\n' "$CU" "$C0"
    printf '    %sLOGS%s\n' "$CB" "$C0"
    printf '  %s╰────────────────────────────────────────────────────────╯%s\n' "$CU" "$C0"
    printf '\n'
    printf '    %s1%s  opencode.log        %s%s%s\n' "$CB" "$C0" "$CD" "$HOME/.local/share/opencode/log/opencode.log" "$C0"
    printf '    %s2%s  warp-minimal.log    %s%s%s\n' "$CB" "$C0" "$CD" "$DEST/logs/warp-minimal.log" "$C0"
    printf '    %s3%s  guard.log           %s%s%s\n' "$CB" "$C0" "$CD" "$DEST/guard/guard.log" "$C0"
    printf '    %s4%s  daemon.log          %s%s%s\n' "$CB" "$C0" "$CD" "$DEST/logs/daemon.log" "$C0"
    printf '    %s0%s  Back\n' "$CB" "$C0"
    printf '\n  Choose [0-4]: '
    IFS= read -r c || return 0
    case "$c" in
      1) f="$HOME/.local/share/opencode/log/opencode.log" ;;
      2) f="$DEST/logs/warp-minimal.log" ;;
      3) f="$DEST/guard/guard.log" ;;
      4) f="$DEST/logs/daemon.log" ;;
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
  printf '\n  %s╭────────────────────────────────────────────────────────╮%s\n' "$CG" "$C0"
  printf '    %sABOUT%s  %s·  opencode-unlimited warp lane%s\n' "$CB" "$C0" "$CG" "$C0"
  printf '  %s╰────────────────────────────────────────────────────────╯%s\n' "$CG" "$C0"
  printf '\n'
  printf '   %sUI%s        %s\n' "$CGY" "$C0" "$MENU_VER"
  printf '   %sWARP%s      %s\n' "$CGY" "$C0" "${WARP_VER:-?}  (Deury08/warp-minimal, MIT)"
  printf '   %sopencode%s  %s  (%s)\n' "$CGY" "$C0" "$OCV" "${OC:-—}"
  printf '   %sCredits%s   @ItzSagarOp\n' "$CGY" "$C0"
  printf '\n   %sSources (recent-first)%s\n' "$CB" "$C0"
  printf '     2026-11-15  Ethos6/freeflow            optional fallback (58 providers)\n'
  printf '     2026-11-14  Deury08/warp-minimal       core egress (v0.4.0)\n'
  printf '     2026-11-14  lipey1/opencode-warp-retry v2 retry hook (adapted)\n'
  printf '     2026-11-11  Suydev/opencode-unlimited-termux  lane layout reference\n'
  printf '     earlier     ELECTRONBREACH original concept\n'
  printf '\n   %sDocs%s\n' "$CB" "$C0"
  printf '     README-WARP-LANE.md · docs/RECOVERY.md · docs/GITHUB-SOURCES.md\n'
  pause_key
}

uninstall_confirm() {
  local ans
  printf '\n  %sUninstall lane? opencode + sessions safe rahenge. [y/N]: %s' "$CR" "$C0"
  IFS= read -r ans || ans=""
  case "$ans" in
    y|Y)
      [ "$TTY" = 1 ] && clear
      if [ -f "$PKG_DIR/uninstall-warp-lane.sh" ]; then
        bash "$PKG_DIR/uninstall-warp-lane.sh"
      else
        bash "$DEST/scripts/warp-stop.sh"
        rm -rf "$DEST"
      fi
      exit 0
      ;;
  esac
}

run_action() {
  local idx="$1"
  case "$idx" in
    0)
      [ "$TTY" = 1 ] && clear
      if [ -z "$OC" ]; then
        printf '  %s✗ opencode missing — Install/repair (2) chalao%s\n' "$CR" "$C0"
        pause_key
      else
        bash "$DEST/scripts/lane.sh" || true
        stty sane 2>/dev/null || true
      fi
      refresh_status
      ;;
    1) install_menu; refresh_status ;;
    2)
      [ "$TTY" = 1 ] && clear
      bash "$DEST/scripts/warp-start.sh"
      pause_key
      refresh_status
      ;;
    3)
      [ "$TTY" = 1 ] && clear
      bash "$DEST/scripts/warp-hop.sh"
      pause_key
      refresh_status
      ;;
    4)
      [ "$TTY" = 1 ] && clear
      bash "$DEST/scripts/warp-doctor.sh"
      pause_key
      refresh_status
      ;;
    5) logs_menu; refresh_status ;;
    6)
      [ "$TTY" = 1 ] && clear
      bash "$DEST/scripts/warp-upgrade.sh"
      pause_key
      refresh_status
      ;;
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
      '') run_action "$SEL" ;;
      [0-9])
        if [ "$key" = 0 ]; then run_action 9; else run_action $((key - 1)); fi
        ;;
      r|R) refresh_status ;;
      q|Q) clear; exit 0 ;;
    esac
  done
else
  while true; do
    banner
    status_panel
    draw_items
    printf '\n  Choose [0-9]: '
    IFS= read -r choice || exit 0
    case "$choice" in
      0) run_action 9 ;;
      1|2|3|4|5|6|7|8|9) run_action $((choice - 1)); refresh_status ;;
      *) ;;
    esac
  done
fi
