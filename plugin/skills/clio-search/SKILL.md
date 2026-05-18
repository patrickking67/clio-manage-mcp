---
name: clio-search
description: Pick the right Clio Manage tool when the user asks to find, list, filter, or look up matters, contacts, time entries, tasks, calendar events, notes, documents, or bills. Use when the user says "find", "search", "list", "show me", "look up", "what matters", "who is", "show open tasks", "any bills for", "did we log time on", or similar discovery phrasing against Clio data.
---

# Searching Clio

Map the user's request to the **smallest** correct tool call. Lists in Clio
support filtering — use the filters instead of fetching everything and
filtering client-side. Pagination defaults are sane (100/page) but list
results can be huge; warn the user before pulling unbounded data.

## The decision table

| User intent | First tool | Key filters |
|---|---|---|
| Find a matter | `clio_list_matters` | `client_id`, `status`, `practice_area_id`, `updated_since`, `query` |
| Look up one matter by ID | `clio_get_matter` | `id`, `fields` |
| Find people or companies | `clio_search_contacts` | `query` (free-text) |
| Filter contacts by type | `clio_list_matter_contacts` (if scoped to a matter) or `clio_get_contact` | — |
| Time entries on a matter | `clio_list_activities` | `matter_id`, `user_id`, `type=TimeEntry`, `start_date`, `end_date` |
| Expenses on a matter | `clio_list_activities` | `matter_id`, `type=ExpenseEntry` |
| Tasks across firm | `clio_list_tasks` | `assignee_id`, `status`, `priority`, `due_at_from`, `due_at_to` |
| Tasks on a matter | `clio_list_tasks` | `matter_id` |
| Notes on a matter | `clio_list_notes` | `matter_id` |
| Calendar | `clio_list_calendar_entries` | `calendar_id`, `from`, `to`, `user_id` |
| Bills | `clio_list_bills` | `client_id`, `matter_id`, `state` (`draft`, `pending_approval`, `awaiting_payment`, `paid`, `void`), `due_since`, `due_before` |
| Billing summary for a matter | `clio_get_billing_summary` | `matter_id` |
| Documents | `clio_list_documents` | `matter_id`, `contact_id`, `parent_id` |
| Document folders | `clio_list_folders` | `parent_id`, `matter_id` |
| Users in the firm | `clio_list_users` | `enabled`, `subscription_type` |
| Practice areas | `clio_list_practice_areas` | — |

## Field selection (cheap optimization)

Every Clio v4 list tool accepts a `fields` parameter. Use it. The default
response is sparse (only `id` and `etag`) and the agent will then re-fetch
each result — wasteful. Pass `fields` explicitly:

```
fields = "id,display_number,description,status,client{id,name},practice_area{id,name},open_date,close_date"
```

Tell the user roughly how many records you're asking for. If a list might
return thousands, page deliberately — `limit=200&page=1` then `page=2`, not
an unbounded loop.

## Search quirks to know

- **`query`** on `clio_list_matters` is full-text across description and
  display number. Use it for natural-language matches; combine with
  `client_id` when you know the client.
- **`updated_since`** takes an ISO-8601 timestamp. Use it for delta syncs.
- **`matter_id` filter is singular.** Clio rejects arrays here — if the user
  wants entries across multiple matters, loop or call `clio_api_request`.
- **`status` on matters** uses lowercase strings: `open`, `pending`,
  `closed`. Don't title-case them.
- **`description` on activities is write-only** on the create endpoints;
  to read, look at the `note` field on GET.

## When the user gives a name, not an ID

The flow is: search → confirm → act. Don't guess.

```
1. clio_search_contacts(query="Jane Smith")  → list of candidates
2. If 1 match: use that ID
3. If multiple: ask the user which one
4. If 0: offer to create the contact (clio_create_person_contact)
```

The same pattern applies to matters: `clio_list_matters` with a `query` or
`client_id` first; never assume a matter ID from a casual reference.

## When to escape to `clio_api_request`

Only when:

- A filter combination isn't covered by the typed tools (rare)
- A response field isn't exposed by the typed tools
- The user asks for something on an endpoint not yet wrapped (e.g.,
  `/credit_memos.json`, `/trust_requests.json`)

`clio_api_request` is a documented escape hatch. Use it sparingly; the typed
tools have built-in validation, audit, and ETag handling.

## Showing results

Default to a small, readable table for ≤ 20 rows. For larger sets, summarize
counts and let the user drill in:

> Found 47 open matters for Acme Corp. Top 5 by last-updated:
> - 2024-0042 — "Acme v. Smith" — updated 2 days ago
> - 2024-0039 — ...

Don't paste raw JSON unless the user asks.
