#!/usr/bin/env python3
"""Config helper for the warp lane installer (opencode.json / opencode.jsonc).

usage:
  config-util.py v1-compaction <cfg>
  config-util.py v2-add        <cfg> <package> <proxy>
  config-util.py v2-remove     <cfg> <package>

Reads JSON as-is, falls back to a JSONC parse (comments + trailing commas).
If something changes, a timestamped backup is written next to the config.
Prints one of: unchanged | changed <backup> | skipped <reason>.
"""
import json
import os
import re
import shutil
import sys
import time


def strip_jsonc(raw):
    out = []
    i, n = 0, len(raw)
    in_str = False
    esc = False
    while i < n:
        c = raw[i]
        nxt = raw[i + 1] if i + 1 < n else ""
        if in_str:
            out.append(c)
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            i += 1
            continue
        if c == '"':
            in_str = True
            out.append(c)
            i += 1
            continue
        if c == "/" and nxt == "/":
            j = raw.find("\n", i)
            i = n if j < 0 else j
            continue
        if c == "/" and nxt == "*":
            j = raw.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        out.append(c)
        i += 1
    return re.sub(r",(\s*[}\]])", r"\1", "".join(out))


def load(path):
    raw = open(path, encoding="utf-8").read()
    try:
        return json.loads(raw), False
    except Exception:
        return json.loads(strip_jsonc(raw)), True


def save(path, data):
    backup = path + ".bak." + time.strftime("%Y%m%d-%H%M%S") + f"-{os.getpid()}"
    shutil.copy2(path, backup)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")
    return backup


def apply(cmd, cfg, argv):
    data, was_jsonc = load(cfg)
    before = json.dumps(data, sort_keys=True)

    if cmd == "v1-compaction":
        data.pop("plugins", None)
        comp = data.setdefault("compaction", {})
        comp["auto"] = True
        comp.setdefault("prune", True)
    elif cmd == "v2-add":
        package, proxy = argv[0], argv[1]
        plugins = data.setdefault("plugins", [])
        if not any(isinstance(p, dict) and p.get("package") == package for p in plugins):
            entry = {"package": package}
            if proxy:
                entry["options"] = {"proxyUrl": proxy}
            plugins.append(entry)
    elif cmd == "v2-remove":
        package = argv[0]
        plugins = data.get("plugins", [])
        kept = [p for p in plugins if not (isinstance(p, dict) and p.get("package") == package)]
        if kept:
            data["plugins"] = kept
        else:
            data.pop("plugins", None)
    else:
        return "skipped unknown command"

    if json.dumps(data, sort_keys=True) == before:
        return "unchanged"

    backup = save(cfg, data)
    note = " (jsonc normalized)" if was_jsonc else ""
    return "changed " + backup + note


def main():
    if len(sys.argv) < 3:
        print("skipped usage: config-util.py <cmd> <cfg> [args...]")
        return 0
    cmd, cfg, argv = sys.argv[1], sys.argv[2], sys.argv[3:]
    try:
        result = apply(cmd, cfg, argv)
    except FileNotFoundError:
        result = "skipped config not found"
    except Exception as error:
        result = "skipped " + str(error)
    print(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
