---
name: clio-matter-intake
description: Open a new matter in Clio Manage end-to-end — create or look up the client contact, create the matter (with practice area, fee structure, and matter contacts), add an opening note, and schedule an intake task. Use when the user says "open a new matter", "new client", "intake", "set up a matter for", "start a file for", "onboard this client", or when they describe a new engagement with a name and a fee.
argument-hint: "[free-form description of the new engagement]"
allowed-tools: AskUserQuestion, Bash, Read
---

# Open a new matter

The MCP exposes `clio_open_new_matter` — a composite tool that chains
contact creation, matter creation, custom-rate application, opening note,
and intake task into one call. This skill orchestrates the user-facing
side: gather inputs, confirm, fire the composite tool, and verify the
result.

## Step 1 — collect the intake fields

From the user's prompt or by asking. Required:

- **Client name** (person or company)
- **Matter description** (one line — what's it about)
- **Practice area** (must match a `clio_list_practice_areas` entry, or be
  null)
- **Fee structure**: hourly / flat fee / contingency / pro bono. If flat
  fee, get the amount and currency.
- **Originating attorney** (their `clio_who_am_i`, unless specified)
- **Responsible attorney** (default = originating)

Nice to have:

- Opposing party
- Court or jurisdiction
- Conflict-check confirmation ("any conflicts?")
- Engagement letter status

If anything required is missing, ask **one focused question per gap**.
Don't fire a 6-question questionnaire; tease it out conversationally.

## Step 2 — duplicate check (mandatory)

Before creating, search for likely duplicates:

```
clio_search_contacts(query="<client name>")
clio_list_matters(query="<client name>", limit=10)
```

If a matching contact or open matter exists, **stop and tell the user**.
Three options:

1. "Use the existing contact #N and open a new matter under it"
2. "This looks like the same matter as #M — should I add a note instead?"
3. "Different person despite the name — create a fresh contact"

Wait for the answer. Never silently dedupe.

## Step 3 — confirm

Show a one-screen summary:

```
About to open a new matter:
  Client: Jane Smith (new person contact)
  Matter: "Landlord/Tenant — apartment lease termination"
  Practice area: Real Estate (#12)
  Fee: flat $2,500 USD
  Originating attorney: Patrick King
  Opening note: "Initial consult 5/18 — client wants out of lease by 7/31"
  Intake task: "Send engagement letter" due Fri 5/22 → assigned Jane Doe (paralegal)

Confirm?
```

Don't proceed without an affirmative.

## Step 4 — fire `clio_open_new_matter`

This is the composite tool. Pass everything in one call. The MCP handles:

1. `clio_create_person_contact` or `clio_create_company_contact`
2. `clio_create_matter` with `client_id` from step 1
3. If flat fee: a second `PATCH /matters/{id}.json` to set the custom rate
   (Clio quirk: `billing_method=flat` on create is silently ignored)
4. `clio_create_note` linked to the matter
5. `clio_create_task` linked to the matter with assignee + due date

If step 3 or later fails, the matter still exists. The composite tool
reports partial success — surface that to the user honestly:

> "Matter #4892 was created with the client, but the flat-fee rate didn't
> apply (Clio returned 422). The opening note and intake task are also
> attached. Want me to retry the rate, or set it in Clio manually?"

## Step 5 — verify and link

Echo back:

- The new matter URL in Clio (`https://app.clio.com/nc/#/matters/<id>`)
- The matter display number (Clio assigns this)
- The created task's due date
- A reminder to send the engagement letter if applicable

## Edge cases

- **No practice area selected?** Default to null; Clio allows it. Don't
  invent one.
- **Existing contact, new matter?** Skip the contact-create step; pass
  `client_id` directly.
- **Pro bono or contingency?** Don't set a flat-fee rate. The fee structure
  is metadata on the matter, not always a rate.
- **Conflict check?** This skill doesn't run a real conflict check —
  Clio's built-in conflict search lives in the UI. Prompt the user to
  confirm they've cleared conflicts; flag it in the audit trail.

## Reference

- [`src/tools/workflows.ts`](../../../src/tools/workflows.ts) — the composite
  tool's implementation, including the "YOUR TURN" extensibility hook for
  firm-specific intake policy
- [`src/tools/matters.ts`](../../../src/tools/matters.ts) — underlying
  matter operations
