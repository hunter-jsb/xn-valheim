#!/usr/bin/env python3
"""Common Valheim server operations against the IB control panel.

Auth from env: IB_EMAIL + IB_PASSWORD  (or IB_SESSION = an indifferentSess cookie).

  uv run --project scripts scripts/ops.py status
  uv run --project scripts scripts/ops.py restart
  uv run --project scripts scripts/ops.py backup
  uv run --project scripts scripts/ops.py rcon "save"
  uv run --project scripts scripts/ops.py admins            # print adminlist.txt
  uv run --project scripts scripts/ops.py activity
  uv run --project scripts scripts/ops.py update              # game version: steamcmd here, SFTP up, drain + swap
  uv run --project scripts scripts/ops.py announce "back in 5"
  uv run --project scripts scripts/ops.py restart --warn 60 --reason "map mod update"
  uv run --project scripts scripts/ops.py deploy-web          # the viewer, from ../valheim-webmap/WebMap/web
  uv run --project scripts scripts/ops.py deploy-mod ../valheim-webmap/dist/WebMap.dll

announce needs ANNOUNCE_TOKEN (the secret in the mod's announce.token) and
optionally WEBMAP_URL. The deploys need IB_SFTP_HOST/PORT/USER/PASS.
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


# The panel's own updater fails every time on this host (steamcmd writes a stub manifest
# with UpdateResult 9 and downloads nothing, leaving the server down). Steam serves the
# build fine, so the update runs here and only the files that changed go up by SFTP.
DS = Path(os.environ.get("VALHEIM_DS", "~/.cache/valheim-ds")).expanduser()   # steamcmd/ and install/
REMOTE_GAME = "steamcmd/valheim/"
HOST_OWNED = ("BepInEx/", "doorstop", "winhttp.dll", ".bepinex_version", "steamapps/", "docker/")


def _snapshot(root: Path) -> dict[str, list]:
    import hashlib
    snap = {}
    for d, _, files in os.walk(root):
        for f in files:
            p = Path(d) / f
            rel = str(p.relative_to(root))
            if rel.startswith(HOST_OWNED):
                continue
            h = hashlib.sha1()
            with open(p, "rb") as fh:
                for b in iter(lambda: fh.read(1 << 20), b""):
                    h.update(b)
            snap[rel] = [p.stat().st_size, h.hexdigest()]
    return snap


def _local_buildid() -> str:
    m = (DS / "install" / "steamapps" / f"appmanifest_{SERVER_APPID}.acf").read_text()
    return re.search(r'"buildid"\s+"(\d+)"', m).group(1)


def do_update(c, u):
    """Bring the game server to Steam's build: update a local copy, upload what changed
    beside the live files, then drain, stop, swap and start, keeping the old files until
    the new version has booted."""
    want, have = steam_buildid(), installed_buildid(c, u)
    print(f"steam build {want} | installed {have}")
    if have == want:
        print("already current")
        return
    steamcmd = DS / "steamcmd" / "steamcmd.sh"
    if not steamcmd.exists():
        sys.exit(f"no steamcmd at {steamcmd}: unpack steamcmd_linux.tar.gz there first")
    before = _snapshot(DS / "install") if (DS / "install").exists() else {}
    import subprocess
    subprocess.run([str(steamcmd), "+force_install_dir", str(DS / "install"), "+login", "anonymous",
                    "+app_update", str(SERVER_APPID), "-beta", "public", "validate", "+quit"],
                   check=True, stdout=subprocess.DEVNULL)
    if _local_buildid() != want:
        sys.exit(f"steamcmd left the local copy at {_local_buildid()}, not {want}")
    after = _snapshot(DS / "install")
    changed = sorted(k for k in after if before.get(k) != after[k])
    removed = sorted(k for k in before if k not in after)
    print(f"{len(changed)} files changed ({sum(after[k][0] for k in changed) / 1e6:.0f} MB), {len(removed)} removed")
    t, s = _sftp()
    try:
        def exists(p):
            try:
                s.stat(p)
                return True
            except IOError:
                return False
        # the diff only means something if the server holds the build the local copy held
        for k in changed + removed:
            if k in before and (not exists(REMOTE_GAME + k) or s.stat(REMOTE_GAME + k).st_size != before[k][0]):
                sys.exit(f"the server's {k} is not the old local build's: upload the whole install instead")
        for k in changed:
            parts = (REMOTE_GAME + k).split("/")[:-1]
            for i in range(1, len(parts) + 1):
                if not exists("/".join(parts[:i])):
                    s.mkdir("/".join(parts[:i]))
            s.put(str(DS / "install" / k), REMOTE_GAME + k + ".new")
        print("staged beside the live files; the server is still running")
        who = running()
        if who:
            drain(60, "a game update")
        print(json.dumps(c.stop(u))[:100])
        deadline = time.time() + 300
        while running() is not None:
            if time.time() > deadline:
                sys.exit("the server still answers 5 min after stop: nothing swapped; the .new files wait")
            time.sleep(5)
        time.sleep(15)                                   # the process writes its saves on the way out
        for k in changed:
            if exists(REMOTE_GAME + k):
                s.posix_rename(REMOTE_GAME + k, REMOTE_GAME + k + ".old")
            s.posix_rename(REMOTE_GAME + k + ".new", REMOTE_GAME + k)
        for k in removed:
            if exists(REMOTE_GAME + k):
                s.posix_rename(REMOTE_GAME + k, REMOTE_GAME + k + ".old")
        s.put(str(DS / "install" / "steamapps" / f"appmanifest_{SERVER_APPID}.acf"), MANIFEST + ".new")
        s.posix_rename(MANIFEST + ".new", MANIFEST)
        print(json.dumps(c.start(u))[:100])
        deadline = time.time() + 300
        while running() is None:
            if time.time() > deadline:
                for k in changed + removed:                   # it did not come back: the old build again
                    if exists(REMOTE_GAME + k + ".old"):
                        s.posix_rename(REMOTE_GAME + k + ".old", REMOTE_GAME + k)
                print(json.dumps(c.start(u))[:100])
                sys.exit("the new build did not come up in 5 min: rolled back to the old files and started")
            time.sleep(5)
        time.sleep(20)
        log = c.read_file(u, "steamcmd/valheim/BepInEx/LogOutput.log")
        ver = re.findall(r"Valheim version: ([^\n]+)", log)
        print("booted:", ver[-1] if ver else "no version line yet")
        for k in changed + removed:
            if exists(REMOTE_GAME + k + ".old"):
                s.remove(REMOTE_GAME + k + ".old")
        print("update complete")
    finally:
        t.close()


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
    return running() or []


def running() -> list[str] | None:
    """The players connected, or None when the server does not answer at all."""
    try:
        with urllib.request.urlopen(f"{WEBMAP_URL}/players", timeout=10) as r:
            return [p.get("name", "?") for p in json.load(r).get("players", [])]
    except Exception:
        return None


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


# ---- deploys over SFTP --------------------------------------------------------
# The mod (WebMap.dll) and its viewer (the web/ folder) go up by SFTP, each file
# written as .new and renamed over the old one, so the server never reads half a
# file. A new dll loads at the next restart; the viewer shows at once, the mod's
# cache_server_files being off on our server.
PLUGIN_DIR = "steamcmd/valheim/BepInEx/plugins/WebMap"
MOD_REPO = Path(__file__).resolve().parents[2] / "valheim-webmap"


def _sftp():
    import paramiko  # only the deploys need it
    t = paramiko.Transport((os.environ["IB_SFTP_HOST"], int(os.environ["IB_SFTP_PORT"])))
    t.connect(username=os.environ["IB_SFTP_USER"], password=os.environ["IB_SFTP_PASS"])
    return t, paramiko.SFTPClient.from_transport(t)


def _put(sf, src: Path, dst: str):
    sf.put(str(src), dst + ".new")
    sf.posix_rename(dst + ".new", dst)
    print(f"{dst}  {src.stat().st_size} b")


def _mkdirs(sf, path: str, made: set):
    """Every missing folder down to path: SFTP makes them one at a time."""
    parts = path.split("/")
    for i in range(1, len(parts) + 1):
        p = "/".join(parts[:i])
        if p in made:
            continue
        try:
            sf.stat(p)
        except FileNotFoundError:
            sf.mkdir(p)
        made.add(p)


def deploy_web(src: str):
    """The whole web/ folder, subfolders too (the 3D view's js/ and vendor/three/)."""
    d = Path(src) if src else MOD_REPO / "WebMap" / "web"
    if not (d / "index.html").is_file():
        sys.exit(f"{d}: no index.html there")
    t, sf = _sftp()
    made: set = set()
    try:
        for f in sorted(p for p in d.rglob("*") if p.is_file()):
            dst = f"{PLUGIN_DIR}/web/{f.relative_to(d).as_posix()}"
            _mkdirs(sf, dst.rsplit("/", 1)[0], made)
            _put(sf, f, dst)
    finally:
        t.close()


def deploy_mod(dll: str):
    p = Path(dll)
    if p.suffix != ".dll" or not p.is_file():
        sys.exit("usage: ops.py deploy-mod path/to/WebMap.dll")
    t, sf = _sftp()
    try:
        _put(sf, p, f"{PLUGIN_DIR}/{p.name}")
    finally:
        t.close()
    print("it loads at the next restart: ops.py restart --drain")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["status", "start", "stop", "restart",
                                    "backup", "rcon", "admins", "activity",
                                    "announce", "update", "deploy-web", "deploy-mod"])
    ap.add_argument("arg", nargs="?", default="")
    ap.add_argument("--game", default="Valheim")
    ap.add_argument("--warn", type=int, metavar="SECONDS",
                    help="restart: shout a countdown in game first")
    ap.add_argument("--reason", default="", help="restart: why, for the shout")
    ap.add_argument("--drain", type=int, nargs="?", const=60, metavar="SECONDS",
                    help="restart: ask players to log out and wait for them "
                         "(default 300s) before restarting. Prefer this to --warn "
                         "whenever anyone is online -- see drain().")
    a = ap.parse_args()

    # the deploys talk SFTP, not the panel: no login needed
    if a.cmd == "deploy-web":
        return deploy_web(a.arg)
    if a.cmd == "deploy-mod":
        return deploy_mod(a.arg)

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
        # the panel answers a start on a running server by restarting it, with no drain
        who = running() if a.cmd == "start" else None
        if who is not None:
            sys.exit(f"the server is already running ({', '.join(who) or 'nobody on'}); "
                     "a start would restart it -- use `restart --drain` for that")
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
