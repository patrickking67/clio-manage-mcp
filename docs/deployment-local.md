# Local deployment (stdio)

This is the path most people take first: install Node, build the project, wire
it into Claude Desktop or Claude Code, and you're done.

## 1. Prerequisites

- Node.js 20+ (`node --version`)
- A Clio Developer Application — see [docs/oauth-setup.md](oauth-setup.md)
- ~10 minutes

## 2. Install

```bash
git clone <this-repo> clio-mcp
cd clio-mcp
npm install
npm run build
pwd   # note this path for step 4
```

## 3. Generate the encryption key

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

You'll get a 64-character hex string. Save it somewhere safe (password
manager). If you ever lose it, no data is destroyed — you just have to
re-run the OAuth dance.

## 4. Wire it into your MCP client

### Claude Desktop

Edit:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%/Claude/claude_desktop_config.json`

Add (replace `<…>` placeholders):

```jsonc
{
  "mcpServers": {
    "clio": {
      "command": "node",
      "args": ["<absolute-path-to>/clio-mcp/build/index.js", "--stdio"],
      "env": {
        "CLIO_CLIENT_ID": "<from Clio>",
        "CLIO_CLIENT_SECRET": "<from Clio>",
        "CLIO_REGION": "us",
        "CLIO_ENCRYPTION_KEY": "<your 64-hex string>",
        "CLIO_AUDIT_MODE": "metadata"
      }
    }
  }
}
```

Fully quit Claude Desktop (Cmd-Q, not just close the window) and reopen.

### Claude Code CLI

Edit `~/.claude/settings.json`:

```jsonc
{
  "mcpServers": {
    "clio": {
      "command": "node",
      "args": ["<absolute-path-to>/clio-mcp/build/index.js", "--stdio"],
      "env": {
        "CLIO_CLIENT_ID": "<from Clio>",
        "CLIO_CLIENT_SECRET": "<from Clio>",
        "CLIO_REGION": "us",
        "CLIO_ENCRYPTION_KEY": "<your 64-hex string>"
      }
    }
  }
}
```

Restart the Claude Code session.

### MCP Inspector

Fastest way to develop and test:

```bash
npm run inspector
```

## 5. Authenticate

In a new conversation:

> *authenticate with Clio*

Browser opens to Clio's login page → log in → page says "Authentication
successful" → return to your client. From then on the encrypted token blob
lives at `~/.clio-mcp/tokens.enc` and the server auto-refreshes it ahead of
expiry.

Verify with:

> *what's my Clio user id?*

(Calls `clio_who_am_i`.)

## 6. Region

If your firm is on Clio EU, CA, or AU, set `CLIO_REGION` to `eu` / `ca` / `au`.
The server picks the right endpoints automatically — tokens from one region
will not authenticate against another.

## Troubleshooting

**"clio_authenticate is only usable from a local stdio session"** — you're in
HTTP transport mode. Either switch (`--stdio`) or use the Azure bootstrap
script to seed a refresh token (see [docs/deployment-azure.md](deployment-azure.md)).

**"OAuth callback timed out"** — the loopback server didn't see the browser
redirect within 5 minutes. Re-run; make sure the Redirect URI in your Clio
Developer Application matches exactly `http://127.0.0.1:5678/callback` (no
trailing slash, port matches `CLIO_REDIRECT_PORT`).

**"failed to decrypt token file"** — the encryption key has changed since
the token blob was written. Either restore the original key, or run
`clio_logout` and re-authenticate.

**"ENCRYPTION_KEY must be 64 hex chars"** — regenerate with the Node snippet
above. The output is exactly 64 characters.
