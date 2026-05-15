# Clio OAuth setup (one-time)

This is the trickiest part of the install. Once you have a refresh token, the
server handles access-token refreshes automatically.

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
- **Redirect URI** — exactly `http://127.0.0.1:5678/callback` (no trailing slash;
  no `localhost`)
- **Scopes** — check every scope you want available to the MCP. At minimum:
  `matters`, `contacts`, `activities`, `users`, `notes`, `tasks`, `bills`,
  `calendar`, `documents`. **Adding scopes later requires re-doing this whole
  dance**, so be generous up front.

Save. You'll see:

- **Client ID** — visible in the app list any time
- **Client Secret** — shown once on creation. **Copy it now.**

## 2. Authorise (local stdio)

If you're deploying locally, you don't need to do this step manually — the
`clio_authenticate` tool runs the whole flow for you. Just:

1. Put `CLIO_CLIENT_ID` and `CLIO_CLIENT_SECRET` in `.env` (or the client
   `env` block).
2. In your MCP client, call: *authenticate with Clio*.
3. Log in. Done.

## 3. Bootstrap for Azure / headless deployments

The cloud deployment can't run the auth-code flow itself — the OAuth redirect
has to land on a reachable URL on the user's machine. So we do it **once
locally** and copy the resulting refresh token into Key Vault.

The helper script `examples/bootstrap-refresh-token.mjs` does the same dance
as `clio_authenticate` but writes the refresh token to stdout instead of
encrypted disk. Then `az keyvault secret set --name clio-refresh-token`.

The deployed Container App reads it on startup, mints an access token, and
encrypts a token blob to its `/state` mount. Subsequent restarts re-use the
encrypted blob.

## Common pitfalls

- **Redirect URI mismatch** — `http://127.0.0.1:5678/callback` must match
  EXACTLY between (a) the Clio app config, (b) the URL the server opens, and
  (c) the token-exchange request. Trailing slashes, `localhost` vs
  `127.0.0.1`, port differences all cause `invalid_grant` errors.
- **Single-use auth code** — once `/oauth/token` accepts it, the code is dead.
  If you get `invalid_grant`, the code either expired (10-minute lifetime) or
  was already exchanged.
- **Region mismatch** — a code minted at `app.clio.com` cannot be exchanged
  against `eu.app.clio.com`. Pick a region and stick with it everywhere.
- **Refresh token rotation** — Clio sometimes returns a new refresh token in
  the refresh response and sometimes doesn't. The encrypted store handles
  both; you don't need to reason about it. (For Azure: if your bootstrap
  refresh token gets rotated and the server doesn't re-persist it because of
  a crash, you'll need to re-bootstrap.)
- **Scope change** — adding scopes invalidates existing tokens. Re-run the
  bootstrap.
