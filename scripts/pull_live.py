#!/usr/bin/env python3
"""Pull live server state from the WebMap mod into docs/data.

  messages.json -> recent chat + join/leave events   (HTTP /messages)
  players.json  -> who's online                      (websocket "players")

Positions are deliberately NOT published: the mod reports them even for players
who set themselves hidden, and this feeds a public page. Names/counts only.

Env: WEBMAP_URL (default http://170.23.227.3:27021)
"""
import json
import os
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE = os.environ.get("WEBMAP_URL", "http://170.23.227.3:27021").rstrip("/")
DST = Path(__file__).resolve().parent.parent / "docs" / "data"
KEEP = 40
NOW = datetime.now(timezone.utc).isoformat(timespec="seconds")


def messages():
    try:
        with urllib.request.urlopen(BASE + "/messages", timeout=15) as r:
            msgs = json.loads(r.read().decode("utf-8", "replace") or "[]")
    except Exception as e:
        print("messages: unavailable", e)
        return
    if not isinstance(msgs, list):
        return
    msgs = msgs[-KEEP:]
    (DST / "messages.json").write_text(json.dumps(
        {"checked_at": NOW, "messages": msgs}, indent=1) + "\n")
    print("messages:", len(msgs))


def _map_geom():
    """pixel_size / texture_size from the mod, for world->image conversion."""
    try:
        with urllib.request.urlopen(BASE + "/config", timeout=12) as r:
            c = json.loads(r.read().decode("utf-8", "replace"))
        return float(c.get("pixel_size", 12)), float(c.get("texture_size", 2048))
    except Exception:
        return 12.0, 2048.0


def players():
    names, count, markers = [], 0, []
    pixel_size, texture_size = _map_geom()
    try:
        import websocket
        ws = websocket.create_connection(BASE.replace("http://", "ws://") + "/", timeout=12)
        ws.send("players")
        frame = ""
        for _ in range(5):
            frame = ws.recv()
            if isinstance(frame, str) and frame.startswith("players"):
                break
        ws.close()
        body = frame.split("\n", 1)[1] if "\n" in frame else ""
        for block in [b for b in body.split("\n\n") if b.strip()]:
            lines = block.split("\n")
            if len(lines) < 4:
                continue
            name = lines[1]
            names.append(name)
            middle = lines[4:-1]                       # optional "hidden" / "x,z"
            hidden = "hidden" in middle
            pos = next((m for m in middle if "," in m), None)
            # Match the mod's own UI: with always_visible off, hidden players
            # are not drawn. Never publish their coordinates.
            if hidden or not pos:
                continue
            try:
                x, z = (float(v) for v in pos.split(",", 1))
            except ValueError:
                continue
            markers.append({
                "name": name,
                "px": round(x / pixel_size + texture_size / 2, 2),
                "py": round(texture_size / 2 - z / pixel_size, 2),
            })
        count = len(names)
    except Exception as e:
        print("players: unavailable", e)
        (DST / "players.json").write_text(json.dumps(
            {"checked_at": NOW, "count": None, "names": []}, indent=1) + "\n")
        return
    (DST / "players.json").write_text(json.dumps(
        {"checked_at": NOW, "count": count, "names": names, "markers": markers}, indent=1) + "\n")
    print("players:", count, names, "| shown on map:", len(markers))


def pins():
    """Player-placed pins (created in-game with !pin) -> image coords."""
    pixel_size, texture_size = _map_geom()
    try:
        with urllib.request.urlopen(BASE + "/pins", timeout=15) as r:
            raw = r.read().decode("utf-8", "replace")
    except Exception as e:
        print("pins: unavailable", e)
        return
    out = []
    for line in raw.splitlines():
        # id,pinId,type,owner,x,z,text
        f = line.split(",")
        if len(f) < 6:
            continue
        try:
            x, z = float(f[4]), float(f[5])
        except ValueError:
            continue
        out.append({
            "type": f[2], "owner": f[3], "text": ",".join(f[6:]).strip(),
            "px": round(x / pixel_size + texture_size / 2, 2),
            "py": round(texture_size / 2 - z / pixel_size, 2),
        })
    (DST / "pins.json").write_text(json.dumps(
        {"checked_at": NOW, "pins": out}, indent=1) + "\n")
    print("pins:", len(out))


if __name__ == "__main__":
    DST.mkdir(parents=True, exist_ok=True)
    messages()
    players()
    pins()
