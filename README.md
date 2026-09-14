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
| [`site/`](site) | Our `site-config.js` for the map site. The site itself is the mod's bundled viewer (`WebMap/web` in [valheim-webmap](https://github.com/hunter-jsb/valheim-webmap)); the `site` workflow deploys it to the GitHub Page with this config on top |
| [`worker/`](worker) | The Cloudflare Worker that fronts the mod's HTTP API for the page: HTTPS, CORS, a path allowlist, edge caching |
| [`.github/workflows/`](.github/workflows) | Cron job that refreshes the metrics data |

## Quick start

```bash
export IB_EMAIL=hunterjsb@gmail.com
export IB_PASSWORD=...            # or export IB_SESSION=<indifferentSess cookie>

uv run --project scripts scripts/ops.py status
uv run --project scripts scripts/ops.py restart
uv run --project scripts scripts/ops.py deploy-web      # the viewer, straight to the mod's web folder
uv run --project scripts scripts/ops.py deploy-mod ../valheim-webmap/dist/WebMap.dll
uv run --project scripts scripts/collect.py --game Valheim   # refresh the page data

cd pulumi && pulumi preview       # diff role/ban/allow lists vs. the live server
```

## Upstream

IB open-sources the Docker images the servers run on, including
[`valheim-server-docker`][vsd]. Its `scripts/` document the exact env-var →
behavior mapping, and genuine bugs can be reported there.

[ib]: https://indifferentbroccoli.com/valheim-server-hosting
[vsd]: https://github.com/indifferentbroccoli/valheim-server-docker
