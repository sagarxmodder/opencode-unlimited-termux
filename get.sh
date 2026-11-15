#!/data/data/com.termux/files/usr/bin/bash
# opencode-unlimited lane — one-line bootstrap for Termux
#
#   curl -fsSL https://raw.githubusercontent.com/sagarxmodder/opencode-unlimited-termux/main/get.sh | bash
#
# Downloads the repo tarball (scripts + warp-minimal + plugin), then runs
# install-warp-lane.sh from it. No git, no root, no systemd.
set -u

REPO="${OUC_REPO:-sagarxmodder/opencode-unlimited-termux}"
BRANCH="${OUC_BRANCH:-main}"
TMPBASE="${TMPDIR:-${PREFIX:-/tmp}/tmp}"
TMP="$TMPBASE/ouc-lane.$$"
URL="https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH"

say() { printf '  %s\n' "$*"; }
die() { printf '  ✗ %s\n' "$*" >&2; exit 1; }

case "$(uname -m 2>/dev/null)" in
  aarch64|arm64) ;;
  *) die "arm64 only (device: $(uname -m 2>/dev/null))" ;;
esac
case "${PREFIX:-}" in
  *com.termux*) ;;
  *) say "warning: PREFIX is not Termux ('${PREFIX:-unset}') — continuing anyway" ;;
esac

command -v curl >/dev/null 2>&1 || die "curl chahiye: pkg install curl"
command -v tar  >/dev/null 2>&1 || die "tar chahiye: pkg install tar"

mkdir -p "$TMP" || die "cannot create $TMP"
say "fetching $REPO@$BRANCH"
if ! curl -fsSL "$URL" | tar -xz -C "$TMP" --strip-components=1; then
  rm -rf "$TMP"
  die "download failed (network/Codeload) — retry, ya: git clone https://github.com/$REPO"
fi

[ -f "$TMP/install-warp-lane.sh" ] || { rm -rf "$TMP"; die "installer not found in tarball"; }
[ -x "$TMP/bin/warp-minimal" ] || chmod 700 "$TMP/bin/warp-minimal" 2>/dev/null || true

exec bash "$TMP/install-warp-lane.sh" "$@"
