#!/usr/bin/env python3
"""Import an OpenCode session backup ({info, messages}) into a live SQLite store.

Works against both store layouts:

  * v1 store  (opencode 1.19.x)  -> tables: session / message / part
  * v2 store  (opencode 2.3.x)   -> tables: session_v2 / session_message / session_part

Usage:
  session-restore.py <db-path> <session.json> [--force] [--version X] [--project ID]

The import is idempotent: an existing session id is left alone unless --force
is given, in which case its rows are replaced.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import time

SKIP_SLUG = re.compile(r"[^a-z0-9]+")


def _slug(title: str, sid: str) -> str:
    base = SKIP_SLUG.sub("-", title.lower()).strip("-")[:40].strip("-")
    return base or "recovered-" + sid[-6:].lower()


def _part_id(sid: str, mid: str, idx: int) -> str:
    return "prt_" + hashlib.sha1(f"{sid}:{mid}:{idx}".encode()).hexdigest()[:24]


def _msg_id(sid: str, idx: int, kind: str) -> str:
    return "msg_" + hashlib.sha1(f"{sid}:{idx}:{kind}".encode()).hexdigest()[:24]


def _tok(info_tokens: dict) -> dict:
    t = info_tokens or {}
    cache = t.get("cache") or {}
    return {
        "input": int(t.get("input") or 0),
        "output": int(t.get("output") or 0),
        "reasoning": int(t.get("reasoning") or 0),
        "cache": {
            "read": int(cache.get("read") or 0),
            "write": int(cache.get("write") or 0),
        },
    }


def _model_of(messages: list) -> dict:
    for m in messages:
        model = m.get("model")
        if model:
            return {
                "id": model.get("id") or model.get("modelID"),
                "providerID": model.get("providerID"),
                "variant": model.get("variant") or "default",
            }
    return {"id": "deepseek-v4.1-flash-free", "providerID": "opencode", "variant": "default"}


def _detect(db: sqlite3.Connection) -> str:
    names = {r[0] for r in db.execute("select name from sqlite_master where type='table'")}
    if "session_v2" in names:
        return "v2"
    if "session" in names and "message" in names and "part" in names:
        return "v1"
    raise SystemExit("unknown store layout: neither v1 nor v2 tables found")


def import_v1(db: sqlite3.Connection, doc: dict, version: str, project_id: str, force: bool) -> str:
    info = doc["info"]
    messages = doc.get("messages") or []
    sid = info["id"]
    now = int(time.time() * 1000)
    directory = (info.get("location") or {}).get("directory") or "/storage/emulated/0"
    title = info.get("title") or "Recovered session"
    tokens = _tok(info.get("tokens"))
    model = _model_of(messages)
    agent = info.get("agent") or "build"

    if db.execute("select 1 from session where id=?", (sid,)).fetchone():
        if not force:
            return f"skip {sid} (already present)"
        db.execute("delete from part where session_id=?", (sid,))
        db.execute("delete from message where session_id=?", (sid,))
        db.execute("delete from session_message where session_id=?", (sid,))
        db.execute("delete from session where id=?", (sid,))

    if not db.execute("select 1 from project where id=?", (project_id,)).fetchone():
        db.execute(
            "insert into project (id, worktree, vcs, name, time_created, time_updated, sandboxes)"
            " values (?,?,?,?,?,?,?)",
            (project_id, "/", None, None, now, now, "[]"),
        )

    db.execute(
        """insert into session (
            id, project_id, workspace_id, parent_id, slug, directory, path, title, version,
            share_url, summary_additions, summary_deletions, summary_files, summary_diffs,
            metadata, cost, tokens_input, tokens_output, tokens_reasoning,
            tokens_cache_read, tokens_cache_write, revert, permission, agent, model,
            time_created, time_updated, time_compacting, time_archived)
        values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            sid, project_id, None, None, _slug(title, sid), directory, directory.lstrip("/"),
            title, version, None, 0, 0, 0, None, None, float(info.get("cost") or 0),
            tokens["input"], tokens["output"], tokens["reasoning"],
            tokens["cache"]["read"], tokens["cache"]["write"],
            None, None, agent,
            json.dumps({"id": model["id"], "providerID": model["providerID"], "variant": model["variant"]}),
            int((info.get("time") or {}).get("created") or now),
            int((info.get("time") or {}).get("updated") or now),
            None, None,
        ),
    )

    prev_id = None
    for idx, msg in enumerate(messages):
        mid = msg.get("id") or _msg_id(sid, idx, msg.get("type") or "msg")
        created = int((msg.get("time") or {}).get("created") or now)
        completed = int((msg.get("time") or {}).get("completed") or created)
        kind = msg.get("type") or "assistant"

        if kind == "user":
            data = {
                "role": "user",
                "time": {"created": created},
                "agent": msg.get("agent") or agent,
                "model": {
                    "providerID": model["providerID"],
                    "modelID": model["id"],
                    "variant": model["variant"],
                },
                "summary": {"diffs": []},
            }
            db.execute(
                "insert or replace into message (id, session_id, time_created, time_updated, data)"
                " values (?,?,?,?,?)",
                (mid, sid, created, completed, json.dumps(data)),
            )
            db.execute(
                "insert or replace into part (id, message_id, session_id, time_created, time_updated, data)"
                " values (?,?,?,?,?,?)",
                (
                    _part_id(sid, mid, 0), mid, sid, created, completed,
                    json.dumps({"type": "text", "text": msg.get("text") or ""}),
                ),
            )
            prev_id = mid
            continue

        content = msg.get("content") or []
        has_tool = any(p.get("type") == "tool" for p in content)
        data = {
            "parentID": prev_id,
            "role": "assistant",
            "mode": "build",
            "agent": msg.get("agent") or agent,
            "variant": (msg.get("model") or {}).get("variant") or "default",
            "path": {"cwd": directory, "root": "/"},
            "cost": 0,
            "tokens": {"total": 0, "input": 0, "output": 0, "reasoning": 0,
                       "cache": {"write": 0, "read": 0}},
            "modelID": (msg.get("model") or {}).get("id") or model["id"],
            "providerID": (msg.get("model") or {}).get("providerID") or model["providerID"],
            "time": {"created": created, "completed": completed},
            "finish": "tool-calls" if has_tool else "stop",
        }
        db.execute(
            "insert or replace into message (id, session_id, time_created, time_updated, data)"
            " values (?,?,?,?,?)",
            (mid, sid, created, completed, json.dumps(data)),
        )

        rows = [("step-start", {"type": "step-start"})]
        rows += [(p.get("type") or "text", p) for p in content]
        rows.append((
            "step-finish",
            {
                "type": "step-finish",
                "reason": "tool-calls" if has_tool else "stop",
                "tokens": {"total": 0, "input": 0, "output": 0, "reasoning": 0,
                           "cache": {"write": 0, "read": 0}},
                "cost": 0,
            },
        ))
        for pidx, (_t, part) in enumerate(rows):
            ptime = int((part.get("time") or {}).get("created") or created + pidx)
            db.execute(
                "insert or replace into part (id, message_id, session_id, time_created, time_updated, data)"
                " values (?,?,?,?,?,?)",
                (_part_id(sid, mid, pidx), mid, sid,
                 min(ptime, completed), min(ptime, completed), json.dumps(part)),
            )
        prev_id = mid

    db.commit()
    n_msg = db.execute("select count(*) from message where session_id=?", (sid,)).fetchone()[0]
    n_part = db.execute("select count(*) from part where session_id=?", (sid,)).fetchone()[0]
    return f"v1 {sid}: {n_msg} messages, {n_part} parts"


def _v2_project(db: sqlite3.Connection, directory: str, now: int) -> str:
    row = db.execute("select id from project where worktree=?", (directory,)).fetchone()
    if row:
        return row[0]
    pid = hashlib.sha1(directory.encode()).hexdigest()
    cols = [r[1] for r in db.execute("pragma table_info(project)")]
    values = {"id": pid, "worktree": directory, "vcs": None, "name": None,
              "time_created": now, "time_updated": now, "sandboxes": "[]", "commands": None}
    use = [c for c in cols if c in values]
    db.execute(
        f"insert into project ({','.join(use)}) values ({','.join('?' for _ in use)})",
        tuple(values[c] for c in use),
    )
    return pid


def import_v2(db: sqlite3.Connection, doc: dict, version: str, project_id: str | None, force: bool) -> str:
    info = doc["info"]
    messages = doc.get("messages") or []
    sid = info["id"]
    now = int(time.time() * 1000)
    directory = (info.get("location") or {}).get("directory") or "/storage/emulated/0"
    title = info.get("title") or "Recovered session"
    tokens = _tok(info.get("tokens"))
    model = _model_of(messages)
    agent = info.get("agent") or "build"

    if db.execute("select 1 from session_v2 where id=?", (sid,)).fetchone():
        if not force:
            return f"skip {sid} (already present)"
        db.execute("delete from session_part where session_id=?", (sid,))
        db.execute("delete from session_message where session_id=?", (sid,))
        db.execute("delete from session_v2 where id=?", (sid,))

    pid = project_id or _v2_project(db, directory, now)
    db.execute(
        """insert into session_v2 (
            id, project_id, workspace_id, parent_id, fork_session_id, fork_boundary, slug,
            directory, path, title, version, share_url, summary_additions, summary_deletions,
            summary_files, summary_diffs, metadata, cost, tokens_input, tokens_output,
            tokens_reasoning, tokens_cache_read, tokens_cache_write, revert, permission, agent,
            model, time_created, time_updated, time_busy, time_idle, time_viewed, idle_outcome,
            time_compacting, time_archived, time_suspended, resume_attempts)
        values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            sid, pid, None, None, None, None, _slug(title, sid), directory, "", title, version,
            None, None, None, None, None, None, float(info.get("cost") or 0),
            tokens["input"], tokens["output"], tokens["reasoning"],
            tokens["cache"]["read"], tokens["cache"]["write"],
            None, None, agent,
            json.dumps({"id": model["id"], "providerID": model["providerID"]}),
            int((info.get("time") or {}).get("created") or now),
            int((info.get("time") or {}).get("updated") or now),
            None, None, None, "succeeded", None, None, None, 0,
        ),
    )

    seq = 0
    for idx, msg in enumerate(messages):
        mid = msg.get("id") or _msg_id(sid, idx, msg.get("type") or "msg")
        created = int((msg.get("time") or {}).get("created") or now)
        completed = int((msg.get("time") or {}).get("completed") or created)
        kind = msg.get("type") or "assistant"
        seq += 3

        if kind == "user":
            data = {
                "time": {"created": created},
                "text": msg.get("text") or "",
                "files": [],
                "agents": [],
            }
        else:
            content = []
            for part in msg.get("content") or []:
                if part.get("type") == "tool":
                    content.append({
                        "type": "tool",
                        "id": part.get("callID") or part.get("id"),
                        "name": part.get("tool") or part.get("name"),
                        "executed": True,
                        "state": part.get("state") or {},
                    })
                else:
                    content.append(part)
            data = {
                "time": {"created": created, "completed": completed},
                "agent": msg.get("agent") or agent,
                "model": msg.get("model") or model,
                "content": content,
                "finish": "tool-calls" if any(p.get("type") == "tool" for p in content) else "stop",
                "cost": 0,
                "tokens": {"input": 0, "output": 0, "reasoning": 0,
                           "cache": {"read": 0, "write": 0}},
            }
        db.execute(
            "insert or replace into session_message"
            " (id, session_id, type, seq, time_created, time_updated, data) values (?,?,?,?,?,?,?)",
            (mid, sid, kind, seq, created, completed, json.dumps(data)),
        )

    db.commit()
    n = db.execute("select count(*) from session_message where session_id=?", (sid,)).fetchone()[0]
    return f"v2 {sid}: {n} messages"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("db")
    ap.add_argument("json")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--version", default=None)
    ap.add_argument("--project", default=None)
    args = ap.parse_args()

    if not os.path.exists(args.db):
        raise SystemExit(f"no such database: {args.db}")
    with open(args.json, "r", encoding="utf-8") as fh:
        doc = json.load(fh)
    if "info" not in doc or "messages" not in doc:
        raise SystemExit("not a session backup ({info, messages} expected)")

    db = sqlite3.connect(args.db)
    try:
        layout = _detect(db)
        if layout == "v1":
            print(import_v1(db, doc, args.version or "1.19.5-v1.810c0eba",
                            args.project or "global", args.force))
        else:
            print(import_v2(db, doc, args.version or "2.3.0", args.project, args.force))
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
