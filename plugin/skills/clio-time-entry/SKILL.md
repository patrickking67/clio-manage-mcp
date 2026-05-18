---
name: clio-time-entry
description: Log time entries in Clio Manage correctly — billable vs non-billable, hourly vs flat-fee matters, UTBMS task/activity codes, and timer-to-entry conversion. Use when the user says "log time", "track hours", "I spent N hours on", "bill X hours", "stop the timer and log", "record this as time", or when they describe work performed on a matter that should be recorded.
---

# Logging time correctly

Time entries in Clio are `Activity` records of type `TimeEntry`. The MCP
exposes `clio_create_time_entry` and `clio_list_activities` for reads.

## Required fields

- **matter_id** (required) — the matter to bill against
- **user_id** — defaults to `clio_who_am_i` if omitted
- **date** — ISO date (YYYY-MM-DD), defaults to today
- **quantity_in_hours** — decimal hours, e.g. `1.25`. *Note: the API stores
  `quantity` in seconds (since v4.0.4) — the MCP converts from hours for you.*
- **description** (note on the entry) — what was done
- **non_billable** — boolean, default false
- **activity_description_id** — link to a saved time description / rate

## Decision tree

### Is the matter hourly or flat-fee?

Look it up first:

```
clio_get_matter(id, fields="id,billing_method,custom_rate,rate")
```

- **Hourly:** log time normally. Rate comes from user → matter → firm
  cascade.
- **Flat fee:** still log time, but **set `non_billable=false` with a flat
  rate** OR mark `non_billable=true` if firm policy says flat-fee matters
  don't track time for billing. **Ask the user** which it is — firms differ.
- **Contingency:** typically `non_billable=true` but tracked for internal
  metrics.
- **Pro bono:** `non_billable=true`.

### UTBMS codes

If the matter has UTBMS coding enabled (typically insurance defense or
e-billing matters), the entry needs both an `activity_description_id` and a
`task_id` (UTBMS code). The MCP exposes UTBMS endpoints via
`clio_api_request` against `/utbms_codes.json` and `/utbms_sets.json`. List
them, let the user pick, then attach the codes.

If the matter doesn't use UTBMS, skip this entirely.

### Multi-day blocks

If the user says "I worked 8 hours on this matter Monday through
Wednesday," create three entries, not one. Clio's billing logic groups by
date.

## Confirmation pattern

```
About to log:
  Matter: 2024-0042 "Acme v. Smith"
  Date: 2026-05-18
  Hours: 2.5 billable
  Description: "Reviewed motion for summary judgment, drafted response outline"
  Activity: Legal Research (#7)

Confirm?
```

Show the description verbatim — that text goes on the bill the client sees.

## Multi-entry batching

If the user says "log my time for the day," ask for the list, then fire one
`clio_create_time_entry` per entry. Don't try to combine. Each gets its own
audit row.

If the user gives a Slack/Teams transcript or calendar summary, **extract,
confirm, then log**. Don't infer hours — ask if vague.

## Reading time entries

For reports:

```
clio_list_activities(
  matter_id=<id>,
  type="TimeEntry",
  start_date="2026-05-01",
  end_date="2026-05-31",
  fields="id,date,quantity_in_hours,non_billable,description,user{id,name},total"
)
```

Common asks:

- "How many hours has Jane logged on matter 4821?" → list with
  `user_id=Jane`, sum `quantity_in_hours`
- "What's unbilled on matter 4821?" → list activities where
  `billed=false` (use `clio_api_request` with `billed=false` filter if
  needed)
- "What's my time for the month?" → list with `user_id=me`,
  `start_date=month start`, `end_date=month end`

## Clio quirks

- The list endpoint returns sparse fields by default (just `id` and
  `etag`). Always pass `fields=`.
- `description` is write-only on create. On GET, the text is in the `note`
  field.
- `quantity_redacted=true` means the API hid hours due to per-user
  visibility settings. Don't sum redacted entries — flag the gap.
- Timers (`/timers.json`) are a separate concept; the MCP doesn't wrap
  them. Use `clio_api_request` if the user wants timer control.

## Don't

- Don't auto-log time without confirmation. Even small entries become
  billed hours.
- Don't backdate without asking. Clio allows it but firms have policies.
- Don't infer descriptions. A vague entry like "worked on case" is worse
  than asking.
