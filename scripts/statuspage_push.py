#!/usr/bin/env python3
"""Push Valheim server health to Statuspage.io.

Two components, two probes, because they fail independently: the game server is
the mod's own HTTP endpoint (a 200 means the process and the mod are alive), and
the world map is the Cloudflare Worker the public page actually reads through.

Env: STATUSPAGE_API_KEY, STATUSPAGE_PAGE_ID,
     STATUSPAGE_SERVER_COMPONENT_ID, STATUSPAGE_WEBMAP_COMPONENT_ID,
     WEBMAP_URL (default http://170.23.227.3:27021),
     PROXY_URL (default the valheim-proxy Worker).
"""
import os
import urllib.request

API = "https://api.statuspage.io/v1"
WEBMAP_URL = os.environ.get("WEBMAP_URL", "http://170.23.227.3:27021")
PROXY_URL = os.environ.get(
    "PROXY_URL", "https://valheim-proxy.hunterjsb.workers.dev/config")


def _up(url):
    # Cloudflare blocks the default python-urllib agent, so the Worker probe
    # fails as an outage unless we identify ourselves
    req = urllib.request.Request(url, headers={"User-Agent": "xn-valheim-statuspage/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=12) as r:
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
    server_up = _up(WEBMAP_URL)
    # the map is only usable if the proxy is up too, so it can never look
    # healthier than the server behind it
    map_up = server_up and _up(PROXY_URL)
    key = os.environ.get("STATUSPAGE_API_KEY")
    page = os.environ.get("STATUSPAGE_PAGE_ID")

    if key and page:
        _set(os.environ.get("STATUSPAGE_SERVER_COMPONENT_ID"),
             "operational" if server_up else "major_outage", key, page)
        _set(os.environ.get("STATUSPAGE_WEBMAP_COMPONENT_ID"),
             "operational" if map_up else "major_outage", key, page)
    print("server up:", server_up, "via", WEBMAP_URL)
    print("map up:   ", map_up, "via", PROXY_URL)


if __name__ == "__main__":
    main()
