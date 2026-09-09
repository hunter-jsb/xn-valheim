#!/usr/bin/env bash
# Deploy the Worker via the Cloudflare API. Needs CF_ACCOUNT_ID and a token with
# Workers Scripts:Edit in the environment (see ../.env, gitignored).
set -euo pipefail
: "${CF_ACCOUNT_ID:?}" "${CF_API_TOKEN:?}"
NAME=${1:-valheim-proxy}
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
curl -sf -4 -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/scripts/${NAME}" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -F "metadata={\"main_module\":\"valheim-proxy.js\",\"compatibility_date\":\"2026-01-01\"};type=application/json" \
  -F "valheim-proxy.js=@${DIR}/valheim-proxy.js;type=application/javascript+module" | head -c 400
echo
curl -sf -4 -X POST \
  "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/scripts/${NAME}/subdomain" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json" --data '{"enabled":true}' | head -c 200
echo
