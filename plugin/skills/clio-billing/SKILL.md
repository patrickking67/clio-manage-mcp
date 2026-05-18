---
name: clio-billing
description: Work with Clio billing — list bills, check billing summaries, AR aging, draft/issue/void state transitions, and reconcile payments. Use when the user mentions "bill", "invoice", "outstanding balance", "AR aging", "accounts receivable", "send invoice", "draft bill", "credit memo", "write off", "what does client X owe", or asks for revenue or collection numbers.
---

# Clio billing

Clio's billing model: **activities** (time + expense) → **bills** (drafted,
approved, sent, paid) → **payments** (Clio Payments or external). Each
transition is auditable.

## Bill states (Clio v4)

| State | Meaning |
|---|---|
| `draft` | In progress, not visible to client |
| `pending_approval` | Submitted, waiting on a reviewer |
| `awaiting_payment` | Issued and sent to client |
| `paid` | Fully paid |
| `void` | Cancelled |

The MCP filters list_bills by `state`. Use exact lowercase strings.

## Common asks

### "What does Acme owe us?"

```
1. clio_search_contacts(query="Acme") → find client_id
2. clio_list_bills(client_id=<id>, state="awaiting_payment", fields="id,number,issued_at,due_at,total,balance,matter{id,display_number}")
3. Sum balances; show oldest first
```

### "Show me AR aging"

```
1. clio_list_bills(state="awaiting_payment", limit=200)
2. Bucket by (today - due_at): 0-30, 31-60, 61-90, 90+
3. Report buckets + totals
```

If you need it firm-wide, page through; remind the user the call is
potentially heavy and confirm before pulling >1000 bills.

### "Draft a bill for matter 4821"

The MCP doesn't expose `POST /bills` directly (Clio's bill creation is
multi-step: select activities, generate, then transition). Tell the user
this happens in the Clio UI today, or use `clio_api_request` with caution.

### "What's outstanding on matter 4821?"

```
clio_get_billing_summary(matter_id=4821)
```

This returns: total billed, total paid, current balance, trust balance,
unbilled time, unbilled expenses. One call, full picture.

### "What got paid this month?"

```
clio_list_bills(state="paid", limit=200, fields="id,number,paid_at,total,matter{id,display_number}")
```

Filter client-side by `paid_at` month, since the API doesn't expose a
`paid_since` filter at this time. (Track if Clio adds one.)

## State transitions

Most transitions happen in the Clio UI. The MCP wraps reads, not state
changes. If the user wants to mark a bill paid or void, route them to the
Clio web UI — or use `clio_api_request` with explicit confirmation.

## Confirmation before any write

If the user asks for anything that mutates bill state, **confirm twice**:

1. "I'm about to mark bill #1234 as void. This is irreversible from the
   API. The client may already have received it. Confirm?"
2. If yes: fire the request, echo the result.

## Reconciliation patterns

For three-way reconciliation (operating + trust + ledger), see
[`clio-trust-accounting`](../clio-trust-accounting/SKILL.md). Bills alone
don't tell the trust story.

For Clio Payments specifically (the integrated payments product),
`/clio_payments/payments.json` and `/clio_payments/links.json` are the
endpoints. Wrap via `clio_api_request` if needed.

## Don't

- Don't auto-issue bills. Issuance is when the client sees the invoice.
- Don't write off balances without partner approval. "Write off" usually
  means a credit memo (`/credit_memos.json`).
- Don't sum balances across clients without confirming the user wants
  firm-wide visibility (some users only see their own).

## Reference

- [`src/tools/bills.ts`](../../../src/tools/bills.ts)
- Clio docs: [Bills](https://docs.developers.clio.com/api-docs/), [Credit Memos](https://docs.developers.clio.com/api-docs/)
