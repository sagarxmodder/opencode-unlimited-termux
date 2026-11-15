# GitHub sources checked (2026-11-15)

Filter used: favour repos touched in the last ~2 days (2026-11-13 → 2026-11-15).
Nothing older than 4 days was adopted as code; one 4-day-old research repo was
read for platform notes only. Release binaries are checksum-verified.

## Adopted

| Repo | Pushed | License | What we used |
|---|---|---|---|
| `Deury08/warp-minimal` | 2026-11-14 | MIT | Core egress. v0.4.0 linux/arm64 userspace WARP MASQUE proxy: no root, no TUN, IPv6 pool, auto-rotate on 429/403, `/health`, `/exits`, `/recycle`, `/swap`. Auto-upgrade path in `scripts/warp-upgrade.sh` (release check → sha256 → replace → rollback). |
| `lipey1/opencode-warp-retry` | 2026-11-14 | MIT | v2 retry-hook idea; adapted to call warp-minimal `POST /recycle` instead of `warp-cli disconnect/connect`. Included as an optional plugin. |
| `Ethos6/freeflow` | 2026-11-15 | MIT | Optional Plan B: local gateway over 58 free providers with automatic fallback. Installed from the menu (Install/repair → 4) when WARP is blocked or the pool is spent. Needs provider API keys, never auto-configured. |
| `ItzSagarOp` Termux notes (`README-TERMUX.md`, `install-termux.sh`) | 2026-11-15 | — | Preserved. Their earlier feasibility analysis (unshare blocked, no warp-cli/systemd) was correct and is the basis for this adaptation. |

## Read for ideas, not copied

| Repo | Pushed | Why not adopted |
|---|---|---|
| `Suydev/opencode-unlimited-termux` | 2026-11-11 (4 days) | Termux lane/guard/hop layout was useful; it needs an external proxy pool and Bun bridge, and its lane only exports proxy env (no WARP of its own). Our lane is self-contained via warp-minimal. |
| `ShadowySphinX/Opencode-Unlimited-Limit-Bypass-` | 2026-11-14 | Windows desktop app (52 MB binaries, WARP keeper, keystroke auto-resume). Multi-pattern limit detection noted. |
| `Tazmyan/OpenCode-Unlimited` | 2026-11-14 | Cross-platform Node CLI; rotates device id and clears stale limit banners. Per its own README the quota axis is the egress block, not the device id. Possible future usage-meter companion. |
| `aminmozaffari23-cmyk/opencode-unlimited` | 2026-11-14 | Python stdlib proxy-mode controller (`ouc.py`) with WARP + Psiphon ladder. Sound architecture, but needs `warp-cli` or Psiphon binaries; warp-minimal is lighter on Termux. |
| `ebouther/opencode-unlimited-proxy` | 2026-11-14 | Excellent free-tier gate research (UA, canonical `x-opencode-session`, TLS, body shape) and Docker gateway. Docker/WARP-pool path is not Termux-friendly. |
| `tekdt/9fo` | 2026-11-15 | Community gateway; local mode still needs a proxy, shared hosts route prompts through a third party. Not used. |

## Checked, not integrated (2026-11-15 scan)

| Repo | Pushed | Why not |
|---|---|---|
| `slkiser/opencode-quota` (1150★) | 2026-11-14 | Quota/usage TUI plugin. Needs OpenCode 2.0.26+ for the v5 line (v1 branch is a separate `release/4.x`). Our device runs 1.19.5 and already has the local `opencode-unlimited-tokens` plugin — two quota plugins would fight. Available later for v2. |
| `leonidklyha/opencode-quota-guard`, `meiyx7/opencode-usage-center`, `qstoffe/cost-guard`, `khobiziilyes/opencode-quota-footer` | 2026-11-14/15 | Usage meters and v2 statusline plugins. Monitoring only — they do not move the quota axis (egress block). Our menu already shows exits, served count and latency. |
| `Deury08/pi-free-bridge` | 2026-11-15 | Provider plugin for Pi, not for the opencode CLI. |
| `tekdt/9fo` | 2026-11-15 | Community gateway; shared hosts route prompts through a third party. Local mode still needs a proxy. Not used. |
| `Oficina-do-Berg/CodeOpenFreedom` | 2026-11-15 | Windows 10/11 only. |
| `razzant/claudexor`, `netherg-io/agentdeck` | 2026-11-14 | Multi-harness account managers; desktop-heavy, account-based, not egress-based. |
| `bepass-org/warp-plus` | 2025-06-04 | WARP+ SOCKS client; superseded here by warp-minimal's MASQUE pool (HTTP proxy + rotation + admin API). |

Latest `warp-minimal` release is still **v0.4.0** (published 2026-11-14) — nothing newer to pull. The lane's upgrade path checks GitHub on demand.

## Rejected

| Repo | Pushed | Reason |
|---|---|---|
| `opencode-unlimited-usage` | 2026-11-07 | Original upstream. Linux + systemd + `warp-cli` + iptables; cannot run here. Kept as reference in this folder. |
| `asgtey/opencode-unlimited-v2` | 2026-11-13 | OpenCode 2.x port; WARP + fail-closed kill-switch, still systemd/root. |
| `Oficina-do-Berg/CodeOpenFreedom` | 2026-11-15 | Windows 10/11 only. |
| `nomaddxb2/kagujjecode` | 2026-11-14 | Two commits, unverified identity-spoofing/"abliterated" prompt injection. Not production-trustworthy. |
| `6Kmfi6HP/opencode2api`, `IMROVOID/OpenCode2API`, `Tandarke12345560/o2api`, `zengate` family | 2026-11-13/15 | OpenAI-compatible gateways. They solve the client-shape gate, not the egress quota; still need rotating exits. |
| `jcz2020/opencode-termux`, `C04-wq/opencode-termux`, `Spectra010s/opencode-termux`, `bd-loser/opencode-bionic` | 2026-11-13/14 | opencode installers/builds, not bypasses. Listed in `OPENCODE-INSTALL.md` as install recommendations. |

## Attribution

- warp-minimal — MIT, © Deury08.
- opencode-warp-retry — MIT, © lipey1 (adapted).
- Terminal layout inspiration — Suydev (MIT if present in that repo); no code copied.
- Original bypass concept — opencode-unlimited-usage.
