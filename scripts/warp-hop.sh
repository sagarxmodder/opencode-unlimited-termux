#!/data/data/com.termux/files/usr/bin/bash
# Manual identity rotation: recycle the WARP exit pool and show the new egress.
set -u

PROXY="${OUC_WARP_PROXY:-http://127.0.0.1:8789}"

egress() {
  curl -sS --noproxy "" -m 15 -x "$PROXY" https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null \
    | grep '^ip=' | cut -d= -f2
}

BEFORE="$(egress)"
echo "old egress: ${BEFORE:-?}"

if ! curl -s --noproxy '*' -m 10 -X POST "$PROXY/recycle" >/dev/null 2>&1; then
  echo "[x] recycle failed — is warp-minimal running?" >&2
  exit 1
fi
echo "-- rotating WARP exits --"

AFTER=""
for _ in $(seq 1 25); do
  sleep 1
  AFTER="$(egress)"
  if [ -n "$AFTER" ] && [ "$AFTER" != "$BEFORE" ]; then
    break
  fi
done

echo "new egress: ${AFTER:-?}"
if [ -n "$AFTER" ] && [ "$AFTER" != "$BEFORE" ]; then
  echo "== fresh WARP /64 — message dobara bhejo =="
  exit 0
fi
echo "== same block aaya — phir se chalao (Cloudflare pool shared hai) =="
exit 1
