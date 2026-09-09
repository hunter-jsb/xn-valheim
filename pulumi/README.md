# pulumi — Valheim server state as code

A Pulumi program that reconciles server state on Indifferent Broccoli through the
panel's file API (see `../API.md`). Today it manages the **role files** —
`adminlist.txt`, `bannedlist.txt`, `permittedlist.txt` — as the source of truth:
edit the files in `state/valheim/`, run `pulumi up`, and the live server matches.

```bash
cd pulumi
export IB_EMAIL=hunterjsb@gmail.com IB_PASSWORD=...   # up/refresh only; preview needs nothing
pulumi stack init prod
pulumi preview      # shows the diff between state/ and the live files
pulumi up
```

`ManagedServerFile` (in `provider.py`) is a dynamic provider: create/update write
the file, `read`/`refresh` pull the live content, `diff` compares text, and
`destroy` is a **no-op** so tearing down the stack never wipes live game files.

## Roadmap (needs one captured request each)

The panel's `saveconfig`, `savemods`, and `saveSubuserPermissions` use
Alpine-bound field names not present in static HTML. Capture one real request per
form from browser devtools, then add resources:

- `ServerConfig` → `/saveconfig` (name, password, world, crossplay, modifiers) — **restarts the server**.
- `Mods` → `/savemods` (Thunderstore deps) — **restarts the server**.
- `Subuser` → `/saveSubuserPermissions` (per-server permission matrix) — dashboard roles as code.

Until then, config/mods are set in the panel and only the file-backed state
(roles/allowlist/bans) lives here.
