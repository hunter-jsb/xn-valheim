#!/usr/bin/env python3
"""Push Valheim server health to Statuspage.io and the Pages status pill.

Health = an HTTP GET of the live WebMap endpoint (the mod's own server). A 200
means the game server + mod are up. No SFTP needed for the check.

Env: STATUSPAGE_API_KEY, STATUSPAGE_PAGE_ID,
     STATUSPAGE_SERVER_COMPONENT_ID, STATUSPAGE_WEBMAP_COMPONENT_ID,
     WEBMAP_URL (default http://170.23.227.3:27021).
"""
import json
import os
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API = "https://api.statuspage.io/v1"
WEBMAP_URL = os.environ.get("WEBMAP_URL", "http://170.23.227.3:27021")


def _up():
    try:
        with urllib.request.urlopen(WEBMAP_URL, timeout=12) as r:
            return 200 <= r.status < 300
    except Exception:
        return False


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
    up = _up()
    key = os.environ.get("STATUSPAGE_API_KEY")
    page = os.environ.get("STATUSPAGE_PAGE_ID")

    data_dir = Path(__file__).resolve().parent.parent / "docs" / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "status.json").write_text(json.dumps({
        "checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "game": "Valheim", "world": "Mothership",
        "ip": "170.23.227.3", "port": 27020,
        "online": bool(up), "webmap_url": WEBMAP_URL, "source": "webmap-http",
    }, indent=2) + "\n")

    status = "operational" if up else "major_outage"
    if key and page:
        _set(os.environ.get("STATUSPAGE_SERVER_COMPONENT_ID"), status, key, page)
        _set(os.environ.get("STATUSPAGE_WEBMAP_COMPONENT_ID"), status, key, page)
    print("server up:", up, "via", WEBMAP_URL)


if __name__ == "__main__":
    main()
