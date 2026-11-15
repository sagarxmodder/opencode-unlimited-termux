# Recovery log — unfinished "Greeting and intro" work

Date: 2026-11-15
Device: Termux / Android 11 (SDK 30), aarch64, non-root
opencode: v1.19.5

## Where the old session stopped

Session `ses_e274c24e7ffeR64qVbCcTyMXxL` ("Greeting and intro main") ended right
after this test:

```
$ ~/.local/bin/opencode --version
timeout: failed to run command '/data/data/com.termux/files/home/.local/bin/opencode':
No such file or directory
```

State at that moment:

- `~/opencode-unlimited-termux` cloned (ElectronBreach/opencode-unlimited-usage).
- Scripts copied to `~/.local/share/opencode-unlimited/scripts/`.
- Shim written to `~/.local/bin/opencode`.
- No successful launch through the lane.

## Why it failed

1. Shim shebang was `#!/usr/bin/env bash`. Termux has no `/usr/bin/env`; the
   kernel could not find the interpreter, hence "No such file or directory".
2. `zen-lane.sh` requires a mount namespace (`unshare -rm`) to bind a private
   `/etc/hosts` and `/etc/machine-id`. On this device:
   - `unshare -m`   → EPERM
   - `unshare -rm`  → EINVAL  (unprivileged user namespaces are disabled)
3. No root / `su`, no `warp-cli`, no `iptables`, no systemd.
4. A Go binary on Android also has no `/etc/resolv.conf` (only `/system/etc`),
   so WARP registration by a static Go program cannot resolve
   `api.cloudflareclient.com` without help.

## What works now

The lane was rebuilt around a userspace WARP client instead of `warp-cli`/TUN:

```
opencode
  └─ HTTPS_PROXY / HTTP_PROXY / ALL_PROXY = http://127.0.0.1:8789
       └─ warp-minimal (userspace Cloudflare WARP MASQUE, QUIC/UDP 443)
            └─ rotating WARP IPv6 /64 egress
```

Pieces:

- **warp-minimal v0.4.0** (`Deury08/warp-minimal`, linux/arm64, MIT).
  No root, no TUN, no systemd. HTTP proxy on `127.0.0.1:8789`, pool of 2
  exits, auto-rotation on upstream `429/403`, IPv6-only egress, uTLS with a
  Bun-like ClientHello. Release tarball SHA-256 verified:
  `16914aa8213c94e7c0a7eb9085fe13fd3152db0d125fe1ce06f86822f4f8b031`.
- **proot** only for one thing: bind `$PREFIX/etc/resolv.conf` over
  `/etc/resolv.conf` so the Go binary can resolve the WARP API. The proxy
  itself is still plain userspace; no elevated privileges anywhere.
- **CA bundle** — the start script exports
  `SSL_CERT_FILE=$PREFIX/etc/tls/cert.pem`. Without it, some shells start the
  daemon without the variable and Go fails WARP registration with
  `x509: certificate signed by unknown authority`.
- **opencode proxy env** — verified empirically: a local CONNECT logger saw
  `CONNECT models.opencode.ai:443` and `CONNECT opencode.ai:443` from
  opencode 1.19.5.
- **lane / guard / hop / doctor** — Termux bash scripts, background jobs,
  no systemd.

## Verification (this device, 2026-11-15)

```
$ curl -x http://127.0.0.1:8789 https://www.cloudflare.com/cdn-cgi/trace
ip=2a09:bac5:4065:1a96::2a6:6d
warp=on
...

$ HTTPS_PROXY=http://127.0.0.1:8789 opencode run "Reply with exactly: LANE-OK"
> build · deepseek-v4.1-flash-free
LANE-OK
```

Two healthy WARP exits were registered; the proxy reported
`"healthy":2, "active":2`.

## Remaining limits

- Cloudflare's WARP pool is shared. A rotation can occasionally hand back a
  block that is already spent; `opencode-unlimited-hop` retries.
- The free-tier wall is per egress block and resets around 00:00 UTC. Rotation
  multiplies blocks; it does not remove the upstream limit.
- On opencode v1 the failed message is not auto-resumed (no v2 retry hook);
  re-send it. The v2 retry plugin is included and installs automatically on v2.
- No kill-switch: the lane is explicit-proxy only. If the daemon dies,
  opencode fails rather than silently going direct.
