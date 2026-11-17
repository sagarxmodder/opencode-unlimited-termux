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

One line (repo tarball se scripts + binary + plugin aate hain):

```sh
curl -fsSL https://raw.githubusercontent.com/sagarxmodder/opencode-unlimited-termux/main/get.sh | bash
```

Local copy se:

```sh
bash /storage/emulated/0/opencode-unlimited-termux/install-warp-lane.sh
```

Yeh:

1. `proot` check/install karta hai (sirf DNS ke liye).
2. `warp-minimal` + scripts `~/.local/share/opencode-unlimited-warp` mein copy karta hai.
3. WARP tunnel start karke `warp=on` verify karta hai.
4. `~/.local/bin/opencode` shim lagata hai + `~/.bashrc` mein PATH add karta hai.
5. opencode version ke hisaab se plugin install karta hai:
   v2 → `opencode-warp-retry` (retry hook), v1 → `opencode-unlimited-lane.ts`
   (all-model quota bypass + context guard).

Agar `opencode` missing hai to installer recommendations dikha kar rukega
(default). Components only install karne hain to `--no-opencode`.

## Use

```sh
opencode                          # launcher UI v3 (arrow keys / numbers)
oc                                # same menu, short command
opencode run "..."                # direct lane one-shot (menu skip)
opencode-unlimited-hop            # manual fresh WARP /64
opencode-unlimited-doctor         # health + egress trace
opencode-unlimited-stop           # stop daemon + guard
opencode-unlimited-start          # start again
```

Menu (no args + interactive terminal, ↑↓ + Enter):

```
1  Run opencode                 unlimited lane kholo
2  Unlimited status             models · retries · context
3  Restart WARP lane            daemon + guard
4  Rotate WARP /64              naya identity
5  Doctor                       health + egress
6  Logs                         opencode · lane · guard · daemon
7  About / updates              credits + GitHub update check
8  Uninstall lane               runtime only
9  Exit
```

Status panel is live: lane state, `warp=on/off`, exits healthy/total, served
count, latency, guard, egress IP, opencode + WARP versions.

## Unlimited free models (v1 plugin)

`opencode-unlimited-lane.ts` har free model par kaam karta hai (deepseek,
flint, glm, minimax — koi bhi):

1. **Quota wall** (`free usage limit`, `429`, `503`, `service unavailable`,
   proxy tunnel 503) → plugin local proxy par `POST /recycle` karta hai,
   fresh healthy WARP exit `/64` ka wait karta hai, phir session ko
   `continue` se auto-resume karta hai. Retry unlimited hain, sirf 45s
   cooldown per session (loop guard).
2. **Context wall** → usage har step par track hota hai; `maxOutputTokens`
   remaining budget par cap hota hai; **65%** par transcript handoff +
   session compact (`/session/{id}/summarize`). Context-length error aane par
   bhi force-compact karke auto-continue — error surface nahi hota.
3. **Model unavailable** → next free model par failover (`free_models` tool se
   list), phir continue.
4. **Network reset/timeout** → quick retry, doosri baar par WARP rotate.

Tools: `token_status`, `free_models`, `warp_rotate`, `handoff`, `compact_now`.
Commands: `/tokens`, `/compact-now`, `/handoff`, `/resume`.
Log: `~/.config/opencode/memory/unlimited-tokens.log`.

**v1 quirk:** opencode 1.19.5 `plugins/<dir>/index.ts` ko import karta hai
lekin usko call nahi karta. Isliye plugin flat file hota hai —
`~/.config/opencode/plugins/opencode-unlimited-lane.ts`.

Wall ke baad kuch nahi karna: plugin khud rotate + continue karta hai.
Manual chahiye to `opencode-unlimited-hop`. Direct TUI ke liye
`OC_MENU_SKIP=1 opencode`.

**Do tarah ki wall hoti hai:**

- *IP-scoped* (429 / rate limit / usage limit) → WARP pool rotate karke same
  model par retry.
- *Account-scoped* (jaise `Free usage exceeded, subscribe to Go`) → rotate
  kaam nahi karta, isliye plugin detect karke next free model par switch
  karta hai aur wahi session continue karta hai. Available free models:
  `opencode models` se dekho (deepseek · glm · flint · minimax · beam · …).

### Two networks, on purpose

`HTTPS_PROXY` points at the WARP proxy so opencode's model traffic exits on a
rotating WARP /64. `NO_PROXY` keeps GitHub / npm / apt / PyPI **direct**,
because those hosts refuse or drop traffic coming from Cloudflare WARP exits
(which breaks tooling inside a session).

## Files

| Path | Role |
|---|---|
| `bin/warp-minimal` | WARP MASQUE proxy binary (linux/arm64, v0.4.0, SHA-256 verified) |
| `bin/opencode-shim` | `~/.local/bin/opencode` as installed |
| `zycron-ai/` | local-first AI chat + coding agent (free routing, approvals, workspace) |
| `scripts/menu.sh` | main UI (1 opencode, 2 status, doctor/logs) |
| `scripts/lane.sh` | proxy env + exec opencode |
| `scripts/warp-start.sh` | proot + daemon + guard start |
| `scripts/warp-stop.sh` | stop |
| `scripts/warp-hop.sh` | POST `/recycle`, show new egress |
| `scripts/warp-guard.sh` | log watcher → recycle on quota lines |
| `scripts/warp-doctor.sh` | diagnostics |
| `plugin/opencode-warp-retry/` | opencode v2 retry hook (adapted, MIT) |
| `plugin/opencode-unlimited-lane/` | opencode v1 all-model quota bypass + context guard |
| `docs/RECOVERY.md` | old session ka unfinished work + exact fixes |
| `docs/GITHUB-SOURCES.md` | recent repos checked, adopted/rejected with dates |
| `docs/OPENCODE-INSTALL.md` | agar opencode install nahi hai |

Upstream `scripts/zen-*.sh` aur `README.md` untouched hain. `install.sh` ab
Termux par isi lane installer par redirect karta hai (Linux par upstream
systemd installer hi chalta hai). `README-TERMUX.md` mein working solution ka
update add kiya gaya hai.

## Fixes in this revision (2026-11-15)

- **Port race:** `warp-start.sh` exit-count (`healthy`=0) ko liveness samajh
  raha tha, isliye dead-exit daemon ke upar dusra daemon spawn hota tha aur
  `bind: address already in use` aata tha. Ab `alive()` (port responding) aur
  `healthy()` (usable exit) alag hain, stale process pehle kill hota hai.
- **Plugin load:** v1 dir-plugin call nahi hota — flat file install.
- **Context wall:** `compaction.auto` on; `plugins` (v2-only) key hatai gayi;
  token guard + auto-compact v1 API par likha gaya.
- **freecode proxy:** HTTPS CONNECT tunnel ke baad TLS socket ke liye ab
  `https.Agent` use hota hai (pehle `http.Agent` tha, isliye
  `Protocol "https:" not supported` aa raha tha).
- **Menu detection:** `OC` ab main shell me set hota hai; installed opencode
  ko "missing" nahi samajhta. About screen me update check merge hua.
- **Ship freecode:** installer `$DEST/freecode` copy + wrapper install karta
  hai; uninstall wrapper ko clean karta hai.
- **Hermetic tests:** CLI tests LLM7/Pollinations live APIs hit nahi karte.
- **Fail summary:** sab models fail hone par first failure ka summary
  (`all N free models failed — …`) aata hai, last model ka ECONNREFUSED nahi.
- **freecode UI:** opencode-jaisa card banner + framed composer (bottom border
  par active model + short session id), `▌ assistant · model` block, braille
  spinner, `✓ model · time` footer. Picker ke baad bare number (jaise `2`)
  select karta hai, prompt nahi bhejta. `/model`, `/model <n|id|auto>`,
  `/sessions`, `/session <n|id>`, `/clear`, `/continue`, Tab completion.
  Piped REPL input ab drop nahi hota (line queue).
- **Stream wipe fix:** purana spinner har delta par `\r\x1b[2K` bhej kar
  streamed text mita raha tha (stray `?` artifact). Ab spinner sirf ek baar
  clear hota hai; reply clean stream hoti hai.
- **Edit `$` literals:** `edit` tool `$&`/`$1` ko replacement pattern ki tarah
  interpret nahi karta; literal text save hota hai.
- **Session cwd:** `--continue` sirf current directory ka latest session leta
  hai (cross-directory fallback hataya).
- **Robustness:** non-object config guard, guard log path `$DEST/logs/guard.log`,
  installer plugin nested-copy cleanup, uninstaller credit casing, aur
  uninstaller ab `$DEST/scripts/` me bhi ship hota hai (menu fallback).
- **Install/uninstall UI:** dono scripts menu wali card UI, step dots aur
  summary use karte hain; uninstaller removed count + kept/reinstall dikhata hai.

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
- v1 par auto-resume plugin ke through hai (opencode >= 1.19.x); bahut purane
  builds par `event` hook na ho to message dobara bhejna padega.
- No kill-switch: lane explicit-proxy hai; daemon down = requests fail (direct
  leak nahi, kyunki proxy env force hota hai).

## Context overflow fix (v2.3.0)

Free tier `deepseek-v4.1-flash-free` ka asli window models.dev ke 200k se chhota
hai, isliye lambi session par provider 400 deta tha:

```
Your request resulted in more tokens than this model's maximum context length allows.
Please reduce the length of the messages or run compaction.
```

`bash scripts/fix-context-overflow.sh` do cheezein karta hai:

1. bionic **v2.3.0** binary `$PREFIX/bin/opencode-2.3.0` par install karta hai
   (sha256 pinned). v2 provider ke context-overflow error ko pakad kar session
   compact karke turn retry karta hai — manual `/compact` ki zarurat nahi.
2. `~/.config/opencode/opencode.jsonc` mein free model ka limit clamp karta hai
   (`context 60000`, `output 8000`, `buffer 4000`) taaki proactive compaction
   gateway ke reject se pehle chale.

Wrapper (`~/.local/bin/opencode`) aur `scripts/lane.sh` v2 binary ko pehle
detect karte hain; purana binary `opencode.bak.1.19.5` rollback ke liye rehta hai.
