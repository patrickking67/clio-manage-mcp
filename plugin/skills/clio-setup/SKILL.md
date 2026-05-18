---
name: clio-setup
description: Walk the user through one-time setup of the Clio Manage MCP server — Clio developer app, OAuth credentials, env vars, first authorization, and a smoke test. Use when the user has just installed the plugin, when /mcp shows clio-manage failing to connect, when the user asks "how do I set up the Clio MCP", "configure Clio", "connect Clio to Claude", "get started with Clio Manage MCP", or when CLIO_CLIENT_ID / CLIO_CLIENT_SECRET are not set.
argument-hint: "[--region us|ca|eu|au]"
allowed-tools: Read, Edit, Write, Bash, AskUserQuestion
---

# Setup the Clio Manage MCP

Take the user from zero to a working Clio MCP. Default to the **local stdio**
path; mention Azure only if they ask or if you detect Azure infra files.

## Pre-flight

Check whether each of these is already true before asking anything:

```bash
# Repo cloned and built?
test -f "$PWD/build/index.js" && echo built

# Credentials present?
grep -E "^CLIO_CLIENT_ID=" .env 2>/dev/null

# State dir exists?
test -d "${CLIO_STATE_DIR:-$HOME/.clio-mcp}"
```

If `build/index.js` is missing, run `npm install && npm run build` first.

## Walk the user through these steps

### 1. Create a Clio developer app

Send them to the region-specific developer portal:

| Region | Portal |
|---|---|
| US | https://developers.clio.com |
| CA | https://ca.developers.clio.com |
| EU | https://eu.developers.clio.com |
| AU | https://au.developers.clio.com |

Tell them:

- App type: **Web app**
- Redirect URI: `http://localhost:53682/oauth/callback` (must match
  `CLIO_REDIRECT_URI` exactly — Clio is strict)
- Scopes: leave default (full) unless they have firm policy
- Save the **client ID** and **client secret**

### 2. Fill in .env

If `.env` doesn't exist, copy from the example:

```bash
cp .env.example .env
```

Then prompt for and edit the values. Required:

```
CLIO_CLIENT_ID=...
CLIO_CLIENT_SECRET=...
CLIO_REDIRECT_URI=http://localhost:53682/oauth/callback
CLIO_REGION=us
```

Don't write the secret to chat. Use `Edit` to put it directly into `.env`.

### 3. Generate the token encryption key

```bash
openssl rand -base64 32
```

Put the output in `.env` as `CLIO_TOKEN_ENCRYPTION_KEY=...`. If they skip
this, the MCP auto-generates one — but if they're on more than one machine,
the auto-generated keys won't match and they'll have to re-authenticate per
machine.

### 4. Run the one-time OAuth flow

```bash
npm run start:stdio
```

In another terminal, run any MCP client (Claude Code itself, MCP inspector,
or the smoke test) and call `clio_authenticate`. The MCP opens a browser tab,
the user signs in to Clio, Clio redirects back to localhost:53682, the MCP
captures the code, exchanges it for tokens, and writes them encrypted to
`$CLIO_STATE_DIR/tokens.json`.

Verify:

```bash
ls -la "${CLIO_STATE_DIR:-$HOME/.clio-mcp}"
# Expect: tokens.json (mode 0o600), audit.log
```

### 5. Smoke test

```bash
npm run smoke:stdio
```

A passing run prints `OK` and the tool count (≥ 41).

### 6. Wire Claude Code at the plugin

The plugin's `.mcp.json` already points at `build/index.js`. If Claude Code
isn't picking it up:

```bash
claude /mcp
# Should show: clio-manage ✓ connected, 41 tools
```

If it's red, check `claude --debug` output for the failing command. Common
causes: build/ not present, env vars missing in the shell that launched Claude
Code, or stale tokens (delete `tokens.json` and re-authenticate).

## Azure path (only if asked)

If the user wants firm-wide hosted deployment, point them at
[`docs/deployment-azure.md`](../../../docs/deployment-azure.md). The
plugin's local stdio config is **not** what they want for Azure — they'll
need the HTTP transport with bearer auth, and Claude Code's `--mcp-config`
URL flag.

## After it works

Suggest a quick test prompt:

> "Who am I in Clio?"

That fires `clio_who_am_i`, confirms the OAuth token, and prints the user's
firm + email. If that returns the right user, setup is done.
