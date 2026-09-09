#!/usr/bin/env python3
"""Pull the WebMap render from the mod's own HTTP server into docs/data/map.

The WebMap mod serves the world map over HTTP (no SFTP needed):
  /map  -> world image (PNG bytes)   /fog -> explored-areas mask (PNG)   /pins -> CSV

Env: WEBMAP_URL (default http://170.23.227.3:27021).
"""
import os
import urllib.request
from pathlib import Path

BASE = os.environ.get("WEBMAP_URL", "http://170.23.227.3:27021").rstrip("/")
DST = Path(__file__).resolve().parent.parent / "docs" / "data" / "map"
FILES = {"/map": "map.png", "/fog": "fog.png", "/pins": "pins.csv"}


def main():
    DST.mkdir(parents=True, exist_ok=True)
    for route, name in FILES.items():
        try:
            with urllib.request.urlopen(BASE + route, timeout=20) as r:
                data = r.read()
        except Exception as e:
            print("skip", route, f"({e})")
            continue
        if not data:
            print("skip", route, "(empty)")
            continue
        (DST / name).write_bytes(data)
        print("pulled", route, "->", name, len(data))


if __name__ == "__main__":
    main()
