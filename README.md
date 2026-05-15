# Clio MCP

A Model Context Protocol server for **Clio Manage**, designed for firm-wide
deployment on **Azure Container Apps**, with a fully-featured local-stdio
path for development and individual use.

The same binary runs both transports. Secrets live in Azure Key Vault and are
mounted into the container at runtime via a user-assigned managed identity.
State (the encrypted OAuth token blob, the audit log) persists on Azure
Files. Egress is HTTPS-only with bearer-token auth.

- **41 tools** across 11 Clio domains, plus a generic escape hatch.
- **OAuth 2.0** with AES-256-GCM token-at-rest.
- **Audit log** designed around ABA Formal Opinion 512.
- **One-command deploy** — `azd up` provisions everything.
- **Verified end-to-end:** `npm run smoke:stdio` and `npm run smoke:http`
  drive the actual MCP protocol against the built binary.

---

## Architecture (Azure — primary)

```
                    Azure subscription
   ┌─────────────────────────────────────────────────────────┐
   │                                                          │
   │   ┌────────────┐  HTTPS  ┌──────────────┐   ┌─────────┐ │
   │   │  MCP host  │────────►│ Container    │──►│ Clio v4 │ │
   │   │ (Claude /  │  Bearer │ Apps         │   │  API    │ │
   │   │  agent fw) │  token  │ (stateless)  │   └─────────┘ │
   │   └────────────┘         └──────┬───────┘                │
   │                                 │                        │
   │                  ┌──────────────┼──────────────┐         │
   │                  │              │              │         │
   │             ┌────▼─────┐  ┌─────▼──────┐ ┌─────▼──────┐ │
   │             │ Key Vault│  │ Azure Files│ │ App Insights│ │
   │             │  (RBAC)  │  │  /state    │ │ + Log Anal.│ │
   │             └──────────┘  └────────────┘ └────────────┘ │
   │                  ▲                                       │
   │         ┌────────┴─────────┐                             │
   │         │ Managed identity │                             │
   │         │ (KV secrets user │                             │
   │         │  + ACR pull)     │                             │
   │         └──────────────────┘                             │
   └─────────────────────────────────────────────────────────┘
```

Resources provisioned by `infra/main.bicep`:

| Resource                           | Purpose                                                    |
|------------------------------------|------------------------------------------------------------|
| Log Analytics + Application Insights | Logs, metrics, traces                                    |
| Azure Container Registry (Basic)   | Private image registry, anonymous pull disabled            |
| User-assigned managed identity     | ACR pull + Key Vault Secrets User                          |
| Azure Key Vault (RBAC, soft-delete)| Stores Clio + bearer-token secrets                         |
| Azure Storage + File Share         | Persistent `/state` mount (tokens.enc + audit.log)         |
| Container Apps environment         | Hosts the workload, file share registered                  |
| Container App                      | HTTPS ingress, autoscaling 1→4 by default                  |

## Quick start — Azure

### Prerequisites

- Azure subscription with `Microsoft.App` and `Microsoft.ContainerRegistry`
  providers registered
- `az` CLI + `azd` CLI + Docker installed locally
- A **Clio Developer Application** with redirect URI
  `http://127.0.0.1:5678/callback` (one-time, used only to seed a refresh
  token from your laptop — never has to be cloud-reachable)
- ~15 minutes the first time

### 1. Provision

```bash
az login
azd auth login
azd env new clio-mcp-prod
azd env set AZURE_LOCATION eastus2
azd env set CLIO_REGION us           # us | ca | eu | au
azd up
```

`azd up` builds the image, provisions infrastructure, and deploys. Expect
~6–8 minutes the first time.

### 2. Populate Key Vault (5 secrets)

```bash
KV=$(azd env get-values | awk -F= '/AZURE_KEY_VAULT_NAME/{print $2}' | tr -d '"')

az keyvault secret set --vault-name "$KV" --name clio-client-id     --value "<from Clio>"
az keyvault secret set --vault-name "$KV" --name clio-client-secret --value "<from Clio>"
az keyvault secret set --vault-name "$KV" --name clio-encryption-key --value "$(openssl rand -hex 32)"
az keyvault secret set --vault-name "$KV" --name clio-http-auth-tokens \
  --value "$(openssl rand -base64 32 | tr -d '=+/' | head -c 48)"   # save the printed token!
# seed the refresh token from a one-time local OAuth dance:
node examples/bootstrap-refresh-token.mjs > /tmp/refresh
az keyvault secret set --vault-name "$KV" --name clio-refresh-token \
  --value "$(cat /tmp/refresh)"
shred -u /tmp/refresh 2>/dev/null || rm /tmp/refresh
```

### 3. Restart the revision so the secrets are picked up

```bash
APP=$(azd env get-values | awk -F= '/SERVICE_API_NAME/{print $2}' | tr -d '"')
RG=$(azd env get-values | awk -F= '/AZURE_RESOURCE_GROUP/{print $2}' | tr -d '"')
az containerapp revision restart -n "$APP" -g "$RG"
```

### 4. Verify

```bash
MCP_URL=$(azd env get-values | awk -F= '/SERVICE_API_MCP_ENDPOINT/{print $2}' | tr -d '"')
curl -sS "${MCP_URL%/mcp}/healthz"
# {"status":"ok","server":"clio-mcp","authenticated":true,"region":"us"}
```

You now have an MCP endpoint at `${MCP_URL}` authenticated via your bearer
token. Wire it into any MCP-aware client that supports Streamable HTTP.

Full guide: [docs/deployment-azure.md](docs/deployment-azure.md).

## Quick start — local (stdio, secondary)

For development, single-user use, or seeding the Azure refresh token. The
same binary, different transport.

```bash
git clone <this-repo> clio-mcp
cd clio-mcp
npm install
npm run build
cp .env.example .env
# Fill in CLIO_CLIENT_ID, CLIO_CLIENT_SECRET, CLIO_ENCRYPTION_KEY (openssl rand -hex 32)
```

Wire into Claude Desktop or Claude Code (see [examples/](examples/)) and run
`authenticate with Clio` in a conversation. Tokens are stored encrypted at
`~/.clio-mcp/tokens.enc`.

Full guide: [docs/deployment-local.md](docs/deployment-local.md).

## Tool catalog

| Domain          | Tools                                                                                   |
|-----------------|-----------------------------------------------------------------------------------------|
| Auth            | `clio_authenticate` · `clio_auth_status` · `clio_logout` · `clio_who_am_i`              |
| Matters         | `clio_list_matters` · `clio_get_matter` · `clio_create_matter` · `clio_update_matter` · `clio_delete_matter` · `clio_list_matter_contacts` |
| Contacts        | `clio_search_contacts` · `clio_get_contact` · `clio_create_person_contact` · `clio_create_company_contact` · `clio_update_contact` · `clio_delete_contact` |
| Activities      | `clio_list_activities` · `clio_get_activity` · `clio_create_time_entry` · `clio_create_expense_entry` |
| Tasks           | `clio_list_tasks` · `clio_get_task` · `clio_create_task` · `clio_update_task`           |
| Notes           | `clio_list_notes` · `clio_create_note`                                                  |
| Calendar        | `clio_list_calendar_entries` · `clio_create_calendar_entry` · `clio_list_calendars`     |
| Documents       | `clio_list_documents` · `clio_get_document` · `clio_get_document_download_url` · `clio_list_folders` |
| Bills           | `clio_list_bills` · `clio_get_bill` · `clio_get_billing_summary`                        |
| Users           | `clio_list_users` · `clio_get_user`                                                     |
| Practice areas  | `clio_list_practice_areas`                                                              |
| Workflows       | `clio_open_new_matter`                                                                  |
| Escape hatch    | `clio_api_request`                                                                      |

Destructive operations (`clio_delete_*`, `DELETE` via `clio_api_request`) are
disabled unless `CLIO_ALLOW_DESTRUCTIVE=true`.

## Resources

The server publishes two MCP resources that clients may auto-include:

| URI                          | What it carries                                                |
|------------------------------|----------------------------------------------------------------|
| `clio://compliance/notice`   | ABA Opinion 512 reminder + audit-logging summary               |
| `clio://auth/status`         | Live JSON view of authentication state and configuration       |

## Verification

The repo ships with two protocol-level smoke tests. They drive a real MCP
session against the built binary and assert on tool count, resource
publication, auth enforcement, and error shape.

```bash
npm run build
npm run smoke:stdio    # spawns build/index.js --stdio, drives JSON-RPC
npm run smoke:http     # spawns build/index.js --http,  drives the SDK Client
```

Both are green on every commit (see `.github/workflows/build.yml`).

## Compliance and security

- **OAuth 2.0** authorization-code flow with a cryptographically random
  `state` for CSRF. Clio password never touches this server.
- **AES-256-GCM token-at-rest.** Key lives in Key Vault on Azure (env var
  locally). The key never leaves the host.
- **Append-only JSONL audit log.** Every tool call recorded with timestamp,
  tool name, outcome, duration, user id, matter id, result count, and (in
  `full` mode) redacted arguments. Audit retention is the firm's
  responsibility — point a log-rotation job at the file.
- **Destructive operations gated** behind `CLIO_ALLOW_DESTRUCTIVE`.
- **HTTP transport requires bearer-token auth.** Tokens are compared with
  `timingSafeEqual` on SHA-256 digests to avoid timing side channels.
- **No telemetry.** This server makes no outbound calls except to Clio.

Threat model: [docs/security.md](docs/security.md).

## Configuration reference

| Variable                      | Required | Default          | Purpose                                                                |
|-------------------------------|----------|------------------|------------------------------------------------------------------------|
| `CLIO_CLIENT_ID`              | yes      | —                | From your Clio Developer Application                                   |
| `CLIO_CLIENT_SECRET`          | yes      | —                | From your Clio Developer Application                                   |
| `CLIO_ENCRYPTION_KEY`         | yes      | —                | 64-hex (32 bytes). `openssl rand -hex 32`                              |
| `CLIO_REGION`                 | no       | `us`             | `us` / `ca` / `eu` / `au`                                              |
| `CLIO_TRANSPORT`              | no       | `stdio`          | `stdio` or `http`. CLI flag `--stdio` / `--http` overrides              |
| `CLIO_HTTP_PORT`              | no       | `8765`           | HTTP transport port                                                    |
| `CLIO_HTTP_HOST`              | no       | `0.0.0.0`        | HTTP transport bind                                                    |
| `CLIO_HTTP_AUTH_TOKENS`       | no       | (open!)          | Comma-separated bearer tokens. **Required in production.**             |
| `CLIO_BOOTSTRAP_REFRESH_TOKEN`| no       | —                | One-shot refresh token used on first boot if no encrypted blob exists  |
| `CLIO_REDIRECT_PORT`          | no       | `5678`           | Loopback port for OAuth callback                                       |
| `CLIO_REDIRECT_HOST`          | no       | `127.0.0.1`      | Loopback host for OAuth callback                                       |
| `CLIO_STATE_DIR`              | no       | `~/.clio-mcp/`   | Where the encrypted token blob and audit log live                      |
| `CLIO_AUDIT_MODE`             | no       | `metadata`       | `none` / `metadata` / `full`                                           |
| `CLIO_ALLOW_DESTRUCTIVE`      | no       | `false`          | Enables DELETE endpoints                                                |
| `CLIO_DEFAULT_PAGE_SIZE`      | no       | `25`             | Records per Clio API page                                              |
| `CLIO_MAX_PAGE_SIZE`          | no       | `200`            | Hard cap on total records returned by a list tool                      |
| `CLIO_DEFAULT_USER_ID`        | no       | —                | Default attorney/user id for matter creation                           |
| `LOG_LEVEL`                   | no       | `info`           | `error` / `warn` / `info` / `debug`                                    |

## Confirmed Clio API quirks

These are baked into the client and tool descriptions so they don't surprise
you, and documented here so the next person doesn't have to re-derive:

- **`billing_method` at the matter root is silently ignored.** To set a flat
  fee, PATCH the matter with `custom_rate: { type: "FlatRate", rates: [...] }`.
  `clio_create_matter`'s `flat_rate_amount` parameter does this for you.
- **`TimeEntry.total = quantity_in_hours × rate`** (NOT `× price`). For
  flat-fee line items use `clio_create_expense_entry` (`total = quantity ×
  price`).
- **Activities GET requires explicit `fields`** — a bare GET returns only id
  + etag. `description` is write-only; on GET use `note`. `rate` is not a
  valid GET field.
- **Activities list filter is `matter_id` (singular int).** `matter` and
  `matter[id]` are silently ignored — you'll get account-wide results.
- **Mutating payloads must be wrapped `{ data: ... }`.** The dedicated tools
  do this for you. `clio_api_request` does it if you pass `data:`; pass
  `body:` to send something verbatim.
- **Address `name` is enum-validated** (`Work`, `Home`, `Billing`, `Other`).
  The tools coerce invalid names to `Work`.
- **DELETE on bills is soft-delete (void).** The bill moves to `void` state
  rather than disappearing.
- **Region cross-talk fails.** A token minted at `app.clio.com` will not
  authenticate against `eu.app.clio.com`. Pick one and stick with it.

## Development

```bash
npm install
npm run dev:stdio        # tsx watch, stdio mode
npm run dev:http         # tsx watch, http mode
npm run lint             # tsc --noEmit
npm run build            # tsc + chmod +x
npm run smoke:stdio      # protocol smoke test (stdio)
npm run smoke:http       # protocol smoke test (http)
npm run inspector        # MCP Inspector against the built binary
```

The MCP Inspector is the fastest way to iterate on tool schemas against a
real Clio account.

## Roadmap

- OS-keychain integration for the encryption key (macOS Keychain, Linux
  secret-service, Windows Credential Manager) so the key isn't on disk.
- Multi-tenant HTTP mode: one MCP endpoint, many firms, per-caller bearer
  token → per-firm OAuth state.
- Private Endpoint / Front Door integration in the Bicep template.
- DXT packaging for one-click Claude Desktop install.
- Webhook subscription tool for live matter / task / bill events.

## License

MIT — see [LICENSE](LICENSE).
