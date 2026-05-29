# Optional connectors

The Clio Manage MCP and plugin work standalone. But Claude does better legal
work when it can also see your email, calendar, document storage, and
payments. This doc walks through the **optional** companion connectors and
MCPs we recommend. None of them are required for the Clio plugin to function;
each skill that benefits from one says so explicitly and degrades gracefully
if the connector is absent.

> **Note** — Clio Manage itself is now consumed as a **remote OAuth custom
> connector** in Claude: each user adds `${PUBLIC_BASE_URL}/mcp` under
> **Settings → Connectors** and signs in to their own Clio account. See the
> main [README](../README.md) and [docs/deployment-azure.md](deployment-azure.md).
> The connectors below are *additional* companions, not replacements for it.

## Tiers

| Tier | What it adds | Examples |
|---|---|---|
| **Required** | Clio Manage data + tools | `clio-manage` (this repo) |
| **Strongly recommended** | Email, calendar, document storage | Microsoft 365, Google Workspace |
| **Useful** | Payments, e-signature, comms | Stripe, DocuSign, Slack |
| **Operational** | Monitoring the MCP itself | Sentry, Application Insights |

---

## Microsoft 365

Best for firms already on Outlook + SharePoint + Teams.

**What it unlocks for Clio workflows**

- Read & search Outlook email when drafting matter notes from
  correspondence
- Pull calendar conflicts before creating a Clio calendar entry
- Save Clio document downloads to SharePoint, or pull Word templates from
  there for `clio-document-automation`
- Search SharePoint for engagement letters, retainer templates

**Setup**

Use the Microsoft 365 connector from the official Claude Code marketplace:

```bash
claude /plugin marketplace add anthropic-marketplace/microsoft365
claude /plugin install ms365
```

Or install via the [Microsoft Graph MCP server](https://github.com/microsoft/mcp). Configure with your tenant's app registration — see [Microsoft Learn](https://learn.microsoft.com/en-us/graph/auth-v2-user).

**Plays well with skills:** `clio-calendar`, `clio-document-automation`,
`clio-contacts` (intake from email).

---

## Google Workspace

Best for firms on Gmail + Calendar + Drive + Docs.

**What it unlocks**

- Same as M365 — email, calendar, document storage, just on Google's stack
- Pull engagement-letter Docs templates; render with Clio matter merge
  fields; save back to Drive
- Reconcile Calendar events with Clio calendar entries

**Setup**

Use the official Google Workspace connectors in Claude Desktop or Claude
Code. The plugin marketplace has them under `small-business`:

```bash
claude /plugin marketplace add anthropic-marketplace/small-business
claude /plugin install gmail
claude /plugin install google-drive
claude /plugin install google-calendar
```

Each requires an OAuth grant. Tokens live in Claude Code's credential
store, not on disk in plaintext.

**Plays well with skills:** `clio-calendar`, `clio-document-automation`,
`clio-contacts`.

---

## DocuSign

For e-signature on engagement letters, retainers, settlement releases.

**Setup**

Use the DocuSign MCP from the small-business marketplace:

```bash
claude /plugin install docusign
```

Configure with a DocuSign developer account and the matching OAuth app.

**Workflow this enables:** the `clio-matter-intake` agent finishes by
asking "should I draft and send the engagement letter via DocuSign?" If
DocuSign is installed, it can do it. If not, it tells the user where to
pick up.

---

## Stripe

For firms using Stripe for fee deposits or Clio Payments reconciliation.

**Setup**

```bash
claude /plugin install stripe
```

Stripe MCP needs a restricted API key. See [Stripe MCP docs](https://docs.stripe.com/stripe-apps/build/stripe-cli/install).

**What it unlocks for Clio workflows**

- Reconcile Stripe charges with Clio bill payments
- Cross-reference Clio's `clio_payments` endpoints with Stripe charges to
  catch chargebacks
- Generate payment links for AR follow-up

**Plays well with skills:** `clio-billing`, `clio-trust-accounting` (for
fee deposits — never client trust funds via Stripe).

---

## Slack / Microsoft Teams

For internal firm communications.

**What it unlocks**

- Post matter updates to a Slack channel after `clio-matter-intake`
- Notify a paralegal in Slack when a task is assigned
- Search Slack for context when summarizing a matter ("when did we last
  hear from this client?")

**Setup**

Slack MCP and Teams (via Microsoft Graph) — see their respective install
docs. Set the channel routing in your `.claude/clio-manage.local.md`
settings file.

---

## Sentry / Application Insights

For monitoring the MCP server itself when deployed firm-wide on Azure
Container Apps.

**Application Insights** is auto-wired by the [Bicep template](../infra/main.bicep)
that ships with this repo — no setup required. Logs flow through `console.log`
on stderr to the Container App's Log Analytics workspace.

**Sentry** is optional. Install the Sentry MCP:

```bash
claude /plugin install sentry
```

The Sentry plugin lets Claude query errors, performance traces, and
session replays. Useful when a paralegal reports a failed tool call —
Claude can pull the matching Sentry event.

---

## Court systems & legal research

These don't have official MCPs as of this writing, but are on the roadmap:

- **Westlaw / LexisNexis** — case law lookups
- **PACER** — federal court filings
- **State court e-filing** — varies by state

If the user asks for these, point them at Clio's built-in research
integrations or external tools.

---

## What you *don't* need

Nothing in this plugin requires:

- A specific LLM provider beyond Claude
- Anthropic API keys (the MCP and plugin run on your existing Claude Code
  install)
- Cloud infrastructure (local stdio path works fine for solo/small firm
  use)
- Any non-Clio data source

Start with just `clio-manage`. Add connectors as you find specific
workflows that need them.
