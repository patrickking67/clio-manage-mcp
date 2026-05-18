---
name: clio-trust-accounting
description: Work with IOLTA / client trust accounting in Clio Manage — view trust balances by matter and client, list bank accounts and transactions, prepare three-way reconciliation reports, and handle trust requests. Use when the user mentions "trust", "IOLTA", "retainer", "client funds", "trust balance", "three-way reconciliation", "earned vs unearned", "bank reconciliation", or asks how much retainer a client has on deposit.
---

# Trust accounting in Clio

Trust accounting is the highest-stakes part of practice management. State
bars audit it. Any error here can mean disbarment. Use this skill with
extreme care, and **never mutate trust state without explicit
confirmation**.

## Concepts

- **Trust account:** an IOLTA (Interest On Lawyer's Trust Account) or
  similar — holds client funds prior to being earned.
- **Operating account:** the firm's own money.
- **Trust line item:** a deposit or withdrawal recorded against the trust
  ledger, scoped to a client and (optionally) a matter.
- **Trust request:** a request to a client to deposit funds (replenish
  retainer).
- **Three-way reconciliation:** monthly process where (a) bank statement,
  (b) trust ledger, and (c) per-client ledger balances all agree.

## Tool map

The MCP wraps reads; mutations go through `clio_api_request` with explicit
confirmation.

| Intent | Tool |
|---|---|
| Trust balance on a matter | `clio_get_billing_summary(matter_id)` → `trust_balance` field |
| List bank accounts | `clio_api_request` GET `/bank_accounts.json?type=Trust` |
| List trust transactions | `clio_api_request` GET `/bank_transactions.json?bank_account_id=<trust>` |
| List trust line items | `clio_api_request` GET `/trust_line_items.json?matter_id=<id>` |
| List trust requests | `clio_api_request` GET `/trust_requests.json` |
| Outstanding client balances | `clio_api_request` GET `/outstanding_client_balances.json` |

## Common asks

### "How much does Acme have in trust?"

```
1. clio_search_contacts(query="Acme") → client_id
2. clio_list_matters(client_id, fields="id,display_number")
3. For each matter: clio_get_billing_summary(matter_id) → sum trust_balance
4. Report per-matter and total
```

A client might have multiple matters with their own trust slices. Always
break it out — partners want to see allocations.

### "Show me the three-way reconciliation for May"

```
1. Bank statement total (manually entered or from Plaid integration —
   outside this MCP)
2. Trust ledger:
   clio_api_request(GET, /bank_transactions.json, params={bank_account_id=<trust>, date_from=..., date_to=...})
3. Per-client trust balances:
   clio_api_request(GET, /outstanding_client_balances.json)
4. Compare (1) vs (2) vs (3); flag discrepancies
```

If anything doesn't reconcile, **stop and tell the user**. Don't
auto-resolve. Trust reconciliation discrepancies are a bar issue.

### "Bill the client and pay myself from trust"

This is two steps:

1. Issue the bill (manual in Clio UI, or `clio_api_request` POST
   `/bills.json` with caution).
2. Move funds from trust to operating: requires a trust transaction with
   the right metadata. Don't do this from chat without a partner sign-off
   loop. Recommend the user do it in the Clio UI where the firm's
   controls apply.

### "Request a retainer top-up"

```
clio_api_request(POST, /trust_requests.json, body={
  "data": {
    "matter_id": ...,
    "amount": ...,
    "description": "Retainer replenishment per engagement letter",
    "contact_id": <client_id>
  }
})
```

Confirm twice before firing — this generates an email to the client.

## Hard rules

1. **Never move trust funds based on a casual prompt.** Always require an
   explicit, unambiguous request with amount and source/destination.
2. **Never aggregate trust balances across clients.** Each client's funds
   are segregated. A "firm trust balance" is a bookkeeping artifact, not a
   real number.
3. **Always include matter context.** Trust without a matter link is hard
   to audit.
4. **If three-way reconciliation fails, escalate.** Don't paper over.

## Reference

- [Clio Trust Accounting docs](https://help.clio.com/hc/en-us/categories/200022870-Trust-Accounting)
- State bar rules (varies by jurisdiction) — out of MCP scope but cite
  them if asked
- [`docs/security.md`](../../../docs/security.md) — audit log captures
  every trust API call
