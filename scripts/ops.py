#!/usr/bin/env python3
"""Common Valheim server operations against the IB control panel.

Auth from env: IB_EMAIL + IB_PASSWORD  (or IB_SESSION = an indifferentSess cookie).

  uv run --project scripts scripts/ops.py status
  uv run --project scripts scripts/ops.py restart
  uv run --project scripts scripts/ops.py backup
  uv run --project scripts scripts/ops.py rcon "save"
  uv run --project scripts scripts/ops.py admins            # print adminlist.txt
  uv run --project scripts scripts/ops.py activity
  uv run --project scripts scripts/ops.py update              # game version, waits it out
  uv run --project scripts scripts/ops.py announce "back in 5"
  uv run --project scripts scripts/ops.py restart --warn 60 --reason "map mod update"

announce needs ANNOUNCE_TOKEN (the secret in the mod's announce.token) and
optionally WEBMAP_URL.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from ib import IBClient  # noqa: E402

ADMINLIST = ".config/unity3d/IronGate/Valheim/adminlist.txt"
WEBMAP_URL = os.environ.get("WEBMAP_URL", "http://170.23.227.3:27021")
SERVER_APPID = 896660
MANIFEST = f"steamcmd/valheim/steamapps/appmanifest_{SERVER_APPID}.acf"


def steam_buildid() -> str:
    """The build Steam is currently serving for the dedicated server."""
    with urllib.request.urlopen(
            f"https://api.steamcmd.net/v1/info/{SERVER_APPID}", timeout=25) as r:
        d = json.load(r)
    return str(d["data"][str(SERVER_APPID)]["depots"]["branches"]["public"]["buildid"])


def installed_buildid(c, u) -> str:
    try:
        m = re.search(r'"buildid"\s+"(\d+)"', c.read_file(u, MANIFEST))
        return m.group(1) if m else "0"
    except Exception:
        return "0"


def do_update(c, u):
    """Trigger the panel update and wait for steamcmd to finish.

    The install runs asynchronously and takes 20+ minutes. Starting the server
    while it downloads aborts it -- the manifest is left at buildid 0 with no
    installed depots and the old binaries boot again, which looks exactly like
    the update silently failing. So: never start it here, just wait.
    """
    want = steam_buildid()
    have = installed_buildid(c, u)
    print(f"steam build {want} | installed {have}")
    if have == want:
        print("already current")
        return
    print(json.dumps(c.update_version(u))[:120])
    deadline = time.time() + 45 * 60
    while time.time() < deadline:
        time.sleep(60)
        have = installed_buildid(c, u)
        left = int((deadline - time.time()) / 60)
        print(f"  installed {have} (want {want}); {left} min left")
        if have == want:
            print("update complete; the panel restarts the server itself")
            return
    print("still not installed after 45 min - check the panel", file=sys.stderr)
    sys.exit(1)


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


def players_online() -> list[str]:
    """Names of players currently connected, straight from the mod."""
    try:
        with urllib.request.urlopen(f"{WEBMAP_URL}/players", timeout=10) as r:
            return [p.get("name", "?") for p in json.load(r).get("players", [])]
    except Exception:
        return []


def drain(timeout: int, reason: str) -> None:
    """Ask everyone to log out, and wait until they have.

    Valheim keeps each player's inventory in their own character file on their
    own machine, not in the world. Cutting the server out from under a connected
    client leaves the two saves disagreeing: an item that moved from inventory
    into a chest survives in both, and one that moved the other way -- or an
    upgrade applied at a bench -- is simply gone. A clean logout writes the
    character file first, which is the only thing that prevents it.
    """
    why = f" - {reason}" if reason else ""
    mins = max(1, timeout // 60)
    announce(f"Restart in ~{mins} min{why}. Please LOG OUT to save your gear "
             f"- items can be lost if you are still connected.")
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        who = players_online()
        if not who:
            print("server drained; everyone logged out")
            announce("Everyone is out - restarting now.")
            time.sleep(2)
            return
        if who != last:
            print(f"  waiting on {len(who)}: {', '.join(who)}")
            last = who
        left = int(deadline - time.time())
        if left in (60, 30, 10):
            announce(f"Restart in {left}s - log out now to save your gear.")
        time.sleep(5)
    who = players_online()
    if who:
        print(f"still connected after {timeout}s: {', '.join(who)}; restarting anyway",
              file=sys.stderr)
        announce("Restarting now - log back in shortly.")
        time.sleep(2)


def _client() -> IBClient:
    c = IBClient()
    if not c.session_ok():
        c.login()
    return c


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["status", "start", "stop", "restart",
                                    "backup", "rcon", "admins", "activity",
                                    "announce", "update"])
    ap.add_argument("arg", nargs="?", default="")
    ap.add_argument("--game", default="Valheim")
    ap.add_argument("--warn", type=int, metavar="SECONDS",
                    help="restart: shout a countdown in game first")
    ap.add_argument("--reason", default="", help="restart: why, for the shout")
    ap.add_argument("--drain", type=int, nargs="?", const=300, metavar="SECONDS",
                    help="restart: ask players to log out and wait for them "
                         "(default 300s) before restarting. Prefer this to --warn "
                         "whenever anyone is online -- see drain().")
    a = ap.parse_args()

    c = _client()
    sv = c.find(a.game)
    u = sv.linux_username

    if a.cmd == "status":
        print(json.dumps({"server": sv.__dict__,
                          "activity": c.activity(u)[:5]}, indent=2, default=str))
    elif a.cmd == "update":
        do_update(c, u)
    elif a.cmd == "announce":
        if not a.arg:
            sys.exit("usage: ops.py announce '<message>'")
        sys.exit(0 if announce(a.arg) else 1)
    elif a.cmd in ("start", "stop", "restart"):
        if a.drain and a.cmd in ("restart", "stop"):
            drain(a.drain, a.reason)
        elif a.warn and a.cmd in ("restart", "stop"):
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
