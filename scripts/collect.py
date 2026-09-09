#!/usr/bin/env python3
"""Collect Valheim server metrics -> docs/data/status.json (+ append history.json).

Two sources, tried in order:
  1. Authenticated panel telemetry (accurate cpu/ram/players/status) when
     IB_EMAIL/IB_PASSWORD or IB_SESSION is set.
  2. Direct Steam A2S query (no credentials) as a fallback.

Run:  uv run --project scripts scripts/collect.py --game Valheim
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "data"
HISTORY_CAP = 2016  # ~1 week at 5-min cadence


def a2s_probe(host: str, query_port: int) -> dict | None:
    try:
        import a2s
        info = a2s.info((host, query_port), timeout=6.0)
        return {
            "online": True,
            "name": info.server_name,
            "map": info.map_name,
            "players": info.player_count,
            "max_players": info.max_players,
            "version": getattr(info, "version", None),
            "ping_ms": round(info.ping * 1000) if info.ping else None,
            "source": "a2s",
        }
    except Exception:
        return None


def authed_probe(game: str) -> dict | None:
    if not (os.environ.get("IB_EMAIL") or os.environ.get("IB_SESSION")):
        return None
    sys.path.insert(0, str(ROOT))
    try:
        from ib import IBClient
        from ib.stats import collect as collect_stats
        c = IBClient()
        if not c.session_ok():
            c.login()
        sv = c.find(game)
        snap = collect_stats(c, sv.linux_username, seconds=8.0)
        status = snap.get("status")
        return {
            "online": (str(status).lower() == "online") if status else None,
            "status": status,
            "players": _num(snap.get("players")),
            "stats": snap.get("stats"),
            "gamedig": snap.get("gamedig"),
            "ip": sv.ip,
            "linuxUsername": sv.linux_username,
            "source": "panel",
        }
    except Exception as e:  # never fail the run on a flaky panel
        return {"error": str(e), "source": "panel"}


def _num(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", default="Valheim")
    ap.add_argument("--host", default=os.environ.get("VH_HOST", "170.23.227.3"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("VH_PORT", "27020")),
                    help="game port; A2S query port is this + 1")
    args = ap.parse_args()

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    result = {"checked_at": now, "game": args.game, "online": None}

    panel = authed_probe(args.game)
    if panel and not panel.get("error"):
        result.update(panel)
    a2s = a2s_probe(args.host, args.port + 1)
    if a2s:
        # A2S is authoritative for player list / map when reachable
        result.update({k: v for k, v in a2s.items() if v is not None})
    if panel and panel.get("error") and result.get("online") is None:
        result["panel_error"] = panel["error"]

    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / "status.json").write_text(json.dumps(result, indent=2) + "\n")

    hist_path = DATA / "history.json"
    hist = json.loads(hist_path.read_text()) if hist_path.exists() else []
    hist.append({
        "t": now,
        "online": result.get("online"),
        "players": result.get("players"),
        "cpu": (result.get("stats") or {}).get("cpu") if isinstance(result.get("stats"), dict) else None,
        "ram": (result.get("stats") or {}).get("ram") if isinstance(result.get("stats"), dict) else None,
    })
    hist = hist[-HISTORY_CAP:]
    hist_path.write_text(json.dumps(hist) + "\n")

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
