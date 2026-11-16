# Opencode Unlimited Usage — Termux Edition

**Made by @ItzSagarOp**

> **UPDATE 2026-11-15 — WORKING on this device, no root needed.**
> The conclusion below ("not possible") is superseded. `warp-minimal` provides
> userspace Cloudflare WARP MASQUE (QUIC/UDP 443) behind a local HTTP proxy —
> no `unshare`, no `warp-cli`, no TUN, no iptables, no systemd. proot is used
> only to supply `/etc/resolv.conf` for the Go binary.
>
> Install: `bash install-warp-lane.sh`
>
> Verified here: `curl -x http://127.0.0.1:8789 .../cdn-cgi/trace` → `warp=on`
> (`2a09:bac5:...`), and `opencode run "…LANE-OK"` → `LANE-OK`.
> Details: `README-WARP-LANE.md`, `docs/RECOVERY.md`, `docs/GITHUB-SOURCES.md`.

## Current quick start

```sh
pkg install nodejs            # optional (node 22+ for zycron-ai)
bash install-warp-lane.sh     # runtime + menu + plugin
opencode                      # menu: 1 opencode · 2 status
```

- Menu: `1` lane TUI, `2` status, `3` restart, `4` WARP rotate, `5` doctor,
  `6` logs, `7` about/updates, `8` uninstall, `9` exit.
- Direct: `oc` (menu), `opencode run "..."` (lane one-shot),
  `OC_MENU_SKIP=1 opencode` (stock TUI).
- zycron-ai: local-first AI chat + coding agent in `zycron-ai/`
  (`npm start`). See `zycron-ai/AGENTS.md`.

Termux (Android) adaptation of [opencode-unlimited-usage](https://github.com/sagarxmodder/opencode-unlimited-termux).

## What this is

The upstream project bypasses opencode's free-model daily usage wall on
Linux/WSL2 by rotating your Cloudflare WARP IPv6 /64 and the Cloudflare edge
used for `opencode.ai` requests. The upstream `install.sh` requires
Linux + systemd, so it stops on Termux with `systemd not found`.

This folder adds `install-termux.sh`, which is the Termux-adapted entry point.

## Termux status

- `/dev/net/tun` — present
- `unshare` binary — present
- `python3`, `curl`, `shuf` — present
- `systemctl` / `systemd` — **not available** (upstream installer cannot run)
- `warp-cli` — **not installed**
- `iptables` / `ip6tables` — **not available**
- `dig` — **not available**
- `sudo` — **not available**

## Feasibility test results (this device)

```
$ unshare -rm bash -c 'mount --bind /etc/hosts /etc/hosts && echo NAMESPACE_OK'
unshare: unshare failed: Invalid argument
EXIT=1
```

This is the critical blocker: the Android kernel on this device does not allow
unprivileged user namespaces, so `zen-lane` cannot create the mount namespace
that pins `opencode.ai` to a random Cloudflare edge and swaps in a fresh
`/etc/machine-id`. Without that namespace step, the per-launch identity
rotation (the actual bypass mechanism) cannot run.

The keeper/guard/hop pieces additionally need `iptables`/`ip6tables`,
`warp-cli`, `sudo` and a systemd-like service manager — none of which exist in
this Termux environment.

## Conclusion (superseded 2026-11-15)

The original `zen-lane` mechanism needs unprivileged user namespaces, a TUN
WARP kernel client, iptables and systemd — none available here, so *that*
mechanism cannot run:

1. Unprivileged user namespaces (`unshare -rm`) — blocked on this kernel.
2. Cloudflare WARP TUN tunnel + `warp-cli` — requires root/privileged networking.
3. `iptables`/`ip6tables` kill-switch — requires root.
4. systemd user services for keeper/guard — not present in Termux.

**But a working bypass now exists without any of those:** userspace WARP over
MASQUE (`warp-minimal`) behind a local HTTP proxy, with `proot` only for DNS.
See the update at the top and `README-WARP-LANE.md`.

## Options that actually work

- **This Termux device, no root**: `bash install-warp-lane.sh` (working now).
- **Linux / WSL2 / VPS** with systemd: upstream `install.sh` as-is.
- **Rooted Android**: root + WARP + iptables may allow the upstream lane.

## Files

- `install-warp-lane.sh` — **working Termux lane installer (no root)**
- `uninstall-warp-lane.sh` — removes the warp lane only
- `README-WARP-LANE.md` — lane usage, verification, limits
- `zycron-ai/` — local-first AI chat + coding agent (free-model routing, approvals, workspace)
- `bin/` — warp-minimal binary + opencode shim + SHA-256
- `scripts/` — menu, lane, start/stop, hop, guard, doctor
- `plugin/opencode-warp-retry/` — opencode v2 auto-retry plugin
- `plugin/opencode-unlimited-lane/` — opencode v1 quota bypass + context guard
- `docs/` — recovery log, GitHub sources, opencode install help
- `install-termux.sh` — earlier feasibility checker (kept for history)
- `install.sh` — on Termux redirects to `install-warp-lane.sh`; on Linux runs the upstream systemd installer
- `uninstall.sh` — upstream uninstaller
- `scripts/zen-*.sh` — upstream lane scripts (reference)
- `README.md` — upstream documentation

— Made by @ItzSagarOp
