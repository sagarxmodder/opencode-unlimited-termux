#!/data/data/com.termux/files/usr/bin/bash
# opencode-unlimited warp lane (Termux / Android, no root)
#
# opencode -> HTTPS_PROXY/HTTP_PROXY/ALL_PROXY -> warp-minimal (localhost)
# -> Cloudflare WARP MASQUE (userspace, IPv6) -> fresh /64 on 429/403.
#
# opencode 1.19.5+ honours the proxy environment variables (verified on this
# device: CONNECT models.opencode.ai:443 through the local proxy).
set -u

DEST="${OUC_WARP_DEST:-$HOME/.local/share/opencode-unlimited-warp}"
PROXY="${OUC_WARP_PROXY:-http://127.0.0.1:8789}"
REAL="${OUC_REAL_BIN:-}"

if [ ! -d "$DEST" ]; then
  echo "[x] lane not installed: $DEST" >&2
  echo "    run: bash install-warp-lane.sh" >&2
  exit 1
fi

# Which opencode runs. Version-agnostic on purpose: whatever `oc-ver` pinned
# wins, then the plain prefix entry (a symlink or a package binary), then any
# versioned build left in the prefix. No build is hardcoded as the default.
resolve_real() {
  local c pick=""
  if [ -n "$REAL" ]; then printf '%s\n' "$REAL"; return 0; fi
  if [ -f "$DEST/active-bin" ]; then
    IFS= read -r c < "$DEST/active-bin" || c=""
    if [ -n "$c" ] && [ -x "$c" ]; then printf '%s\n' "$c"; return 0; fi
  fi
  for c in "${PREFIX:-/data/data/com.termux/files/usr}/bin/opencode" \
           "$HOME/.opencode/bin/opencode"; do
    if [ -x "$c" ] && [ "$(readlink -f "$c" 2>/dev/null)" != "$(readlink -f "$0" 2>/dev/null)" ]; then
      printf '%s\n' "$c"; return 0
    fi
  done
  for c in "${PREFIX:-/data/data/com.termux/files/usr}/bin"/opencode-[0-9]*; do
    [ -x "$c" ] || continue
    pick="$c"
  done
  [ -n "$pick" ] && { printf '%s\n' "$pick"; return 0; }
  return 1
}

if [ -z "$REAL" ]; then
  REAL="$(resolve_real || true)"
fi
export OUC_ACTIVE_BIN="$REAL"

if [ -z "$REAL" ]; then
  cat >&2 <<'EOF'
[x] opencode install nahi hai.

Termux par install:
    pkg update && pkg install opencode

Agar Android 11+ par TUI crash hota hai (Pointer exceeds safe integer range),
yeh native Termux builds try karo (Nov 13-14, 2026):
    https://github.com/jcz2020/opencode-termux      # heap-tag / TUI fix
    https://github.com/C04-wq/opencode-termux        # verified arm64 installer
    https://github.com/Spectra010s/opencode-termux   # bionic builds

Phir dobara chalao:  opencode
EOF
  exit 127
fi

if ! curl -s --noproxy '*' -m 2 "$PROXY/health" 2>/dev/null | grep -q '"healthy":[1-9]'; then
  bash "$DEST/scripts/warp-start.sh" >&2 || exit 1
fi

export HTTPS_PROXY="$PROXY"
export HTTP_PROXY="$PROXY"
export ALL_PROXY="$PROXY"
export https_proxy="$PROXY"
export http_proxy="$PROXY"
export all_proxy="$PROXY"

# Keep code/dev hosts DIRECT: the WARP exit is for opencode.ai's quota bucket.
# GitHub API / npm / registries over WARP often get refused (502) which would
# break tooling inside the session.
NO_PROXY_LIST="localhost,127.0.0.1,::1,api.github.com,github.com,raw.githubusercontent.com,objects.githubusercontent.com,codeload.github.com,registry.npmjs.org,registry.npmjs.com,npmjs.org,pypi.org,files.pythonhosted.org,proxy.golang.org,sum.golang.org,deb.debian.org,packages.termux.dev,termux.dev,googleapis.com,gstatic.com"
export NO_PROXY="$NO_PROXY_LIST"
export no_proxy="$NO_PROXY_LIST"

exec "$REAL" "$@"
