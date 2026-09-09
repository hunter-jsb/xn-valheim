"""Live metrics over socket.io (the panel's own realtime feed).

The dashboard connects socket.io (v4), joins a room per `linuxUsername`, then
POSTs /startStats + /startLogs to make the backend stream telemetry. The server
emits: updateStatus, updateStats (cpu/ram), updatePlayers, updateGamedigStatus.
This collects one snapshot and returns it. Requires `python-socketio[client]`.
"""
from __future__ import annotations

import time

from .client import BASE, IBClient


def collect(client: IBClient, linux_username: str, seconds: float = 8.0) -> dict:
    import socketio  # lazy: optional dependency

    cookie = client.s.cookies.get("indifferentSess", domain=".indifferentbroccoli.com")
    snap: dict = {"linuxUsername": linux_username}
    sio = socketio.Client(reconnection=False, request_timeout=10)

    @sio.on("updateStatus")
    def _st(d):   snap["status"] = _val(d, "status", d)
    @sio.on("updateStats")
    def _stat(d): snap["stats"] = d
    @sio.on("updatePlayers")
    def _pl(d):   snap["players"] = _val(d, "players", d)
    @sio.on("updateGamedigStatus")
    def _gd(d):   snap["gamedig"] = d

    sio.connect(BASE, transports=["websocket"],
                headers={"Cookie": f"indifferentSess={cookie}"},
                socketio_path="/socket.io",
                wait_timeout=10)
    try:
        sio.emit("watch", linux_username)
    except Exception:
        pass
    # prime the streams
    for path in ("/startStats", "/startLogs"):
        try:
            client.s.post(f"{BASE}{path}", data={"serverLinuxUsername": linux_username},
                          timeout=10)
        except Exception:
            pass
    time.sleep(seconds)
    sio.disconnect()
    return snap


def _val(d, key, default):
    return d.get(key) if isinstance(d, dict) else default
