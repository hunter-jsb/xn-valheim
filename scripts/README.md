# scripts

Imperative operations against the Indifferent Broccoli control panel. All auth
comes from the environment — never pass credentials on the command line.

```bash
export IB_EMAIL=hunterjsb@gmail.com
export IB_PASSWORD=...            # or: export IB_SESSION=<indifferentSess cookie>
```

| Command | Effect |
|---------|--------|
| `ops.py status`   | server identity + last 5 activity events |
| `ops.py restart`  | restart the live server |
| `ops.py backup`   | trigger a world backup |
| `ops.py rcon "…"` | send an RCON/console command |
| `ops.py admins`   | print `adminlist.txt` |
| `collect.py`      | write `docs/data/status.json` for the metrics page |

Run with uv (installs `scripts/pyproject.toml` deps into an ephemeral env):

```bash
uv run --project scripts scripts/ops.py status
uv run --project scripts scripts/collect.py --game Valheim
```

`restart`/`start`/`stop`/`saveconfig`/`savemods` **restart the live server** — the
panel has no config-without-restart path. See `../API.md` for the full contract.
