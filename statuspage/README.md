# statuspage — Valheim uptime on Statuspage.io

Pulumi (Go) components for the Valheim server on the shared Statuspage.io page
(`hg4lqksf4fvl`, shared with xn-mc). Mirrors xn-mc's setup.

```bash
cd statuspage
export STATUSPAGE_TOKEN=...            # Statuspage.io API token (up/refresh only)
export PULUMI_BACKEND_URL="file://$PWD/state" PULUMI_CONFIG_PASSPHRASE=xn-valheim
pulumi install                          # regenerates sdks/ from the packages: block
pulumi stack select valheim
pulumi preview
```

Components: **Valheim Server** and **World Map**. The `sdks/` bridge SDK and the
local `state/` backend are generated/local and gitignored.

Status is pushed by [`../scripts/statuspage_push.py`](../scripts/statuspage_push.py):
it marks both components operational while the server's BepInEx log is fresh
(SFTP), else major_outage. Needs `STATUSPAGE_API_KEY`, `STATUSPAGE_PAGE_ID`, the
component ids, and `IB_SFTP_*` in the environment.
