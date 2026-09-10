# statuspage — Valheim uptime on Statuspage.io

Pulumi (Go) components for the Valheim server on the Statuspage.io page
`hg4lqksf4fvl` ("Xandaris", still served at xnmc.statuspage.io). The page began
life as xn-mc's; its Minecraft components were deleted on 2026-09-10 and only the
two Valheim ones remain. Statuspage's free plan is one page per account, so
repurposing this one is the whole reason there isn't a separate Valheim page.

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
**Valheim Server** follows the mod's own HTTP endpoint; **World Map** additionally
requires the Cloudflare Worker the public page reads through, so it can never look
healthier than the server behind it. Needs `STATUSPAGE_API_KEY`,
`STATUSPAGE_PAGE_ID` and the two component ids in the environment.
