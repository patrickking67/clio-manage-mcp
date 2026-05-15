# Clio MCP

A Model Context Protocol server for **Clio Manage**. Connects Claude (or any
MCP-compatible client) to your Clio practice management instance with a clean,
audited, security-conscious surface that runs **locally over stdio** or **on
Azure Container Apps over HTTPS**.

Built for law firms and legal-tech teams that want:

- A single, current Clio v4 connector — matters, contacts, activities, tasks,
  notes, calendar, documents, bills, plus a generic escape hatch.
- A defensible compliance posture: AES-256-GCM token-at-rest, append-only
  JSONL audit log, ABA Formal Opinion 512-aware controls, destructive
  operations gated behind an explicit env flag.
- Two first-class deployment paths: local (stdio) and cloud (Azure Container
  Apps + Key Vault + Azure Files), with the same binary.

---

## Table of contents

- [What you get](#what-you-get)
- [Architecture at a glance](#architecture-at-a-glance)
- [Quick start — local (stdio)](#quick-start--local-stdio)
- [Quick start — Azure (HTTPS)](#quick-start--azure-https)
- [Tool catalog](#tool-catalog)
- [Resources](#resources)
- [Compliance and security](#compliance-and-security)
- [Configuration reference](#configuration-reference)
- [Confirmed Clio API quirks](#confirmed-clio-api-quirks)
- [Development](#development)
- [Roadmap](#roadmap)
- [License](#license)

---

## What you get

- **~30 tools** across 11 Clio domains, plus a `clio_api_request` escape hatch
  for everything not yet first-class — see [Tool catalog](#tool-catalog).
- **Two transports** in one binary: stdio (for Claude Desktop / Claude Code /
  MCP Inspector) and Streamable HTTP (stateless, perfect for Container Apps).
- **OAuth 2.0** authorization-code flow with state CSRF protection. Refresh
  handled transparently, encrypted at rest with AES-256-GCM. Multi-region (US,
  CA, EU, AU).
- **Audit log** at `~/.clio-mcp/audit.log` (or `/state/audit.log` in
  containers). One JSON object per tool call, with redaction of known secrets.
- **Azure-native deployment.** Bicep + `azd up` provisions Container Apps,
  ACR, Key Vault, Azure Files for persistent state, Log Analytics, and
  Application Insights. Secrets are pulled from Key Vault via managed identity.
- **Workflow tools** that compose multiple API calls — e.g. `clio_open_new_matter`
  bundles client creation, matter creation, the flat-fee dance, an opening
  note and an intake task into a single agent action.

## Architecture at a glance

```
┌───────────────────────────┐         ┌──────────────────────┐
│  Claude / Claude Desktop  │  stdio  │   clio-mcp (local)   │
│  Claude Code / Inspector  ├────────►│  src/transports/stdio│
└───────────────────────────┘         └──────┬───────────────┘
                                             │ OAuth + REST
                                             ▼
                                        Clio v4 API
                                  (us | ca | eu | au)
                                             ▲
                                             │
┌───────────────────────────┐  HTTPS  ┌──────┴───────────────┐
│  Claude / web / MCP host  ├────────►│  clio-mcp (Azure)    │
│      Bearer-token auth    │         │  Container Apps      │
└───────────────────────────┘         │  + Key Vault         │
                                      │  + Azure Files state │
                                      └──────────────────────┘
```

## Quick start — local (stdio)

### Prerequisites

- Node.js **20+**
- A Clio Developer Application (`Settings → Developer Applications → New`)
  with the redirect URI set to exactly `http://127.0.0.1:5678/callback`

### Install

```bash
git clone <this-repo> clio-mcp
cd clio-mcp
npm install
npm run build
```

### Configure

```bash
cp .env.example .env
# Generate the encryption key:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Paste it into CLIO_ENCRYPTION_KEY in .env, along with your Clio client id/secret.
```

### Wire into your MCP client

**Claude Desktop** — edit `~/Library/Application Support/Claude/claude_desktop_config.json`
(Mac) or `%APPDATA%/Claude/claude_desktop_config.json` (Windows):

```jsonc
{
  "mcpServers": {
    "clio": {
      "command": "node",
      "args": ["/absolute/path/to/clio-mcp/build/index.js", "--stdio"],
      "env": {
        "CLIO_CLIENT_ID": "...",
        "CLIO_CLIENT_SECRET": "...",
        "CLIO_REGION": "us",
        "CLIO_ENCRYPTION_KEY": "your-64-hex-key"
      }
    }
  }
}
```

**Claude Code CLI** — edit `~/.claude/settings.json`:

```jsonc
{
  "mcpServers": {
    "clio": {
      "command": "node",
      "args": ["/absolute/path/to/clio-mcp/build/index.js", "--stdio"]
    }
  }
}
```

Restart your client, then in any conversation try:

> *authenticate with Clio*

You'll see a browser window. Log in normally. Once it says "Authentication
successful", you're connected. Verify with:

> *what's my Clio user id?*

Full walkthrough: [docs/deployment-local.md](docs/deployment-local.md).

## Quick start — Azure (HTTPS)

Provisions Container Apps + ACR + Key Vault + Azure Files via Bicep, then
deploys the image. All secrets live in Key Vault and are mounted into the
container via managed identity.

```bash
# Prereqs: az, azd, docker
az login
azd auth login
azd env new clio-mcp-prod
azd env set CLIO_REGION us
azd up
```

After provisioning, populate Key Vault with the four secrets (see
[docs/deployment-azure.md](docs/deployment-azure.md) for the exact commands):

| Key Vault secret name   | Value                                                                     |
|-------------------------|---------------------------------------------------------------------------|
| `clio-client-id`        | From your Clio Developer Application                                      |
| `clio-client-secret`    | From your Clio Developer Application                                      |
| `clio-encryption-key`   | 64-hex random — `openssl rand -hex 32`                                    |
| `clio-http-auth-tokens` | Comma-separated bearer tokens that callers must present on `/mcp` requests |

Then seed a refresh token from a one-time local OAuth dance (the server can't
do the auth-code flow itself when it lives behind HTTPS — see the deployment
guide for the bootstrap script).

The resulting MCP endpoint is:

```
https://<your-container-app>.azurecontainerapps.io/mcp
```

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

## Compliance and security

- **OAuth 2.0 auth-code flow** with a cryptographically random `state` for CSRF.
  The Clio password never touches this server.
- **AES-256-GCM token-at-rest.** Encryption key is a 32-byte secret (env var
  locally, Key Vault on Azure). The key never leaves the host. Tampered
  ciphertext fails decryption rather than silently producing garbage.
- **Append-only JSONL audit log.** Every tool call is recorded with timestamp,
  tool name, outcome, duration, Clio user id, matter id (when applicable),
  result count, and (in `full` mode) redacted arguments. Retention is the
  firm's responsibility — point `logrotate` or Azure Container Apps log
  streaming at the file.
- **Destructive operations gated** behind `CLIO_ALLOW_DESTRUCTIVE=true`.
  Off by default.
- **HTTP transport requires bearer-token auth.** Tokens are compared with
  `timingSafeEqual` on SHA-256 digests to avoid timing side channels. On Azure
  these tokens live in Key Vault.
- **No telemetry.** This server makes no outbound calls except to Clio.

Threat model + deeper notes: [docs/security.md](docs/security.md).

## Configuration reference

| Variable                  | Required | Default          | Purpose                                                                |
|---------------------------|----------|------------------|------------------------------------------------------------------------|
| `CLIO_CLIENT_ID`          | yes      | —                | From your Clio Developer Application                                   |
| `CLIO_CLIENT_SECRET`      | yes      | —                | From your Clio Developer Application                                   |
| `CLIO_ENCRYPTION_KEY`     | yes      | —                | 64-hex (32 bytes). `openssl rand -hex 32` or the `node -e` snippet above |
| `CLIO_REGION`             | no       | `us`             | `us` / `ca` / `eu` / `au`                                              |
| `CLIO_TRANSPORT`          | no       | `stdio`          | `stdio` or `http`. CLI flag `--stdio` / `--http` overrides              |
| `CLIO_HTTP_PORT`          | no       | `8765`           | HTTP transport port                                                    |
| `CLIO_HTTP_HOST`          | no       | `0.0.0.0`        | HTTP transport bind                                                    |
| `CLIO_HTTP_AUTH_TOKENS`   | no       | (open!)          | Comma-separated bearer tokens. **Required in production.**             |
| `CLIO_REDIRECT_PORT`      | no       | `5678`           | Loopback port for OAuth callback                                       |
| `CLIO_REDIRECT_HOST`      | no       | `127.0.0.1`      | Loopback host for OAuth callback                                       |
| `CLIO_STATE_DIR`          | no       | `~/.clio-mcp/`   | Where the encrypted token blob and audit log live                      |
| `CLIO_AUDIT_MODE`         | no       | `metadata`       | `none` / `metadata` / `full`                                           |
| `CLIO_ALLOW_DESTRUCTIVE`  | no       | `false`          | Enables DELETE endpoints                                                |
| `CLIO_DEFAULT_PAGE_SIZE`  | no       | `25`             | Records per Clio API page                                              |
| `CLIO_MAX_PAGE_SIZE`      | no       | `200`            | Hard cap on total records returned by a list tool                      |
| `CLIO_DEFAULT_USER_ID`    | no       | —                | Default attorney/user id for matter creation                           |
| `LOG_LEVEL`               | no       | `info`           | `error` / `warn` / `info` / `debug`                                    |

## Confirmed Clio API quirks

We've baked these into the client and tool descriptions — they don't surprise
you, but they're documented so the next person doesn't have to re-derive:

- **`billing_method` at the matter root is silently ignored.** To set a flat
  fee, PATCH the matter with `custom_rate: { type: "FlatRate", rates: [...] }`.
  Then GET returns `billing_method: "flat"` and Clio auto-creates the billable
  TimeEntry. `clio_create_matter`'s `flat_rate_amount` parameter does this for
  you.
- **`TimeEntry.total = quantity_in_hours × rate`** (NOT `× price`). For flat-
  fee line items use `clio_create_expense_entry` instead — `total = quantity ×
  price`.
- **Activities GET requires explicit `fields`** — a bare GET returns only id +
  etag. `description` is write-only; on GET use `note`. `rate` is not a valid
  GET field.
- **Activities list filter is `matter_id` (singular int).** `matter` and
  `matter[id]` are silently ignored — you'll get account-wide results.
- **Mutating payloads must be wrapped `{ data: ... }`.** The dedicated tools
  do this for you. `clio_api_request` does it if you pass `data:`; pass `body:`
  to send something verbatim.
- **Address `name` is enum-validated** (`Work`, `Home`, `Billing`, `Other`).
  The tools coerce invalid names to `Work`.
- **DELETE on bills is soft-delete (void).** The bill moves to `void` state
  rather than disappearing.
- **Region cross-talk fails.** A token minted at `app.clio.com` will not
  authenticate against `eu.app.clio.com`. Pick one and stick with it
  (`CLIO_REGION`).

## Development

```bash
npm install
npm run dev:stdio        # tsx watch, stdio mode
npm run dev:http         # tsx watch, http mode
npm run lint             # tsc --noEmit
npm run build            # tsc + chmod +x
npm run inspector        # MCP Inspector against the built binary
```

The MCP Inspector is the fastest way to iterate on tool schemas and try them
against a real Clio account.

## Roadmap

Planned, in no particular order:

- OS-keychain integration for the encryption key (macOS Keychain, Linux
  secret-service, Windows Credential Manager) so the key isn't on disk.
- Multi-tenant HTTP mode (one MCP endpoint, many firms, per-caller token →
  per-firm OAuth state).
- DXT packaging for one-click Claude Desktop install.
- Webhook subscription tool for live matter / task / bill events.
- A `clio_search_everywhere` tool over the global search endpoint.
- Pulled-from-spec scopes — the OAuth dance currently asks for the broad
  set; we'll narrow this once we've mapped per-tool scope requirements.

## License

MIT — see [LICENSE](LICENSE).
