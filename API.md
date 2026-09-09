# Indifferent Broccoli control-panel API (reverse-engineered)

Indifferent Broccoli publishes **no official API**. Their staff confirm this on
Discord ("there isn't any documented API… there's probably a simple api that the
frontend uses that we could hook into"). This document is that frontend API,
captured from the dashboard at `https://dashboard.indifferentbroccoli.com`.

It is undocumented and unsupported. It is cookie-authenticated, rate-limited
(`300` requests / `900s`), and will show CAPTCHA challenges under abuse. Keep the
request rate low. Endpoints and payload shapes can change without notice.

## Auth

- **Login** — `POST /login`, `application/x-www-form-urlencoded`, body `email`,
  `password`. On success: `302 → /` and `Set-Cookie: indifferentSess=…`
  (HttpOnly, `Domain=.indifferentbroccoli.com`, expires ~24h).
- **Session cookie** — `indifferentSess`. Send it on every call.
- **Check** — `GET /session-check` → `200 {"ok":true}` or `401
  {"sessionExpired":true}`. A `401` on any endpoint means re-login.
- **Logout** — `/logout`.

Because the cookie lasts only ~24h, unattended automation stores
`IB_EMAIL`/`IB_PASSWORD` and logs in on demand rather than pinning a cookie.

## Server identity

Every server is keyed by a 12-char **`linuxUsername`**, not a numeric id. The
dashboard embeds each as `fileBrowser('<linuxUsername>','<ip>','<game>')`. This
account's Valheim server: `linuxUsername=4RM8tBOucr5l`, ip `170.23.227.3`,
game `Valheim`. Server-scoped calls send `serverLinuxUsername=<linuxUsername>`.

## Lifecycle & config (POST, form-encoded, include `serverLinuxUsername`)

Responses carry `{"notificationHtml": "…"}`. **Config saves restart the server** —
there is no apply-without-restart path.

| Endpoint | Purpose |
|----------|---------|
| `/start` `/stop` `/restart` `/resetserver` | power actions |
| `/updateserver` | update / revert game version |
| `/transferregion` | move to another region |
| `/saveconfig` | server settings (name, password, world, crossplay, modifiers, max players) |
| `/savemods` | Thunderstore mod list |
| `/saveGameIni` | raw game config |
| `/scheduler` | scheduled auto-restarts (`slots`) |

> `saveconfig` field names are Alpine-bound and not in static HTML; capture them
> from one real "Save Config" request in browser devtools before automating writes.
> The safer config surface is the on-disk files below.

## Files (SFTP-over-HTTP)

- `GET /files/view?username=<linuxUsername>&path=<path>` → `{"content":"…"}`
  (text) or `404 {"error":"Not a file"}`.
- `POST /files/save?username=&path=` — body is the raw file (`Content-Type:
  text/plain`).
- `POST /download-file` — binary download (e.g. the world `.db`/`.fwl`).
- Rich file ops also run over socket.io (`fileBrowser:list|search|rename|delete|
  paste|compress|extract|createFile|createFolder`, `getFile`).

Valheim server-state files (relative to the server root):

| File | Meaning |
|------|---------|
| `.config/unity3d/IronGate/Valheim/adminlist.txt` | admin Steam IDs (one per line) |
| `.config/unity3d/IronGate/Valheim/bannedlist.txt` | bans |
| `.config/unity3d/IronGate/Valheim/permittedlist.txt` | allowlist |
| `.config/unity3d/IronGate/Valheim/worlds_local/<world>.fwl` | world metadata (seed) |
| `.config/unity3d/IronGate/Valheim/worlds_local/<world>.db` | world save |

## Backups

- `POST /createsavebackup` — JSON `{"serverLinuxUsername":"…"}` → `{notificationHtml}`;
  a `backupComplete` socket event fires when done.
- `POST /restoresavebackup`, `GET /server-data/saves`.

## RCON & console

- `POST /rconsend` — JSON `{"serverLinuxUsername":"…","command":"…"}`. (Vanilla
  Valheim RCON needs a mod; admin commands otherwise go through the game console.)
- `POST /startLogs` (form `serverLinuxUsername`) → console streams via socket
  `updateConsole`.
- `POST /startStats` (form `serverLinuxUsername`) → telemetry streams via socket
  `updateStats`.

## Roles / subusers

- `GET /getSubuserPermissions?email=<email>` →
  `{"permissions":{"<linuxUsername>":{"<permKey>":true|false}}}`.
- `POST /saveSubuserPermissions` — form `subuserEmail` + per-permission toggles.
- `/sendSubuserInvite`, `/removeSubuser`, `/revokeaccess`.

This per-subuser × per-server permission matrix is the "roles as code" surface.

## Activity & account

- `GET /activity-server/<linuxUsername>` → `{"activities":[{"action","timestamp"}]}`.
- `GET /activity-server-history/<linuxUsername>?page=<n>`.
- `GET /activity-account`.
- `GET /billing-data`, `POST /saveaccountdetails`, `POST /save-server-order`.

## Realtime (socket.io 4.x)

- Client: `io('/', { transports:['websocket'], query:{ rooms:[<linuxUsername>,…] } })`
  at `socket.io_path=/socket.io`, authenticated by the session cookie.
- Client emits: `watch` / `unwatch`, `getFile`, `fileBrowser:*`.
- Server emits: `updateStatus`, `updateStats` (cpu/ram), `updatePlayers`,
  `updateGamedigStatus`, `updatePort`, `updateConsole`, `updateFile`,
  `updateServerConfig`, `updateServerActivity`, `backupComplete`,
  `newServerReady`, `checkoutComplete`.

Telemetry streams only after a `POST /startStats` (and `/startLogs`) primes it.

## Open-source escape hatch

Indifferent Broccoli open-sources the server images this all runs on —
e.g. [`indifferentbroccoli/valheim-server-docker`][vsd]. If a panel action
misbehaves, the image's `scripts/` (`init.sh`, `start.sh`, `compile-settings.sh`)
show the exact env-var → server behavior mapping, and bugs can go upstream there.

[vsd]: https://github.com/indifferentbroccoli/valheim-server-docker
