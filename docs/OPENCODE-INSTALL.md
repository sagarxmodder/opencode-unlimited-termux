# Agar opencode install nahi hai

`install-warp-lane.sh` pehle `opencode` dhoondta hai. Na mile to yeh
recommendations dikhata hai aur (default) ruk jaata hai. Components install
karne ke liye: `bash install-warp-lane.sh --no-opencode`.

## Option 1 — Termux package (sabse simple)

```sh
pkg update
pkg install opencode
opencode --version
```

Yeh is device par `1.19.5` deta hai. v1 par lane/proxy poora kaam karta hai;
free-limit par message dobara bhejna hota hai (v2 retry plugin optional hai).

## Option 2 — Recent native Termux builds (Nov 13–14, 2026)

Agar `pkg install opencode` fail ho, ya Android 11+ par TUI crash kare
(`Pointer exceeds safe integer range` — bionic heap tagging + Bun FFI):

| Repo | Pushed | Note |
|---|---|---|
| `jcz2020/opencode-termux` | 2026-11-14 | Android 11+ heap-tag fix, bionic build, source-built from upstream + Bun. |
| `C04-wq/opencode-termux` | 2026-11-14 | Verified ARM64 runtime + Bash installer, no Node/npm needed. |
| `Spectra010s/opencode-termux` | 2026-11-13 | Native bionic builds (v2 mainline + v1 maintenance line). |
| `bd-loser/opencode-bionic` | 2026-11-13 | Native Bionic aarch64 builds (stable/beta/dev channels). |

In sab ki README follow karo, phir `opencode --version` se verify karke
`install-warp-lane.sh` dobara chalao.

## Option 3 — Official installer

opencode.ai ka official installer Linux/glibc build deta hai, jo Termux
(bionic) par directly nahi chalta. Isliye Termux ke liye Option 1/2 preferred
hain.

## Verify

```sh
command -v opencode
opencode --version
~/.local/bin/opencode --version     # lane ke through
opencode-unlimited-doctor
```
