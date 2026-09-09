#!/usr/bin/env python3
"""Pull the WebMap-rendered world map from the server over SFTP into docs/data/map.

map.png is the full world render (large, changes rarely); fog.png (explored areas)
and pins.csv update as the world is played. Env: IB_SFTP_HOST/PORT/USER/PASS.

  uv run --with paramiko scripts/pull_map.py
"""
import os
from pathlib import Path

import paramiko

ROOT = Path(__file__).resolve().parent.parent
DST = ROOT / "docs" / "data" / "map"
WORLD = os.environ.get("VH_WORLD", "Mothership")
REMOTE = f"steamcmd/valheim/BepInEx/plugins/WebMap/map_data/{WORLD}"


def main():
    DST.mkdir(parents=True, exist_ok=True)
    t = paramiko.Transport((os.environ["IB_SFTP_HOST"], int(os.environ.get("IB_SFTP_PORT", "22"))))
    t.connect(username=os.environ["IB_SFTP_USER"], password=os.environ["IB_SFTP_PASS"])
    sf = paramiko.SFTPClient.from_transport(t)
    for fn in ("map.png", "fog.png", "pins.csv"):
        try:
            sf.get(f"{REMOTE}/{fn}", str(DST / fn))
            print("pulled", fn, (DST / fn).stat().st_size)
        except IOError:
            print("skip", fn, "(not present)")
    t.close()


if __name__ == "__main__":
    main()
