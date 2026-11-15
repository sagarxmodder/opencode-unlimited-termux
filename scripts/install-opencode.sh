#!/data/data/com.termux/files/usr/bin/bash
# Install opencode when the warp lane needs it.
# Tries the Termux package first, then the official npm distribution,
# verifies the binary actually runs, and prints manual options on failure.
set -u

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"

say()  { printf '        %s\n' "$*"; }
ok()   { printf '        \033[38;5;46m✓\033[0m %s\n' "$*"; }
warn() { printf '        \033[38;5;226m!\033[0m %s\n' "$*"; }
bad()  { printf '        \033[38;5;203m✗\033[0m %s\n' "$*"; }

is_real() {
  [ -x "$1" ] || return 1
  case "$1" in "$HOME/.local/bin/opencode") return 1 ;; esac
  ! grep -q "opencode-unlimited-warp" "$1" 2>/dev/null
}

find_real() {
  local c
  for c in "$PREFIX/bin/opencode" "$HOME/.opencode/bin/opencode" \
           "/usr/local/bin/opencode" "/usr/bin/opencode"; do
    if is_real "$c" && "$c" --version >/dev/null 2>&1; then printf '%s\n' "$c"; return 0; fi
  done
  c="$(command -v opencode 2>/dev/null || true)"
  if [ -n "$c" ] && is_real "$c" && "$c" --version >/dev/null 2>&1; then
    printf '%s\n' "$c"
    return 0
  fi
  return 1
}

verify() {
  local c v
  c="$(find_real || true)"
  [ -z "$c" ] && return 1
  v="$("$c" --version 2>/dev/null | head -n1)"
  case "$v" in
    [0-9]*) ok "opencode $v  ($c)"; return 0 ;;
    *) bad "installed, par version check fail: $c"; return 1 ;;
  esac
}

printf '\n  opencode install check\n\n'

if verify; then
  say "already installed — kuch karne ki zaroorat nahi."
  exit 0
fi

bad "opencode nahi mila — auto-install try kar raha hoon"

if command -v pkg >/dev/null 2>&1; then
  say "pkg install -y opencode ..."
  if pkg install -y opencode >/dev/null 2>&1; then
    ok "Termux package step complete"
  else
    warn "pkg install fail (package/repo available nahi)"
  fi
  verify && exit 0
else
  warn "pkg nahi mila (Termux ke bahar?)"
fi

if command -v npm >/dev/null 2>&1; then
  say "npm install -g opencode-ai ..."
  if npm install -g opencode-ai >/dev/null 2>&1; then
    ok "npm step complete"
  else
    warn "npm install fail"
  fi
  verify && exit 0
else
  warn "npm nahi mila"
fi

printf '\n'
bad "auto-install fail ho gaya"
printf '%s\n' \
  '        Manual options:' \
  '          1) pkg install opencode' \
  '          2) npm install -g opencode-ai' \
  '          3) Native Termux builds (Android 11+ / bionic fix):' \
  '             https://github.com/jcz2020/opencode-termux' \
  '             https://github.com/C04-wq/opencode-termux' \
  '             https://github.com/Spectra010s/opencode-termux' \
  '' \
  '        Docs: docs/OPENCODE-INSTALL.md'
exit 1
