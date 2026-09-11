#!/usr/bin/env python3
"""Common Valheim server operations against the IB control panel.

Auth from env: IB_EMAIL + IB_PASSWORD  (or IB_SESSION = an indifferentSess cookie).

  uv run --project scripts scripts/ops.py status
  uv run --project scripts scripts/ops.py restart
  uv run --project scripts scripts/ops.py backup
  uv run --project scripts scripts/ops.py rcon "save"
  uv run --project scripts scripts/ops.py admins            # print adminlist.txt
  uv run --project scripts scripts/ops.py activity
  uv run --project scripts scripts/ops.py announce "back in 5"
  uv run --project scripts scripts/ops.py restart --warn 60 --reason "map mod update"

announce needs ANNOUNCE_TOKEN (the secret in the mod's announce.token) and
optionally WEBMAP_URL.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from ib import IBClient  # noqa: E402

ADMINLIST = ".config/unity3d/IronGate/Valheim/adminlist.txt"
WEBMAP_URL = os.environ.get("WEBMAP_URL", "http://170.23.227.3:27021")


def announce(text: str) -> bool:
    """Shout a line in the in-game chat, straight at the mod's own port.

    The public Worker does not proxy /announce, so this only works from
    somewhere that has the token.
    """
    token = os.environ.get("ANNOUNCE_TOKEN")
    if not token:
        sys.exit("ANNOUNCE_TOKEN is not set (see .env)")
    req = urllib.request.Request(
        f"{WEBMAP_URL}/announce", data=text.encode(),
        headers={"X-Announce-Token": token, "Content-Type": "text/plain"},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return 200 <= r.status < 300
    except urllib.error.HTTPError as e:
        print(f"announce refused: {e.code} {e.read().decode()[:120]}", file=sys.stderr)
    except Exception as e:
        print(f"announce failed: {e}", file=sys.stderr)
    return False


def _client() -> IBClient:
    c = IBClient()
    if not c.session_ok():
        c.login()
    return c


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["status", "start", "stop", "restart",
                                    "backup", "rcon", "admins", "activity",
                                    "announce"])
    ap.add_argument("arg", nargs="?", default="")
    ap.add_argument("--game", default="Valheim")
    ap.add_argument("--warn", type=int, metavar="SECONDS",
                    help="restart: shout a countdown in game first")
    ap.add_argument("--reason", default="", help="restart: why, for the shout")
    a = ap.parse_args()

    c = _client()
    sv = c.find(a.game)
    u = sv.linux_username

    if a.cmd == "status":
        print(json.dumps({"server": sv.__dict__,
                          "activity": c.activity(u)[:5]}, indent=2, default=str))
    elif a.cmd == "announce":
        if not a.arg:
            sys.exit("usage: ops.py announce '<message>'")
        sys.exit(0 if announce(a.arg) else 1)
    elif a.cmd in ("start", "stop", "restart"):
        if a.warn and a.cmd in ("restart", "stop"):
            why = f" - {a.reason}" if a.reason else ""
            announce(f"Restarting in {a.warn}s{why}")
            # a second shout near the moment catches anyone who just logged in
            if a.warn > 20:
                time.sleep(a.warn - 10)
                announce("Restarting in 10s - find a safe spot")
                time.sleep(10)
            else:
                time.sleep(a.warn)
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
