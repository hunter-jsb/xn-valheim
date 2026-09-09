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


def players():
    names, count = [], 0
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
            if len(lines) >= 4:
                names.append(lines[1])
        count = len(names)
    except Exception as e:
        print("players: unavailable", e)
        (DST / "players.json").write_text(json.dumps(
            {"checked_at": NOW, "count": None, "names": []}, indent=1) + "\n")
        return
    (DST / "players.json").write_text(json.dumps(
        {"checked_at": NOW, "count": count, "names": names}, indent=1) + "\n")
    print("players:", count, names)


if __name__ == "__main__":
    DST.mkdir(parents=True, exist_ok=True)
    messages()
    players()
