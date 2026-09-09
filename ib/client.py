"""HTTP client for the Indifferent Broccoli control panel.

Auth is a session cookie (`indifferentSess`) obtained by POSTing credentials
to /login. The cookie is HttpOnly and expires ~24h after issue, so long-lived
automation logs in on demand. All server-scoped calls key off `linuxUsername`.

Credentials come from the environment, never arguments in shell history:
    IB_EMAIL, IB_PASSWORD          -> login()
    IB_SESSION (indifferentSess)   -> use an existing browser cookie instead
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field

import requests

BASE = "https://dashboard.indifferentbroccoli.com"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36")


class IBError(RuntimeError):
    pass


@dataclass
class Server:
    linux_username: str
    ip: str | None = None
    game: str | None = None
    server_id: str | None = None
    raw: dict = field(default_factory=dict)


class IBClient:
    def __init__(self, session_cookie: str | None = None, timeout: float = 20.0):
        self.s = requests.Session()
        self.s.headers["User-Agent"] = UA
        self.timeout = timeout
        cookie = session_cookie or os.environ.get("IB_SESSION")
        if cookie:
            self.s.cookies.set("indifferentSess", cookie,
                               domain=".indifferentbroccoli.com")

    # ---- auth -------------------------------------------------------------
    def login(self, email: str | None = None, password: str | None = None) -> "IBClient":
        email = email or os.environ["IB_EMAIL"]
        password = password or os.environ["IB_PASSWORD"]
        r = self.s.post(f"{BASE}/login", data={"email": email, "password": password},
                        allow_redirects=False, timeout=self.timeout)
        if r.status_code != 302 or "indifferentSess" not in self.s.cookies:
            raise IBError(f"login failed (status {r.status_code})")
        return self

    def session_ok(self) -> bool:
        r = self.s.get(f"{BASE}/session-check", timeout=self.timeout)
        return r.status_code == 200 and r.json().get("ok") is True

    def _ensure(self):
        if not self.session_ok():
            if os.environ.get("IB_EMAIL"):
                self.login()
            else:
                raise IBError("session expired and no IB_EMAIL/IB_PASSWORD to re-login")

    # ---- discovery --------------------------------------------------------
    def servers(self) -> list[Server]:
        """Parse the dashboard HTML for the account's servers (linuxUsername, ip, game)."""
        self._ensure()
        html = self.s.get(f"{BASE}/", timeout=self.timeout).text
        out = []
        for m in re.finditer(r"fileBrowser\('([^']+)','([^']+)','([^']+)'\)", html):
            out.append(Server(linux_username=m.group(1), ip=m.group(2), game=m.group(3)))
        return out

    def find(self, game: str) -> Server:
        for sv in self.servers():
            if (sv.game or "").lower() == game.lower():
                return sv
        raise IBError(f"no server for game {game!r}")

    # ---- lifecycle (these RESTART the live server) ------------------------
    def _action(self, path: str, linux_username: str, **fields):
        self._ensure()
        data = {"serverLinuxUsername": linux_username, **fields}
        r = self.s.post(f"{BASE}{path}", data=data, timeout=self.timeout)
        if r.status_code == 401:
            raise IBError("session expired")
        r.raise_for_status()
        try:
            return r.json()
        except ValueError:
            return {"raw": r.text}

    def start(self, u):    return self._action("/start", u)
    def stop(self, u):     return self._action("/stop", u)
    def restart(self, u):  return self._action("/restart", u)
    def reset(self, u):    return self._action("/resetserver", u)

    def save_config(self, u, **fields):  return self._action("/saveconfig", u, **fields)
    def save_mods(self, u, **fields):    return self._action("/savemods", u, **fields)
    def scheduler(self, u, **fields):    return self._action("/scheduler", u, **fields)
    def update_version(self, u, **f):    return self._action("/updateserver", u, **f)

    def rcon(self, u, command: str):
        self._ensure()
        r = self.s.post(f"{BASE}/rconsend",
                        json={"serverLinuxUsername": u, "command": command},
                        timeout=self.timeout)
        r.raise_for_status()
        return r.json() if r.content else {}

    # ---- backups ----------------------------------------------------------
    def create_backup(self, u):
        self._ensure()
        r = self.s.post(f"{BASE}/createsavebackup",
                        json={"serverLinuxUsername": u}, timeout=self.timeout)
        r.raise_for_status()
        return r.json()

    # ---- files (SFTP-over-HTTP) -------------------------------------------
    def read_file(self, u, path: str) -> str:
        self._ensure()
        r = self.s.get(f"{BASE}/files/view",
                       params={"username": u, "path": path}, timeout=self.timeout)
        if r.status_code == 404:
            raise IBError(f"not a file: {path}")
        r.raise_for_status()
        return r.json().get("content", "")

    def write_file(self, u, path: str, content: str):
        self._ensure()
        r = self.s.post(f"{BASE}/files/save",
                        params={"username": u, "path": path},
                        data=content.encode(),
                        headers={"Content-Type": "text/plain"}, timeout=self.timeout)
        r.raise_for_status()
        return True

    # ---- roles / subusers -------------------------------------------------
    def subuser_permissions(self, email: str) -> dict:
        self._ensure()
        r = self.s.get(f"{BASE}/getSubuserPermissions",
                       params={"email": email}, timeout=self.timeout)
        r.raise_for_status()
        return r.json().get("permissions", {})

    # ---- activity ---------------------------------------------------------
    def activity(self, u) -> list[dict]:
        self._ensure()
        r = self.s.get(f"{BASE}/activity-server/{u}", timeout=self.timeout)
        r.raise_for_status()
        return r.json().get("activities", [])
