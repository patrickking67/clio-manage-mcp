# Clio Manage plugin for Claude Code

<p align="center">
  <img src="./.claude-plugin/icon.svg" width="96" height="96" alt="Clio mark" />
</p>

A Claude Code plugin that bundles skills, agents, and an MCP wiring for
[Clio Manage](https://www.clio.com/) — the legal practice management
system used by tens of thousands of law firms. After installation the
connector appears in `claude /mcp` as **Clio Manage** with the proper
Clio mark.

The plugin sits on top of the [Clio Manage MCP server](https://github.com/patrickking67/clio-manage-mcp)
in this same repo. The MCP gives Claude *capability* (41 tools across 12
Clio domains). The plugin gives Claude *judgment* — when to call which tool,
how to chain them into intake or billing workflows, and what guardrails apply
under [ABA Formal Opinion 512](https://www.americanbar.org/groups/professional_responsibility/publications/professional_lawyer/32/3/aba-formal-opinion-512-on-generative-artificial-intelligence/).

## What's in it

**Skills** (model-context knowledge + user-invocable commands)

| Skill | Type | Purpose |
|---|---|---|
| `clio-setup` | Command | Walk through OAuth setup, env vars, and first-run smoke test |
| `clio-search` | Skill | Pick the right list/search tool for a query and apply correct filters |
| `clio-best-practices` | Skill | ABA Op 512 + Clio API best practices (audit, rate limits, ETags) |
| `clio-matter-intake` | Command | Open a new matter end-to-end (contact + matter + note + task) |
| `clio-time-entry` | Skill | Log time correctly, including flat-fee, non-billable, and UTBMS coding |
| `clio-billing` | Skill | Invoice generation, AR aging, and trust accounting flows |
| `clio-document-automation` | Skill | Document templates, automation, archives, and download URLs |
| `clio-calendar` | Skill | Calendar entries, court rules, and conflict checking |
| `clio-contacts` | Skill | Person + company contacts, relationships, and dedupe |
| `clio-trust-accounting` | Skill | IOLTA/trust workflows + three-way reconciliation prep |

**Agents**

| Agent | Purpose |
|---|---|
| `clio-intake-agent` | Autonomous new-matter intake from a single prompt with confirmation gates |
| `clio-data-analyst` | Read-only Clio data analysis for partner reports and dashboards (tool allowlist enforces read-only) |

**MCP**

The plugin declares one **required** MCP server (`clio-manage`) that points at
the compiled MCP binary in this repo. **Optional** companion MCPs and
connectors are documented in [`docs/connectors.md`](../docs/connectors.md) —
Microsoft 365, Google Workspace, Stripe, DocuSign, etc. — none of them are
required for this plugin to function.

## Install

The plugin lives at the `plugin/` subpath of the [clio-manage-mcp repo](https://github.com/patrickking67/clio-manage-mcp).

### One-time prerequisites (for the bundled MCP)

```bash
# 1. Clone the repo and build the MCP binary
git clone https://github.com/patrickking67/clio-manage-mcp
cd clio-manage-mcp
npm install
npm run build

# 2. Create a Clio developer app and copy credentials into a .env (see ../docs/oauth-setup.md)
cp .env.example .env
$EDITOR .env

# 3. One-time OAuth dance
npm run start:stdio
# In another shell, run any client and trigger clio_authenticate
```

### Add the plugin to Claude Code

From the repo root:

```bash
# Install from the local marketplace
claude /plugin marketplace add ./plugin

# Or by file:// URL
claude /plugin marketplace add file://$(pwd)/plugin

# Then enable
claude /plugin install clio-manage@clio-manage
```

You can also point Claude Code at the GitHub repo directly:

```bash
claude /plugin marketplace add patrickking67/clio-manage-mcp
claude /plugin install clio-manage@clio-manage
```

> **Heads up:** the plugin's `.mcp.json` runs the compiled MCP binary at
> `${CLAUDE_PLUGIN_ROOT}/../build/index.js`. When you install from GitHub
> the whole repo is cloned into Claude Code's plugin cache, so the `build/`
> directory must be present. Either:
>
> 1. Use the **clone-and-build** flow above (recommended), then add the
>    plugin via the local `./plugin` path, or
> 2. Run `npm install && npm run build` inside the cached plugin's parent
>    directory after installing from GitHub.
>
> The plugin won't auto-build for you.

### Confirm it's wired up

```bash
claude --debug
> /mcp
# Should list clio-manage with ≥41 tools.
> /clio-setup
# Should print the setup walkthrough.
```

## Using the skills

Once enabled, the skills load automatically when Claude sees a relevant
prompt. You can also invoke them directly:

```text
/clio:setup
/clio:matter-intake "open a flat-fee landlord/tenant matter for Jane Smith"
/clio:billing "show AR aging for matters over 60 days"
```

The model-context skills (`clio-search`, `clio-best-practices`, etc.) don't
need an invocation — they're surfaced automatically when their trigger
phrases appear in conversation.

## Configuration

The plugin's `.mcp.json` reads the same environment variables the MCP server
itself uses. Set them in your shell, in `.env`, or via the Claude Code plugin
settings file (`.claude/clio-manage.local.md`). See [`../docs/oauth-setup.md`](../docs/oauth-setup.md)
for the full reference.

| Variable | Required | Purpose |
|---|---|---|
| `CLIO_CLIENT_ID` | yes | OAuth app client ID |
| `CLIO_CLIENT_SECRET` | yes | OAuth app client secret |
| `CLIO_REGION` | no (default `us`) | `us` / `ca` / `eu` / `au` |
| `CLIO_REDIRECT_URI` | yes | Must match the redirect URI on the Clio app |
| `CLIO_STATE_DIR` | no | Where encrypted tokens + audit log live |
| `CLIO_TOKEN_ENCRYPTION_KEY` | no (auto-generated) | 32-byte base64 key for AES-256-GCM |
| `CLIO_AUDIT_MODE` | no (default `metadata`) | `none` / `metadata` / `full` |

## Optional connectors

Skills in this plugin work better if Claude can *also* see your email,
calendar, and document storage. The plugin doesn't require them. Setup steps
for each are in [`../docs/connectors.md`](../docs/connectors.md):

- **Microsoft 365** — Outlook, Calendar, SharePoint, Word, Teams
- **Google Workspace** — Gmail, Calendar, Drive, Docs
- **DocuSign** — eSignature for engagement letters
- **Stripe** — payments + Clio Payments reconciliation
- **Slack** — internal firm comms
- **Sentry / observability** — monitor the MCP server in production

Skills that benefit from a connector mention it explicitly; if the connector
isn't installed they degrade gracefully and tell the user what they're
missing.

## License

MIT — see [LICENSE](../LICENSE).
