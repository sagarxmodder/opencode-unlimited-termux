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

- `~/opencode-unlimited-termux` cloned (opencode-unlimited-usage).
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
- **NO_PROXY** — the lane exports a `NO_PROXY` list (GitHub, npm, apt, PyPI)
  so tooling inside a session does not go through the WARP exit. GitHub's API
  answers `502 CONNECT tunnel failed` from Cloudflare WARP exits, which broke
  API access; those hosts now stay direct while `opencode.ai` stays on WARP.
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

## Later same day — freecode UX, lane menu, hardening

- **freecode REPL UI:** banner me model + session + message count; prompt
  `freecode [model · s:xxxx] ›`; `/model` numbered ready-model picker;
  `/sessions` list + `/session <n|id>` switch; `/clear`, `/continue`, richer
  `/status` (provider, cooldowns, session file); Tab completion for commands,
  model ids and session ids.
- **Piped REPL input:** `rl.question` buffered lines drop kar raha tha; ab
  persistent line queue hai, isliye scripts/tests ke multi-line input par
  har command chalta hai.
- **HTTPS proxy:** `ProxyAgent` ko `https.Agent` extend karna padta hai;
  `http.Agent` par `Protocol "https:" not supported. Expected "http:"` aata
  tha. Local CONNECT regression test added.
- **Menu opencode detection:** `OC` sirf background subshell me set ho raha
  tha, isliye menu opencode ko missing samajh kar auto-install loop karta tha.
  Ab `refresh_status` ke start me set hota hai.
- **Ship freecode:** lane installer `$DEST/freecode` copy karta hai aur node
  milne par wrapper install karta hai; uninstaller sirf apna wrapper hatata hai.
- **Hermetic CLI tests:** test config me LLM7/LM Studio/Pollinations keyless
  off, aur live proxy/key env vars cleared — suite local fake server par chalti
  hai (41 tests; Node 24+ ke liye `node --test test/*.test.js`).
- **Fail summary:** ModelPool ab `all N free models failed — <first>: <reason>
  (+N more)` deta hai instead of last model ka ECONNREFUSED.
- **Install/uninstall UI:** warp lane installer + uninstaller ab menu jaisi
  card UI, step progress aur summary footer use karte hain. Uninstaller
  `$DEST/scripts/uninstall-warp-lane.sh` par bhi ship hota hai.
- **freecode opencode-style UI:** card banner, framed composer, assistant
  block, braille spinner, timing/usage footer; bare picker numbers select
  karte hain. Spinner har delta par line clear karke stream mita raha tha
  (stray `?`), ab sirf ek baar clear hota hai.
- **Small fixes:** `edit` `$&`/`$1` literals, non-object config guard,
  strict-cwd `--continue`, guard log path, plugin nested-copy cleanup,
  uninstaller credit casing. Tests 41.
- **Device cleanup:** toota `hope2333-mirrorlist` dpkg record
  `--force-remove-reinstreq` se hataya; custom apt sources intact hain.

## Remaining limits

- Cloudflare's WARP pool is shared. A rotation can occasionally hand back a
  block that is already spent; `opencode-unlimited-hop` retries.
- The free-tier wall is per egress block and resets around 00:00 UTC. Rotation
  multiplies blocks; it does not remove the upstream limit.
- On opencode v1 the failed message is not auto-resumed (no v2 retry hook);
  re-send it. The v2 retry plugin is included and installs automatically on v2.
- No kill-switch: the lane is explicit-proxy only. If the daemon dies,
  opencode fails rather than silently going direct.
