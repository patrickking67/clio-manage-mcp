# Clio OAuth setup

This server connects to Clio with OAuth. How a *user* authorizes depends on the
mode you run in:

- **OAuth remote connector (primary).** Each Claude user signs in to **their
  own** Clio account through Claude's custom-connector flow. There is **no
  manual refresh-token bootstrap** — the server bridges each user's sign-in
  itself. This is the default on Azure.
- **Static / shared account (alternative).** A single shared Clio account is
  seeded once from a refresh token, and a shared bearer token gates `/mcp`. Use
  this only for single-tenant / solo setups.
- **Local stdio.** The `clio_authenticate` tool runs a loopback OAuth flow on
  your machine. Used for development and solo installs.

Whichever you use, you start by creating one Clio Developer Application.

## 1. Create the Clio Developer Application

Sign in to Clio (your region's host) and go to **Settings → Developer
Applications → New Application**.

Region URLs:

| Region | Developer Applications page                                           |
|--------|-----------------------------------------------------------------------|
| US     | https://app.clio.com/settings/developer_applications                  |
| CA     | https://ca.app.clio.com/settings/developer_applications               |
| EU/UK  | https://eu.app.clio.com/settings/developer_applications               |
| AU     | https://au.app.clio.com/settings/developer_applications               |

Fill in:

- **Name** — anything (e.g. "Clio MCP")
- **Redirect URIs** — Clio allows several per application. Register **both** of
  these so one app serves both the remote connector and local stdio:

  | Redirect URI | Used by |
  |---|---|
  | `${PUBLIC_BASE_URL}/oauth/clio/callback` | **Remote OAuth connector (primary).** e.g. `https://clio-mcp.example.com/oauth/clio/callback`. `PUBLIC_BASE_URL` is the public HTTPS URL of the deployed server; on Azure it's auto-set by the Bicep and equals your Container App's URL. |
  | `http://127.0.0.1:5678/callback` | **Local stdio.** The loopback flow (`clio_authenticate`) and the static-mode bootstrap script. (`127.0.0.1`, not `localhost`; port from `CLIO_REDIRECT_PORT`.) |

- **Scopes** — check every scope you want available to the MCP. At minimum:
  `matters`, `contacts`, `activities`, `users`, `notes`, `tasks`, `bills`,
  `calendar`, `documents`. **Adding scopes later requires re-authorizing**, so
  be generous up front.

Save. You'll see:

- **Client ID** — visible in the app list any time
- **Client Secret** — shown once on creation. **Copy it now.**

> The connector redirect (`${PUBLIC_BASE_URL}/oauth/clio/callback`) only needs to
> be known once you've deployed and have a public URL. After `azd up`, the Azure
> deployment prints it — see [docs/deployment-azure.md](deployment-azure.md).

## 2. OAuth remote connector (primary) — no bootstrap

In `oauth` (or `hybrid`) mode there is **nothing to seed**. Each user authorizes
themselves through Claude:

1. Deploy the server with `MCP_AUTH_MODE=oauth` and a valid `PUBLIC_BASE_URL`
   (on Azure both are handled by the Bicep — the URL is auto-derived).
2. Register `${PUBLIC_BASE_URL}/oauth/clio/callback` on the Clio app (step 1).
3. The user adds the connector in Claude (**Settings → Connectors → Add custom
   connector → `${PUBLIC_BASE_URL}/mcp`**). Claude performs OAuth discovery and
   Dynamic Client Registration, then starts a PKCE authorization-code flow.
4. The user is redirected to Clio to sign in and authorize. Clio returns to
   `${PUBLIC_BASE_URL}/oauth/clio/callback`; the server exchanges the Clio code,
   bridges the tokens into an encrypted per-user session, and hands Claude an MCP
   session token. The user is connected.

The only secrets the server needs in this mode are `CLIO_CLIENT_ID`,
`CLIO_CLIENT_SECRET`, and `CLIO_ENCRYPTION_KEY`.

## 3. Local stdio authorization

For a local install you don't do anything manual — the `clio_authenticate` tool
runs the whole loopback flow:

1. Put `CLIO_CLIENT_ID` and `CLIO_CLIENT_SECRET` in `.env` (or the client
   `env` block).
2. In your MCP client, call: *authenticate with Clio*.
3. Log in. Done.

This uses the `http://127.0.0.1:5678/callback` redirect URI. See
[docs/deployment-local.md](deployment-local.md).

## 4. Static / shared-account bootstrap (alternative)

> Only for `static` (or `hybrid`) mode, where one shared Clio account backs the
> deployment. In pure `oauth` mode this step does not apply — skip it.

A headless deployment in static mode can't run the loopback auth-code flow
itself, so you mint a refresh token **once locally** and copy it into Key Vault.

The helper script `examples/bootstrap-refresh-token.mjs` does the same dance as
`clio_authenticate` but writes the refresh token to stdout instead of encrypted
disk. It uses the `http://127.0.0.1:5678/callback` redirect URI:

```bash
# from your laptop, with .env populated (CLIO_CLIENT_ID/SECRET/REGION):
node examples/bootstrap-refresh-token.mjs
# Prints: refresh_token=...
```

Then store it (plus a shared bearer token) in Key Vault:

```bash
az keyvault secret set --vault-name "$KV" --name clio-refresh-token    --value "<refresh_token>"
az keyvault secret set --vault-name "$KV" --name clio-http-auth-tokens --value "<a bearer token>"
```

The deployed Container App reads `clio-refresh-token` (via
`CLIO_BOOTSTRAP_REFRESH_TOKEN`) on startup, mints an access token, and encrypts a
token blob to `/state/tokens.enc`. Subsequent restarts reuse the encrypted blob.
Full static-mode walk-through: [docs/deployment-azure.md](deployment-azure.md).

## Common pitfalls

- **Redirect URI mismatch** — the redirect URI must match EXACTLY between (a) the
  Clio app config, (b) the URL the server sends to Clio, and (c) the token
  exchange. For the connector that's `${PUBLIC_BASE_URL}/oauth/clio/callback`
  (HTTPS, no trailing slash); for local stdio it's
  `http://127.0.0.1:5678/callback` (`127.0.0.1`, not `localhost`; matching port).
  Mismatches cause `invalid_grant`.
- **Single-use auth code** — once a code is exchanged it's dead. `invalid_grant`
  means the code expired (10-minute lifetime) or was already used.
- **Region mismatch** — a code minted at `app.clio.com` cannot be exchanged
  against `eu.app.clio.com`. Pick a region and set `CLIO_REGION` consistently.
- **Refresh token rotation** — Clio sometimes returns a new refresh token on
  refresh and sometimes doesn't. The encrypted store handles both. (Static mode
  only: if your bootstrap refresh token is rotated and the server can't
  re-persist it because of a crash, re-run the bootstrap.)
- **Scope change** — adding scopes invalidates existing authorizations. In OAuth
  mode, users simply reconnect; in static mode, re-run the bootstrap.
