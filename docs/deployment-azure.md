# Azure deployment (Container Apps + Key Vault + Azure Files)

Deploys the same binary as the local install, but as a stateless HTTP service
on Azure Container Apps with secrets in Key Vault and persistent state on
Azure Files. The resulting `/mcp` endpoint is HTTPS-only, bearer-token
authenticated, and horizontally scalable.

## Architecture

```
                  Azure subscription
   ┌─────────────────────────────────────────────────────────┐
   │                                                          │
   │   ┌────────────┐    ┌──────────────┐    ┌─────────────┐ │
   │   │   Caller   │───►│  Container   │───►│  Clio v4    │ │
   │   │ (Claude /  │ T  │  Apps        │    │  API        │ │
   │   │  MCP host) │ L  │  (stateless) │    └─────────────┘ │
   │   └────────────┘ S  └──────┬───────┘                    │
   │     bearer       :         │                            │
   │                            │ token-from-Key-Vault       │
   │                            │ file-mount: /state         │
   │                  ┌─────────┴──────────┐                 │
   │                  │ Key Vault (RBAC)   │                 │
   │                  │ Azure Files share  │                 │
   │                  └────────────────────┘                 │
   └─────────────────────────────────────────────────────────┘
```

Resources provisioned by `infra/main.bicep`:

- Log Analytics workspace + Application Insights
- Container Apps environment (with the Azure File share registered)
- Azure Container Registry (Basic)
- User-assigned managed identity (ACR pull + Key Vault Secrets User)
- Azure Key Vault (RBAC mode, soft delete + purge protection on)
- Azure Storage Account + File Share (`clio-state`)
- Container App with:
  - HTTPS ingress, target port 8765
  - 4 Key Vault secret references (client id/secret, encryption key, HTTP auth tokens)
  - `/state` volume mounted from the file share
  - Liveness + readiness probes on `/healthz`
  - HTTP-based autoscale (1 → 4 by default)

## Prerequisites

- Azure subscription with the `Microsoft.App` and `Microsoft.ContainerRegistry`
  providers registered (`az provider register --namespace Microsoft.App`).
- Azure CLI (`az`) and Azure Developer CLI (`azd`) installed.
- Docker — `azd` builds the image locally and pushes to ACR.
- A Clio Developer Application configured to accept the **temporary** local
  redirect URI `http://127.0.0.1:5678/callback` (you'll use this once to seed
  a refresh token; it never has to be reachable from the cloud).

## 1. Provision

```bash
az login
azd auth login
azd env new clio-mcp-prod
azd env set AZURE_LOCATION eastus2     # any Container Apps-supported region
azd env set CLIO_REGION us             # us | ca | eu | au
azd up
```

`azd up` builds the image, provisions infrastructure, and deploys. Expect
~6–8 minutes the first time.

The relevant outputs are:

- `AZURE_KEY_VAULT_NAME` — where you'll write the four secrets
- `SERVICE_API_URI` — the public HTTPS base URL
- `SERVICE_API_MCP_ENDPOINT` — the `/mcp` URL your client connects to

## 2. Populate Key Vault

The Container App will not be operational until these four secrets exist.

```bash
KV_NAME=$(azd env get-values | grep AZURE_KEY_VAULT_NAME | cut -d= -f2 | tr -d '"')

# 1. Clio app credentials
az keyvault secret set --vault-name "$KV_NAME" --name clio-client-id     --value "<from Clio>"
az keyvault secret set --vault-name "$KV_NAME" --name clio-client-secret --value "<from Clio>"

# 2. Token encryption key (64 hex / 32 bytes)
az keyvault secret set --vault-name "$KV_NAME" --name clio-encryption-key \
  --value "$(openssl rand -hex 32)"

# 3. HTTP bearer tokens that callers must present on /mcp
#    Generate one per caller / per environment.
TOKEN1=$(openssl rand -base64 32 | tr -d '=+/' | head -c 48)
az keyvault secret set --vault-name "$KV_NAME" --name clio-http-auth-tokens \
  --value "$TOKEN1"
echo "Caller bearer token: $TOKEN1"
```

Save the bearer token — it's the credential your MCP client will present.

## 3. Seed the Clio refresh token

The Container App can't run the OAuth code flow itself (the redirect URI has
to be a real reachable endpoint on the user's machine, not the cloud). So we
do the dance **once locally** and copy the resulting refresh token into Key
Vault as the bootstrap.

There's a helper script at `examples/bootstrap-refresh-token.mjs`:

```bash
# from your laptop, with .env populated:
node examples/bootstrap-refresh-token.mjs
# Prints: refresh_token=...
```

Drop it into Key Vault — the deployed server uses it to mint access tokens
on demand:

```bash
az keyvault secret set --vault-name "$KV_NAME" --name clio-refresh-token \
  --value "<the refresh_token from the bootstrap script>"
```

The Container App reads `clio-refresh-token` (via the env var
`CLIO_BOOTSTRAP_REFRESH_TOKEN`) on startup, mints an initial access token, and
writes the encrypted token blob to `/state/tokens.enc`. Subsequent restarts
reuse the encrypted blob.

> **Note** — at the time of writing, the production-grade pattern is to copy
> the bootstrap refresh token in this way. A future revision will move to
> per-caller OAuth (one MCP endpoint, many tenants) — see Roadmap.

After all secrets exist, restart the Container App revision so it picks them
up:

```bash
az containerapp revision restart -n "$(azd env get-values | grep SERVICE_API_NAME | cut -d= -f2 | tr -d '"')" -g "$(azd env get-values | grep AZURE_RESOURCE_GROUP | cut -d= -f2 | tr -d '"')"
```

## 4. Connect Claude

For HTTP MCP servers, your client needs to know the endpoint URL and the
bearer token. The configuration shape varies by client; for an MCP host that
supports HTTP transports:

```
URL:    https://<your-container-app>.azurecontainerapps.io/mcp
Header: Authorization: Bearer <TOKEN1 from step 2>
```

Test with curl:

```bash
curl -sS https://<host>/healthz
# {"status":"ok","server":"clio-mcp","authenticated":true,"region":"us"}
```

## 5. Custom domain (optional)

```bash
# Add a domain
az containerapp hostname add -n <app> -g <rg> --hostname mcp.example.com

# Then issue a managed cert
az containerapp hostname bind -n <app> -g <rg> --hostname mcp.example.com \
  --environment <cae> --validation-method CNAME
```

## Operating

**Logs** stream to Log Analytics — query with:

```kusto
ContainerAppConsoleLogs_CL
| where ContainerAppName_s startswith "ca-cliomcp"
| order by TimeGenerated desc
| take 200
```

**Audit log** is at `/state/audit.log` on the file share. To pull it down:

```bash
az storage file download-batch \
  --account-name "$(azd env get-values | grep AZURE_STORAGE_ACCOUNT_NAME | cut -d= -f2 | tr -d '"')" \
  --source clio-state \
  --destination ./audit-export
```

**Rotation** — the server never rotates the file. Run periodic exports +
truncation from a scheduled Azure Function or a cron sidecar.

## Cost

For a moderate-volume firm (a few thousand tool calls/day) running 1 warm
replica:

| Component                  | Approx. monthly |
|----------------------------|-----------------|
| Container App (0.5 vCPU)   | ~$15            |
| Container Apps environment | included        |
| ACR Basic                  | ~$5             |
| Key Vault                  | <$1             |
| Azure Files (10 GiB)       | ~$1             |
| Log Analytics (light)      | ~$2–5           |
| **Total**                  | **~$25–30/mo**  |

Set `minReplicas=0` for scale-to-zero (cold starts ~3-5s on first call after
idle) to cut Container App cost ~80%.

## Troubleshooting

**App stuck "not_authenticated"** — `clio-refresh-token` is missing or wrong
in Key Vault. Re-run the bootstrap script and update the secret.

**401 on `/mcp`** — bearer token doesn't match any of the comma-separated
values in `clio-http-auth-tokens`. Rotate or add one.

**Cannot mount /state** — the storage account / file share is missing or the
managed identity lacks access. `azd provision` should re-converge it.

**Slow first request** — `minReplicas=0` + cold start. Raise to `1` if your
firm needs warm always-on latency.
