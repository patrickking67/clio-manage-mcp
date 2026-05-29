# Azure deployment (Container Apps + Key Vault + Azure Files)

Deploys the server as a **per-user remote OAuth connector** for Claude, running
as a stateless HTTPS service on Azure Container Apps with secrets in Key Vault
and persistent state on Azure Files. By default the infra deploys in
`MCP_AUTH_MODE=oauth`: the server is an OAuth 2.0 Authorization Server +
Protected Resource that bridges each Claude user to **their own** Clio account.

A shared-account `static` variant is documented at the end for single-tenant
setups.

## Architecture

```
                  Azure subscription
   ┌───────────────────────────────────────────────────────────┐
   │                                                            │
   │   ┌────────────┐  HTTPS    ┌──────────────┐   ┌─────────┐  │
   │   │  Claude    │──OAuth───►│  Container   │──►│  Clio   │  │
   │   │ (each user │  + /mcp   │  Apps        │   │  v4 API │  │
   │   │  signs in) │           │  (stateless) │   └─────────┘  │
   │   └────────────┘           └──────┬───────┘                │
   │       ▲ user sign-in (302 via Clio login)                  │
   │       └────────────────────────────┘                       │
   │                            │ secrets-from-Key-Vault         │
   │                            │ file-mount: /state             │
   │                  ┌─────────┴──────────┐                     │
   │                  │ Key Vault (RBAC)   │                     │
   │                  │ Azure Files share  │                     │
   │                  └────────────────────┘                     │
   └───────────────────────────────────────────────────────────┘
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
  - `MCP_AUTH_MODE=oauth` and an auto-derived `PUBLIC_BASE_URL`
  - **3 Key Vault secret references** in OAuth mode (client id, client secret,
    encryption key). The two static-mode secrets are wired **only** when
    `authMode != 'oauth'`.
  - `/state` volume mounted from the file share (`tokens.enc`, `sessions/`, audit)
  - Liveness + readiness probes on `/healthz`
  - HTTP-based autoscale (1 → 4 by default)

### `PUBLIC_BASE_URL` is set for you

In `oauth`/`hybrid` mode the OAuth issuer and the Clio redirect URI must be
fixed, absolute HTTPS URLs. The Bicep derives this from the Container Apps
environment's stable default domain:

```
PUBLIC_BASE_URL = https://<appName>.<environment defaultDomain>
```

which is exactly the app's ingress FQDN. You do **not** set it manually. It's
also surfaced as the `SERVICE_API_URI` output, and `${PUBLIC_BASE_URL}/mcp` as
`SERVICE_API_MCP_ENDPOINT`.

## Prerequisites

- Azure subscription with the `Microsoft.App` and `Microsoft.ContainerRegistry`
  providers registered (`az provider register --namespace Microsoft.App`).
- Azure CLI (`az`) and Azure Developer CLI (`azd`) installed.
- Docker — `azd` builds the image locally and pushes to ACR.
- A Clio Developer Application. You'll register its connector redirect URI in
  step 4, once `azd up` has produced the public URL.

## 1. Provision (OAuth mode by default)

```bash
az login
azd auth login
azd env new clio-mcp-prod
azd env set AZURE_LOCATION eastus2     # any Container Apps-supported region
azd env set CLIO_REGION us             # us | ca | eu | au
azd up
```

`azd up` builds the image, provisions infrastructure, and deploys with
`MCP_AUTH_MODE=oauth`. Expect ~6–8 minutes the first time.

The relevant outputs are:

- `AZURE_KEY_VAULT_NAME` — where you'll write the three secrets
- `SERVICE_API_URI` — the public HTTPS base URL (this is your `PUBLIC_BASE_URL`)
- `SERVICE_API_MCP_ENDPOINT` — the `${PUBLIC_BASE_URL}/mcp` connector URL

## 2. Populate Key Vault (3 secrets)

OAuth mode needs exactly three secrets. There is **no shared bearer token and no
bootstrap refresh token** — each user authorizes their own Clio account through
Claude.

```bash
KV_NAME=$(azd env get-values | grep AZURE_KEY_VAULT_NAME | cut -d= -f2 | tr -d '"')

# 1. Clio app credentials
az keyvault secret set --vault-name "$KV_NAME" --name clio-client-id     --value "<from Clio>"
az keyvault secret set --vault-name "$KV_NAME" --name clio-client-secret --value "<from Clio>"

# 2. Token encryption key (64 hex / 32 bytes) — encrypts every per-user session
az keyvault secret set --vault-name "$KV_NAME" --name clio-encryption-key \
  --value "$(openssl rand -hex 32)"
```

After the secrets exist, restart the revision so it picks them up:

```bash
az containerapp revision restart \
  -n "$(azd env get-values | grep SERVICE_API_NAME | cut -d= -f2 | tr -d '"')" \
  -g "$(azd env get-values | grep AZURE_RESOURCE_GROUP | cut -d= -f2 | tr -d '"')"
```

## 3. Verify

```bash
BASE=$(azd env get-values | grep SERVICE_API_URI | cut -d= -f2 | tr -d '"')
curl -sS "${BASE}/healthz"
# {"status":"ok","server":"clio-mcp","auth_mode":"oauth","region":"us"}

curl -sS "${BASE}/readyz"
# {"status":"ready"}        (in OAuth mode, readiness is independent of any account)
```

You can also confirm OAuth discovery is live:

```bash
curl -sS "${BASE}/.well-known/oauth-authorization-server" | head
```

## 4. Register the Clio redirect URI

On your Clio Developer Application (*Settings → Developer Applications*), add the
connector callback as a Redirect URI:

```bash
echo "Register this Redirect URI in Clio: ${BASE}/oauth/clio/callback"
```

(Clio allows multiple redirect URIs — keep `http://127.0.0.1:5678/callback` too
if you also use local stdio. See [docs/oauth-setup.md](oauth-setup.md).)

## 5. Add the connector in Claude → sign in to Clio

Give each attorney the connector URL (same for everyone):

```
${PUBLIC_BASE_URL}/mcp     # = the SERVICE_API_MCP_ENDPOINT output
```

In Claude: **Settings → Connectors → Add custom connector → paste the URL.**
Claude runs OAuth discovery and Dynamic Client Registration, redirects the user
to **Clio** to sign in and authorize, and returns connected. Each user is bound
to their own Clio account; sessions are encrypted and isolated.

## 6. Custom domain (optional)

```bash
# Add a domain
az containerapp hostname add -n <app> -g <rg> --hostname mcp.example.com

# Then issue a managed cert
az containerapp hostname bind -n <app> -g <rg> --hostname mcp.example.com \
  --environment <cae> --validation-method CNAME
```

If you front the app with a custom domain, the OAuth issuer must match the URL
users actually reach. Set `PUBLIC_BASE_URL` to the custom domain
(`https://mcp.example.com`) and re-register `${PUBLIC_BASE_URL}/oauth/clio/callback`
in Clio. (The Bicep derives `PUBLIC_BASE_URL` from the default ingress FQDN; to
pin it to a custom domain, set the env var on the Container App and restart.)

## Operating

**Logs** stream to Log Analytics — query with:

```kusto
ContainerAppConsoleLogs_CL
| where ContainerAppName_s startswith "ca-cliomcp"
| order by TimeGenerated desc
| take 200
```

**Audit log** is at `/state/audit.log` on the file share. State also includes
the encrypted `tokens.enc` (static mode) and the `sessions/` directory (OAuth
sessions). To pull the audit log down:

```bash
az storage file download-batch \
  --account-name "$(azd env get-values | grep AZURE_STORAGE_ACCOUNT_NAME | cut -d= -f2 | tr -d '"')" \
  --source clio-state \
  --destination ./audit-export
```

**Rotation** — the server never rotates the audit file. Run periodic exports +
truncation from a scheduled Azure Function or a cron sidecar.

**Multi-replica** — sessions, registered clients, and pending authorizations are
stored as encrypted records on the shared `/state` mount, so scaling out is safe
as long as every replica shares the same `clio-encryption-key`.

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
idle) to cut Container App cost ~80%. For an always-available connector, keep
`minReplicas=1`.

## Troubleshooting

**`/healthz` 200 but Claude can't connect** — check OAuth discovery is reachable
(`curl ${BASE}/.well-known/oauth-authorization-server`) and that the connector URL
you pasted ends in `/mcp`. The 401 on an unauthenticated `/mcp` is expected — it
carries the `WWW-Authenticate` challenge Claude follows to discover the OAuth
endpoints.

**Sign-in fails / "Authorization session expired"** — the Clio Developer
Application is missing the redirect URI, or it doesn't match exactly. Register
`${PUBLIC_BASE_URL}/oauth/clio/callback` (HTTPS, no trailing slash). The state
record is also single-use and short-lived; just retry the connect.

**Clio code exchange / `invalid_grant`** — usually a region mismatch (the Clio
app and `CLIO_REGION` must agree) or a redirect-URI mismatch. Confirm both.

**Container won't start after switching to static mode** — static mode references
two extra Key Vault secrets (`clio-http-auth-tokens`, `clio-refresh-token`). A
secret reference to a missing Key Vault secret fails the container. Create both
before deploying in `static`/`hybrid`.

**401 on `/mcp` in static mode** — the bearer token doesn't match any of the
comma-separated values in `clio-http-auth-tokens`. Rotate or add one.

**Cannot mount /state** — the storage account / file share is missing or the
managed identity lacks access. `azd provision` should re-converge it.

**Slow first request** — `minReplicas=0` + cold start. Raise to `1` if your firm
needs warm always-on latency.

---

## Optional: shared-account (static) deployment

For a single-tenant deployment where one shared Clio login is acceptable, run in
`static` mode. A shared bearer token gates `/mcp`, and one shared Clio account is
seeded from a refresh token.

```bash
azd env set MCP_AUTH_MODE static
azd up
```

In static mode the Bicep wires two **additional** Key Vault secrets, so create
all five before restarting:

```bash
# (the three from OAuth mode: clio-client-id, clio-client-secret, clio-encryption-key)

# 4. Shared bearer token(s) callers present on /mcp (comma-separated, one per caller)
TOKEN1=$(openssl rand -base64 32 | tr -d '=+/' | head -c 48)
az keyvault secret set --vault-name "$KV_NAME" --name clio-http-auth-tokens --value "$TOKEN1"
echo "Caller bearer token: $TOKEN1"

# 5. Shared Clio refresh token (one-time local bootstrap; see docs/oauth-setup.md)
node examples/bootstrap-refresh-token.mjs        # prints refresh_token=...
az keyvault secret set --vault-name "$KV_NAME" --name clio-refresh-token --value "<refresh_token>"
```

Restart the revision. The Container App reads `clio-refresh-token` (via
`CLIO_BOOTSTRAP_REFRESH_TOKEN`) on startup, mints an access token, and writes the
encrypted blob to `/state/tokens.enc`. In static mode `/readyz` returns 503 until
that shared account is authenticated.

Connect a client by pointing it at `${PUBLIC_BASE_URL}/mcp` with
`Authorization: Bearer <TOKEN1>`.

> Per-user OAuth used to be a future item; it is now the **default** mode (this
> document's main path). Static mode remains for the single-shared-account case.
