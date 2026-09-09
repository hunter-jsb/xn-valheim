# xn-valheim

Infrastructure-as-code for the Xandaris **Valheim** server, hosted on
[Indifferent Broccoli][ib]. Server settings, role/ban/allow lists, and common
operations live in this repo; live status, metrics, and a world map are published
to a GitHub Page.

Valheim hit **1.0 (Deep North)** on 2026-09-09; this server runs on it.

## Layout

| Path | What |
|------|------|
| [`API.md`](API.md) | The reverse-engineered Indifferent Broccoli control-panel API |
| [`ib/`](ib) | Python client for that API (login, files, config, backups, RCON, stats) |
| [`pulumi/`](pulumi) | State-as-code: role/ban/allow lists reconciled onto the server |
| [`scripts/`](scripts) | Ops CLI (`restart`, `backup`, `rcon`, `status`) + the metrics collector |
| [`docs/`](docs) | The GitHub Page — live status, player/CPU/RAM charts, world map |
| [`.github/workflows/`](.github/workflows) | Cron job that refreshes the metrics data |

## The catch: there is no official API

Indifferent Broccoli publishes no API — their own staff confirm it. Management
happens through a web dashboard (a private JSON + socket.io backend), SFTP, and a
Discord bot. This repo drives the **same private endpoints the dashboard uses**,
authenticated by an `indifferentSess` session cookie. It is undocumented, cookie-
auth, rate-limited (300 req / 15 min), and CAPTCHA-guarded under load — so keep the
request rate low. Full contract in [`API.md`](API.md).

The safest surface — used by the Pulumi program — is the **file API**
(`/files/view`, `/files/save`), which round-trips server files exactly and needs
no restart. Power/config actions (`/restart`, `/saveconfig`, `/savemods`) do
restart the live server.

## Quick start

```bash
export IB_EMAIL=hunterjsb@gmail.com
export IB_PASSWORD=...            # or export IB_SESSION=<indifferentSess cookie>

uv run --project scripts scripts/ops.py status
uv run --project scripts scripts/ops.py restart
uv run --project scripts scripts/collect.py --game Valheim   # refresh the page data

cd pulumi && pulumi preview       # diff role/ban/allow lists vs. the live server
```

## Metrics auth — a decision

Accurate telemetry (cpu/ram/players/status) needs a logged-in session, and IB's
only credential is the account password. Two ways to run the collector:

1. **GitHub Actions (self-contained)** — add `IB_EMAIL`/`IB_PASSWORD` repo
   secrets. Convenient, but it puts the account password (which also controls
   billing) in a secret on a public repo. Without the secrets the collector falls
   back to a credential-free Steam A2S probe.
2. **A private runner** (bazzite / the macair node) — creds stay in a local
   `.env`, the job commits `docs/data/*.json`. No password in GitHub.

Nothing in this repo stores credentials; they only ever come from the environment.

## Upstream

IB open-sources the Docker images the servers run on, including
[`valheim-server-docker`][vsd]. Its `scripts/` document the exact env-var →
behavior mapping, and genuine bugs can be reported there.

[ib]: https://indifferentbroccoli.com/valheim-server-hosting
[vsd]: https://github.com/indifferentbroccoli/valheim-server-docker
