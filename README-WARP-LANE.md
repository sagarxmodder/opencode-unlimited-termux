# opencode-unlimited warp lane — Termux (no root)

**Prepared for @ItzSagarOp · 2026-11-15**

Working bypass for opencode's free-tier usage wall on this exact device
(Termux, Android 11, aarch64, non-root) — **without** `unshare`, `warp-cli`,
`iptables`, `sudo`, or systemd.

```
opencode
  └─ HTTPS_PROXY=http://127.0.0.1:8789
       └─ warp-minimal v0.4.0 (Cloudflare WARP MASQUE, userspace QUIC/UDP 443)
            └─ fresh WARP IPv6 /64 per rotation
```

## Install

```sh
bash /storage/emulated/0/opencode-unlimited-termux/install-warp-lane.sh
```

Yeh:

1. `proot` check/install karta hai (sirf DNS ke liye).
2. `warp-minimal` + scripts `~/.local/share/opencode-unlimited-warp` mein copy karta hai.
3. WARP tunnel start karke `warp=on` verify karta hai.
4. `~/.local/bin/opencode` shim lagata hai + `~/.bashrc` mein PATH add karta hai.
5. opencode v2 ho to retry plugin bhi install karta hai.

Agar `opencode` missing hai to installer recommendations dikha kar rukega
(default). Components only install karne hain to `--no-opencode`.

## Use

```sh
opencode                          # launcher menu (status + 1 run / 2 install)
oc                                # same menu, short command
opencode run "..."                # direct lane one-shot (menu skip)
opencode-unlimited-hop            # manual fresh WARP /64
opencode-unlimited-doctor         # health + egress trace
opencode-unlimited-stop           # stop daemon + guard
opencode-unlimited-start          # start again
```

Menu (no args + interactive terminal):

```
1  Run opencode              (TUI)
2  Install / repair opencode (pkg / recent Termux builds / lane repair)
3  Start / restart WARP lane
4  Rotate WARP /64
5  Doctor
6  Uninstall lane
0  Exit
```

Wall aane par: daemon khud pool rotate karta hai; message dobara bhej do.
opencode v2 par retry plugin khud retry kar deta hai. Direct TUI chahiye to
`OC_MENU_SKIP=1 opencode`.

## Files

| Path | Role |
|---|---|
| `bin/warp-minimal` | WARP MASQUE proxy binary (linux/arm64, v0.4.0, SHA-256 verified) |
| `bin/opencode-shim` | `~/.local/bin/opencode` as installed |
| `scripts/lane.sh` | proxy env + exec opencode |
| `scripts/warp-start.sh` | proot + daemon + guard start |
| `scripts/warp-stop.sh` | stop |
| `scripts/warp-hop.sh` | POST `/recycle`, show new egress |
| `scripts/warp-guard.sh` | log watcher → recycle on quota lines |
| `scripts/warp-doctor.sh` | diagnostics |
| `plugin/opencode-warp-retry/` | opencode v2 retry hook (adapted, MIT) |
| `docs/RECOVERY.md` | old session ka unfinished work + exact fixes |
| `docs/GITHUB-SOURCES.md` | recent repos checked, adopted/rejected with dates |
| `docs/OPENCODE-INSTALL.md` | agar opencode install nahi hai |

Upstream `scripts/zen-*.sh` aur `README.md` untouched hain. `install.sh` ab
Termux par isi lane installer par redirect karta hai (Linux par upstream
systemd installer hi chalta hai). `README-TERMUX.md` mein working solution ka
update add kiya gaya hai.

## Verified on this device

```
curl -x http://127.0.0.1:8789 https://www.cloudflare.com/cdn-cgi/trace
  ip=2a09:bac5:4065:1a96::2a6:6d
  warp=on

HTTPS_PROXY=http://127.0.0.1:8789 opencode run "Reply with exactly: LANE-OK"
  > build · deepseek-v4.1-flash-free
  LANE-OK
```

## Limits

- WARP exit pool shared hai; rotation kabhi spent block de sakta hai — hop dobara.
- Free tier per egress /64 metered hai (~100 req/day, ~00:00 UTC reset).
- v1 par auto-resume nahi; v2 ke liye plugin included.
- No kill-switch: lane explicit-proxy hai; daemon down = requests fail (direct
  leak nahi, kyunki proxy env force hota hai).
