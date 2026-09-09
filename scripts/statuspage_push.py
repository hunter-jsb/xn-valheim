#!/usr/bin/env python3
"""Push Valheim server health to Statuspage.io (like xn-mc's bot).

Health signal: the server writes BepInEx/LogOutput.log continuously while running,
so a recent mtime means it's up. The WebMap component tracks the same process.

Env: STATUSPAGE_API_KEY, STATUSPAGE_PAGE_ID, IB_SFTP_HOST/PORT/USER/PASS,
     STATUSPAGE_SERVER_COMPONENT_ID, STATUSPAGE_WEBMAP_COMPONENT_ID.
"""
import os
import time
import urllib.request

import paramiko

API = "https://api.statuspage.io/v1"
LOG = "steamcmd/valheim/BepInEx/LogOutput.log"
FOG = "steamcmd/valheim/BepInEx/plugins/WebMap/map_data/Mothership/fog.png"
FRESH = 300  # seconds


def _mtime_age(sf, path):
    try:
        return time.time() - sf.stat(path).st_mtime
    except IOError:
        return None


def _set(component_id, status, key, page):
    if not component_id:
        return
    req = urllib.request.Request(
        f"{API}/pages/{page}/components/{component_id}.json",
        data=('{"component":{"status":"%s"}}' % status).encode(),
        headers={"Authorization": f"OAuth {key}", "Content-Type": "application/json"},
        method="PATCH",
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        print(component_id, "->", status, r.status)


def main():
    key = os.environ["STATUSPAGE_API_KEY"]
    page = os.environ["STATUSPAGE_PAGE_ID"]
    t = paramiko.Transport((os.environ["IB_SFTP_HOST"], int(os.environ.get("IB_SFTP_PORT", "22"))))
    t.connect(username=os.environ["IB_SFTP_USER"], password=os.environ["IB_SFTP_PASS"])
    sf = paramiko.SFTPClient.from_transport(t)
    log_age = _mtime_age(sf, LOG)
    up = log_age is not None and log_age < FRESH
    t.close()

    status = "operational" if up else "major_outage"
    _set(os.environ.get("STATUSPAGE_SERVER_COMPONENT_ID"), status, key, page)
    _set(os.environ.get("STATUSPAGE_WEBMAP_COMPONENT_ID"), status, key, page)
    print("server up:", up, "(log age %ss)" % (round(log_age) if log_age is not None else "n/a"))


if __name__ == "__main__":
    main()
