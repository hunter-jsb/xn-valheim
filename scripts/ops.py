#!/usr/bin/env python3
"""Common Valheim server operations against the IB control panel.

Auth from env: IB_EMAIL + IB_PASSWORD  (or IB_SESSION = an indifferentSess cookie).

  uv run --project scripts scripts/ops.py status
  uv run --project scripts scripts/ops.py restart
  uv run --project scripts scripts/ops.py backup
  uv run --project scripts scripts/ops.py rcon "save"
  uv run --project scripts scripts/ops.py admins            # print adminlist.txt
  uv run --project scripts scripts/ops.py activity
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from ib import IBClient  # noqa: E402

ADMINLIST = ".config/unity3d/IronGate/Valheim/adminlist.txt"


def _client() -> IBClient:
    c = IBClient()
    if not c.session_ok():
        c.login()
    return c


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["status", "start", "stop", "restart",
                                    "backup", "rcon", "admins", "activity"])
    ap.add_argument("arg", nargs="?", default="")
    ap.add_argument("--game", default="Valheim")
    a = ap.parse_args()

    c = _client()
    sv = c.find(a.game)
    u = sv.linux_username

    if a.cmd == "status":
        print(json.dumps({"server": sv.__dict__,
                          "activity": c.activity(u)[:5]}, indent=2, default=str))
    elif a.cmd in ("start", "stop", "restart"):
        print(json.dumps(getattr(c, a.cmd)(u), indent=2))
    elif a.cmd == "backup":
        print(json.dumps(c.create_backup(u), indent=2))
    elif a.cmd == "rcon":
        if not a.arg:
            sys.exit("usage: ops.py rcon '<command>'")
        print(json.dumps(c.rcon(u, a.arg), indent=2))
    elif a.cmd == "admins":
        print(c.read_file(u, ADMINLIST))
    elif a.cmd == "activity":
        print(json.dumps(c.activity(u), indent=2))


if __name__ == "__main__":
    main()
