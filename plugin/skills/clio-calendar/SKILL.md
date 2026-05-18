---
name: clio-calendar
description: Work with the Clio calendar — list events, create calendar entries, link them to matters, and (if available) check court rules. Use when the user says "calendar", "schedule", "meeting", "appointment", "court date", "hearing", "deadline", "what's on my calendar", "create event", "block time", or asks about firm-wide scheduling.
---

# Clio calendar

Clio has its own calendar system distinct from Outlook/Google. The MCP
wraps reads and entry creation. For full bidirectional sync with
Outlook/Google, the firm typically uses Clio's native integration in the
web UI — this skill works alongside that, not as a replacement.

## Tool map

| Intent | Tool |
|---|---|
| List events in a range | `clio_list_calendar_entries` |
| List firm calendars | `clio_list_calendars` |
| Create an event | `clio_create_calendar_entry` |
| Court rules / matter dockets | `clio_api_request` against `/court_rules/*` |

## Common asks

### "What's on my calendar this week?"

```
1. clio_list_calendars() → find the user's personal calendar id (or the firm's)
2. clio_list_calendar_entries(
     calendar_id=<id>,
     from="<Monday 00:00>",
     to="<Sunday 23:59>",
     fields="id,summary,start_at,end_at,location,matter{id,display_number}"
   )
```

If the user has multiple calendars (personal + matter + firm), ask which
to query, or query all and merge.

### "Schedule a hearing on matter 4821 for next Tuesday 2pm"

```
1. clio_create_calendar_entry(
     calendar_id=<user's primary>,
     matter_id=4821,
     summary="Hearing — Acme v. Smith",
     start_at="2026-05-26T14:00:00-07:00",
     end_at="2026-05-26T15:00:00-07:00",
     location="Superior Court of California, Dept. 5"
   )
```

Always include the matter ID when the event is matter-related — bills,
audit, and reporting rely on the link.

Always pass timezones explicitly in `start_at`/`end_at`. The MCP forwards
ISO-8601 with offset; Clio will not infer.

### "Check for conflicts before booking"

```
1. clio_list_calendar_entries(from=<requested start>, to=<requested end>)
2. If any overlap, surface them and ask the user before creating
```

The MCP doesn't auto-conflict-check; do it yourself.

## Court rules (jurisdictions + triggers)

Clio's Court Rules feature computes downstream deadlines from a triggering
event (e.g., "complaint filed" → answer due 30 days). The MCP doesn't wrap
court rules with typed tools, but the endpoints exist:

- `GET /court_rules/jurisdictions.json` — list jurisdictions
- `GET /court_rules/jurisdictions/{id}/triggers.json` — list triggers
- `POST /court_rules/matter_dockets.json` — apply a trigger to a matter,
  generating downstream calendar entries automatically

If the user is in a litigation matter and asks about deadlines, suggest
matter dockets. Use `clio_api_request` to apply.

## Calendar entry event types

Clio supports custom event types (Hearing, Deposition, Meeting,
Deadline). List them:

```
clio_api_request(method="GET", path="/calendar_entry_event_types.json")
```

When creating a critical event (hearing, statute of limitations), pick the
right type so it's filterable later.

## Don't

- Don't create calendar events without a clear `summary`. Empty events
  pollute calendars and the firm's filter views.
- Don't bulk-create from a script without confirmation. Calendar entries
  can also trigger client notifications depending on firm config.
- Don't assume `now`. If the user says "tomorrow at 2," reflect the actual
  date back ("Tuesday May 19 at 2:00 PM Pacific?") before firing.
