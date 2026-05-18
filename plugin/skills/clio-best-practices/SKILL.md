---
name: clio-best-practices
description: Apply Clio API best practices and legal-tech AI ethics (ABA Formal Opinion 512) to any work on the clio-manage MCP — rate limiting, ETags, audit trails, redaction, write confirmations, and client confidentiality. Use whenever the user is about to write or mutate Clio data, when they ask "is it safe to", "what about confidentiality", "rate limit", "audit", "compliance", "ethics", "ABA 512", or when generating Clio integration code.
---

# Clio API + AI Ethics best practices

The Clio Manage MCP runs against a live law-firm production system. Mistakes
are not abstract — they affect billable records, court deadlines, and client
funds. This skill applies whenever you're about to write Clio data, design a
new flow, or advise on a Clio integration.

## Hard rules

1. **Never mutate without explicit user confirmation** for: matter creation,
   matter closure, time entry posting against an issued invoice, trust
   account transfers, bill issuance, contact deletion.
2. **Never read or write client data on someone else's behalf without authorization.**
   The MCP's `clio_who_am_i` is the OAuth user. Audit trails attribute
   actions to them. Be explicit if the user is acting for a partner.
3. **Never disclose another client's confidential information** to satisfy a
   query, even indirectly. If a list call would surface matters across
   clients, scope it.
4. **Audit mode is metadata or full in production.** `none` is for dev only.
   Tell the user if you see it set to `none`.
5. **Don't store Clio credentials or tokens in chat, files, or prompts.**
   Reference `.env` and `CLIO_STATE_DIR/tokens.json`. The token file is
   AES-256-GCM encrypted at rest — don't write it elsewhere.

## ABA Formal Opinion 512 highlights (legal-tech AI)

The American Bar Association's [Formal Opinion 512](https://www.americanbar.org/content/dam/aba/administrative/professional_responsibility/ethics-opinions/aba-formal-opinion-512.pdf)
governs lawyer use of generative AI. The relevant duties this skill enforces:

- **Competence (Model Rule 1.1):** Understand the tool's limits. Don't claim
  Clio data the MCP didn't return.
- **Confidentiality (Rule 1.6):** Don't paste matter content into prompts
  that train external models. The MCP doesn't train; ensure downstream
  clients (e.g., Claude in the user's workspace) are configured similarly.
- **Communication (Rule 1.4):** Clients should know AI is being used. Not
  this skill's job to enforce, but flag it if the user asks.
- **Reasonable fees (Rule 1.5):** Don't auto-bill AI time review without
  partner sign-off.
- **Supervision (Rule 5.1/5.3):** Treat AI output as a junior associate's
  draft. Verify before sending to a court or client.

## Rate limits and retry behavior

Clio v4 rate limits are per-token and undocumented in precise numbers, but
the MCP retries 429s with exponential backoff (configured in
[src/clio/](../../../src/clio)). Practical guidance:

- **List with `limit=200`** when paging — more pages = more requests.
- **Use `updated_since` for delta syncs** instead of full re-fetches.
- **Batch reads with `ids[]`** when you have a list of IDs (supported on
  most endpoints).
- **Don't fan out parallel requests** beyond 4–5 in flight. The MCP doesn't
  rate-pace for you.

If you hit a 429 burst, back off the workflow and tell the user. Don't
silently keep retrying.

## ETags and concurrency

PATCH/PUT endpoints accept an `If-Match` header with the resource's ETag.
The MCP's typed tools handle this when given the etag from a prior GET.
Without an ETag, you race other users (lawyers updating the same matter).

Pattern for safe update:

```
1. clio_get_matter(id, fields="id,etag,description,status")
2. Show the user the current state
3. clio_update_matter(id, etag, …new values…)
```

If the server returns 412 Precondition Failed, refresh and retry.

## Confirmation patterns for writes

For any write tool, default to:

1. **Summarize the action** in plain English: "I'm going to open a new
   matter for Jane Smith, flat-fee $2,500, billed to client #123. Confirm?"
2. **Wait for explicit yes/no.** "yes", "go ahead", "confirm" all count.
   Anything else means stop.
3. **After success**, echo back the created resource ID, URL, and key
   fields. Don't say "done" without specifics.

For `clio_open_new_matter` (the composite intake workflow), the agent
implementation already prompts for a final review — don't suppress it.

## Audit trail expectations

Every tool call writes a JSONL line to `$CLIO_STATE_DIR/audit.log` (mode
0o600). Lines include: timestamp, tool name, caller ID, args/result
fingerprints (in `metadata` mode) or full args/results (in `full` mode).

Use the audit log when:

- The user asks "what did Claude just do?"
- A bill or matter looks wrong and they want to trace
- The firm is preparing a compliance review

To read it, use the `audit` MCP resource (exposed by [src/resources.ts](../../../src/resources.ts)).
Don't `cat` the file directly; the resource adds privacy filtering.

## When NOT to use the MCP

Tell the user no when:

- They want to move money via trust account without an explicit ledger
  entry and approval flow
- They ask to delete a matter (use close, not delete — `clio_delete_matter`
  exists but should require a written confirmation)
- They want to bulk-update bills already sent to clients
- They ask for fields the MCP redacts (e.g., another user's hours when
  `quantity_redacted=true`)

## Reference reading

- [`docs/security.md`](../../../docs/security.md) — encryption, audit modes
- [`docs/oauth-setup.md`](../../../docs/oauth-setup.md) — OAuth scopes and rotation
- [Clio API docs](https://docs.developers.clio.com/) — official
- [ABA Op 512](https://www.americanbar.org/content/dam/aba/administrative/professional_responsibility/ethics-opinions/aba-formal-opinion-512.pdf) — legal-tech AI ethics
