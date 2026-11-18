#!/data/data/com.termux/files/usr/bin/bash
# heal — one pass that makes the lane match whatever opencode is installed.
#
# The launcher shim normally heals; this is the manual form (and what the menu
# calls). It never touches the user's pin or version choice:
#
#   tunnel    warp-start (health + exits, respawns server, guard)
#   guard     respawn the exit-failure guard if it died
#   builds    oc-ver adopt: import any opencode the user updated, repoint the
#             entry so the pin stays in charge, prune nothing
#   shim      copy the current shim to $DEST/bin and ~/.local/bin/opencode
#   links     ~/.local/bin/{oc,oc-ver,hop,doctor,start,stop,heal} symlinks
#   plugin    opencode >= 2 -> plugins/opencode-warp-retry + config add
#             opencode 1.x  -> plugins/opencode-unlimited-lane.ts + config
#   PATH      the ~/.local/bin rc block, if missing
#
# Nothing here rewrites your model choices or compaction settings; the config
# helper only adds/repairs the pieces the lane owns.
#
#   heal            full pass
#   heal --fast     tunnel + guard only (seconds)
#   heal --auto     silent no-op when nothing changed since the last pass
#   heal --gate     exit 0 = consistent, 1 = drift (prints the drift)
set -u

DEST="${OUC_WARP_DEST:-$HOME/.local/share/opencode-unlimited-warp}"
PROXY="${OUC_WARP_PROXY:-http://127.0.0.1:8789}"
ENTRY="${PREFIX:-}/bin/opencode"
BUILDS="$DEST/builds"
PIN="$DEST/active-bin"
LOGS="$DEST/logs"
RUN="$DEST/run"
FP="$DEST/heal.fp"
HEAL_LOG="$LOGS/heal.log"

MODE=full
QUIET=0
for a in "$@"; do
  case "$a" in
    --fast) MODE=fast ;;
    --auto) MODE=auto ;;
    --gate) MODE=gate ;;
    -q|--quiet) QUIET=1 ;;
    -h|--help|help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $a (try: heal --help)" >&2; exit 2 ;;
  esac
done

ok()   { [ "$QUIET" -eq 1 ] || printf '  ok   %s\n' "$*"; }
warn() { printf '  warn %s\n' "$*" >&2; }
say()  { [ "$QUIET" -eq 1 ] || printf '\n%s\n' "$*"; }
note() { [ "$QUIET" -eq 1 ] || printf '  ·    %s\n' "$*"; }

repairs=""
repair() {
  printf '[%s] %s\n' "$(date '+%F %T')" "$*" >> "$HEAL_LOG" 2>/dev/null || true
  repairs="${repairs}${repairs:+, }$*"
}

if [ ! -d "$DEST" ]; then
  echo "[x] lane not installed: $DEST" >&2
  echo "    run: bash install-warp-lane.sh" >&2
  exit 1
fi

# One heal at a time. A menu tap during a shim heal waits for this lock.
LOCK="$RUN/heal.lock"
mkdir -p "$RUN" "$LOGS" 2>/dev/null || true
if ! mkdir "$LOCK" 2>/dev/null; then
  lp="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -n "$lp" ] && kill -0 "$lp" 2>/dev/null; then
    [ "$MODE" = gate ] && { echo "heal already running (pid $lp)" >&2; exit 2; }
    for _ in $(seq 1 20); do sleep 0.2; [ -d "$LOCK" ] || break; done
    [ -d "$LOCK" ] && { echo "heal busy (pid $lp)" >&2; exit 2; }
  else
    rm -rf "$LOCK" 2>/dev/null || true
    mkdir "$LOCK" 2>/dev/null || exit 2
  fi
fi
printf '%s\n' "$$" > "$LOCK/pid"
trap 'rm -rf "$LOCK" 2>/dev/null' EXIT INT TERM

# canonical sources: installed copy wins, repo copy is the dev fallback
SELF="$(readlink -f "$0" 2>/dev/null || printf '%s' "$0")"
SELF_DIR="${SELF%/*}"
REPO=""
[ -f "$SELF_DIR/../plugin/opencode-unlimited-lane/index.ts" ] && REPO="$(cd "$SELF_DIR/.." && pwd)"

cfg_tool() {
  local t="$DEST/scripts/config-util.py"
  if [ -n "$REPO" ] && [ -f "$REPO/scripts/config-util.py" ]; then
    cmp -s "$REPO/scripts/config-util.py" "$t" || { cp "$REPO/scripts/config-util.py" "$t"; repair "config-util.py synced"; }
  fi
  [ -x "$t" ] || chmod 700 "$t" 2>/dev/null || true
  [ -f "$t" ] && printf '%s\n' "$t"
}

real_bin() {
  local c pick="" r
  if [ -r "$PIN" ]; then
    IFS= read -r c < "$PIN" || c=""
    [ -n "$c" ] && [ -x "$c" ] && { printf '%s\n' "$c"; return 0; }
  fi
  for c in "$BUILDS"/*/opencode; do [ -x "$c" ] && pick="$c"; done
  [ -n "$pick" ] && { printf '%s\n' "$pick"; return 0; }
  r="$(readlink -f "$ENTRY" 2>/dev/null || true)"
  [ -n "$r" ] && [ -x "$r" ] && { printf '%s\n' "$r"; return 0; }
  return 1
}

ver_of() {
  case "$1" in
    "$BUILDS"/*) basename "$(dirname "$1")"; return 0 ;;
    *) "$1" --version 2>/dev/null | head -n1 ;;
  esac
}

major_of() {
  local v="$1"
  printf '%s' "$v" | grep -oE '[0-9]+' | head -n1
}

fingerprint() {
  local r v
  r="$(real_bin || true)"
  if [ -z "$r" ]; then printf 'none\n'; return 0; fi
  v="$(ver_of "$r")"
  case "$(major_of "$v")" in
    2|3|4|5|6|7|8|9)
      printf 'v2 %s %s %s\n' "$r" "$v" \
        "$(md5sum "$HOME/.config/opencode/plugins/opencode-warp-retry"/*.ts 2>/dev/null | md5sum | cut -d' ' -f1)" ;;
    *)
      printf 'v1 %s %s %s\n' "$r" "$v" "$(md5sum "$HOME/.config/opencode/plugins/opencode-unlimited-lane.ts" 2>/dev/null | cut -d' ' -f1 || echo nofile)" ;;
  esac
}

# ------------------------------------------------------------------ tunnel
tunnel_ok() {
  curl -s --noproxy '*' -m 2 "$PROXY/health" 2>/dev/null | grep -q '"healthy":[1-9]'
}

ensure_tunnel() {
  if tunnel_ok; then ok "tunnel healthy"; return 0; fi
  warn "tunnel down — starting"
  bash "$DEST/scripts/warp-start.sh" 2>&1 | sed 's/^/       /' || true
  if tunnel_ok; then repair "tunnel restarted (warp-start)"; ok "tunnel up"; return 0; fi
  warn "tunnel still down — run: opencode-unlimited-doctor"
  return 1
}

ensure_guard() {
  if pgrep -f "$DEST/scripts/warp-guard.sh" >/dev/null 2>&1; then ok "guard running"; return 0; fi
  nohup bash "$DEST/scripts/warp-guard.sh" >> "$LOGS/guard.log" 2>&1 &
  echo $! > "$RUN/guard.pid"
  repair "guard respawned"
  ok "guard respawned"
}

# keep the guard log from growing without bound on a phone
rotate_logs() {
  local f
  for f in "$LOGS/guard.log" "$HEAL_LOG"; do
    [ -f "$f" ] || continue
    [ "$(wc -c < "$f" 2>/dev/null || echo 0)" -gt 524288 ] || continue
    tail -n 400 "$f" > "$f.tmp" 2>/dev/null && mv "$f.tmp" "$f"
  done
}

# ------------------------------------------------------------------ shim
ensure_shim() {
  local src="$DEST/bin/opencode-shim" tgt="$HOME/.local/bin/opencode"
  if [ -n "$REPO" ] && [ -f "$REPO/bin/opencode-shim" ]; then
    cmp -s "$REPO/bin/opencode-shim" "$src" || { cp "$REPO/bin/opencode-shim" "$src"; repair "shim synced from repo"; }
  fi
  [ -f "$src" ] || { warn "shim missing: $src"; return 1; }
  chmod 700 "$src" 2>/dev/null || true
  mkdir -p "$HOME/.local/bin"
  if ! cmp -s "$src" "$tgt"; then
    cp "$src" "$tgt" && chmod 700 "$tgt"
    repair "~/.local/bin/opencode shim synced"
    ok "shim synced (~/.local/bin/opencode)"
  else
    ok "shim up to date"
  fi
}

ensure_links() {
  local l
  mkdir -p "$HOME/.local/bin"
  for l in "oc:menu.sh" "oc-ver:oc-ver" "hop:warp-hop.sh" "doctor:warp-doctor.sh" \
           "start:warp-start.sh" "stop:warp-stop.sh" "heal:heal.sh" \
           "opencode-unlimited-hop:warp-hop.sh" "opencode-unlimited-doctor:warp-doctor.sh" \
           "opencode-unlimited-start:warp-start.sh" "opencode-unlimited-stop:warp-stop.sh"; do
    [ -f "$DEST/scripts/${l#*:}" ] || continue
    [ "$(readlink "$HOME/.local/bin/${l%%:*}" 2>/dev/null)" = "$DEST/scripts/${l#*:}" ] && continue
    ln -sfn "$DEST/scripts/${l#*:}" "$HOME/.local/bin/${l%%:*}"
    repair "link ${l%%:*}"
  done
  ok "launchers linked"
}

ensure_path() {
  local rc
  for rc in "$HOME/.bashrc" "$HOME/.profile"; do
    [ -f "$rc" ] || continue
    grep -q "# opencode-unlimited-warp PATH" "$rc" 2>/dev/null && continue
    printf '\n# opencode-unlimited-warp PATH\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$rc"
    repair "PATH block in ${rc/#$HOME/~}"
    ok "PATH → ${rc/#$HOME/~}"
  done
}

# ------------------------------------------------------------------ builds
ensure_builds() {
  local before after
  before="$(ls -d "$BUILDS"/*/ 2>/dev/null | wc -l)"
  bash "$DEST/scripts/oc-ver" adopt >/dev/null 2>&1 || { warn "oc-ver adopt failed"; return 1; }
  after="$(ls -d "$BUILDS"/*/ 2>/dev/null | wc -l)"
  [ "$before" != "$after" ] && repair "imported opencode builds ($before -> $after)" && ok "imported new opencode build(s)"
  [ -s "$PIN" ] || { warn "pin empty after adopt"; return 1; }
  ok "builds: $(basename "$(dirname "$(cat "$PIN")")") active"
}

# ------------------------------------------------------------------ plugin
config_file() {
  local f
  for f in "$HOME/.config/opencode/opencode.json" "$HOME/.config/opencode/opencode.jsonc"; do
    [ -f "$f" ] && { printf '%s\n' "$f"; return 0; }
  done
  return 1
}

heal_plugin() {
  local r v maj tool src tgt cfg out
  r="$(real_bin || true)"
  if [ -z "$r" ]; then warn "no opencode binary — plugin heal skipped"; return 1; fi
  v="$(ver_of "$r")"
  maj="$(major_of "$v")"
  tool="$(cfg_tool || true)"
  cfg="$(config_file || true)"

  if [ "${maj:-0}" -ge 2 ]; then
    src="$DEST/plugin/opencode-warp-retry"
    [ -d "$src" ] || [ -n "$REPO" ] && [ -d "$REPO/plugin/opencode-warp-retry" ] && src="$REPO/plugin/opencode-warp-retry"
    tgt="$HOME/.config/opencode/plugins/opencode-warp-retry"
    mkdir -p "$HOME/.config/opencode/plugins"
    if [ -d "$src" ]; then
      if [ ! -d "$tgt" ] || ! diff -r "$src" "$tgt" >/dev/null 2>&1; then
        rm -rf "$tgt" && cp -r "$src" "$tgt"
        repair "v2 plugin synced (opencode $v)"
        ok "v2 plugin synced ($v)"
      else
        ok "v2 plugin up to date ($v)"
      fi
    else
      warn "v2 plugin source missing: $src"
    fi
    # a v1 flat file is inert on v2 but confusing on downgrade; leave it.
    if [ -n "$cfg" ] && [ -n "$tool" ]; then
      out="$(python3 "$tool" v2-add "$cfg" "$tgt" "$PROXY" 2>&1 || true)"
      case "$out" in
        changed*)  repair "config v2 (warp-retry plugin + hooks)"; ok "config updated ($(basename "$cfg"))" ;;
        unchanged) ok "config already set ($(basename "$cfg"))" ;;
        *)         warn "config update skipped: $out" ;;
      esac
    else
      warn "config/helper missing — plugin copy only"
    fi
  else
    src="$HOME/.config/opencode/plugins/opencode-unlimited-lane.ts"
    if [ -n "$REPO" ] && [ -f "$REPO/plugin/opencode-unlimited-lane/index.ts" ]; then
      src="$REPO/plugin/opencode-unlimited-lane/index.ts"
    elif [ -f "$DEST/plugin/opencode-unlimited-lane/index.ts" ]; then
      src="$DEST/plugin/opencode-unlimited-lane/index.ts"
    fi
    tgt="$HOME/.config/opencode/plugins/opencode-unlimited-lane.ts"
    mkdir -p "$HOME/.config/opencode/plugins"
    if [ -f "$src" ]; then
      if ! cmp -s "$src" "$tgt"; then
        cp "$src" "$tgt" && chmod 600 "$tgt"
        repair "v1 plugin synced (opencode $v)"
        ok "v1 plugin synced ($v)"
      else
        ok "v1 plugin up to date ($v)"
      fi
    else
      warn "v1 plugin source missing"
    fi
    # leftovers from a 1.20.x experiment: hooks dir plugin, inert on v1
    if [ -d "$HOME/.config/opencode/plugins/opencode-warp-retry" ]; then
      rm -rf "$HOME/.config/opencode/plugins/opencode-warp-retry" && repair "removed v2 plugin dir (v1 active)"
    fi
    if [ -n "$cfg" ] && [ -n "$tool" ]; then
      out="$(python3 "$tool" v1-compaction "$cfg" 2>&1 || true)"
      case "$out" in
        changed*)  repair "config v1 (compaction + plugin keys)"; ok "config updated ($(basename "$cfg"))" ;;
        unchanged) ok "config already set ($(basename "$cfg"))" ;;
        *)         warn "config update skipped: $out" ;;
      esac
    else
      warn "config/helper missing — plugin copy only"
    fi
  fi
}

# ------------------------------------------------------------------ gate
fp_cur="$(fingerprint)"
fp_old="$(cat "$FP" 2>/dev/null || true)"

if [ "$MODE" = gate ]; then
  [ "$fp_cur" = "$fp_old" ] && { tunnel_ok || { echo "tunnel down"; exit 1; }; exit 0; }
  echo "drift: opencode/plugin changed since last heal"
  exit 1
fi

if [ "$MODE" = auto ]; then
  if [ "$fp_cur" = "$fp_old" ] && tunnel_ok && pgrep -f "$DEST/scripts/warp-guard.sh" >/dev/null 2>&1; then
    ok "lane consistent (${fp_cur%% *})"
    exit 0
  fi
  MODE=fast
fi

if [ "$MODE" = fast ]; then
  ensure_tunnel || exit 1
  ensure_guard
  printf '%s\n' "$fp_cur" > "$FP"
  [ -n "$repairs" ] && printf '  repairs: %s\n' "$repairs"
  exit 0
fi

# ------------------------------------------------------------------ full
tunnel_down=0
ensure_tunnel || tunnel_down=1
ensure_guard
ensure_builds || true
ensure_shim || tunnel_down=1
ensure_links
ensure_path
heal_plugin || true
rotate_logs

printf '%s\n' "$(fingerprint)" > "$FP"

say "heal done"
if [ -n "$repairs" ]; then
  printf '  repairs: %s\n' "$repairs"
fi
if [ "$tunnel_down" -eq 1 ]; then
  warn "lane is still not usable — opencode-unlimited-doctor for details"
  exit 1
fi
