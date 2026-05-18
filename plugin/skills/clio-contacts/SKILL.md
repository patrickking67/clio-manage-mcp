---
name: clio-contacts
description: Manage contacts in Clio Manage — search and dedupe people and companies, create new contacts (person or company), update existing contacts, manage email/phone/address records, and link contacts to matters. Use when the user mentions "contact", "client", "person", "company", "add a new", "find a contact", "update phone", "merge duplicate", "primary email", or asks about who is associated with a matter.
---

# Clio contacts

Contacts in Clio split into **Person** and **Company**. Both share a base
schema (`name`, `email_addresses[]`, `phone_numbers[]`, `addresses[]`,
`custom_field_values[]`) but the create endpoints differ.

## Tool map

| Intent | Tool |
|---|---|
| Search by name/email | `clio_search_contacts` (query) |
| Get one contact | `clio_get_contact` |
| Create a person | `clio_create_person_contact` |
| Create a company | `clio_create_company_contact` |
| Update a contact | `clio_update_contact` |
| Delete | `clio_delete_contact` (rare — usually archive instead) |
| List matter contacts | `clio_list_matter_contacts` (matter_id) |
| Phone/email subresources | `clio_api_request` against `/contacts/{id}/email_addresses.json` etc. |

## Person vs company

- **Person:** first_name + last_name, optional title and middle_name
- **Company:** name (single field), no first/last

Don't shoehorn one into the other. If the user says "Acme Corp" use
`clio_create_company_contact`. If "Jane Smith at Acme," create the person
and link them to the company via `clio_update_contact` with
`primary_company_id`.

## Dedupe before creating

The MCP has no built-in dedupe. Always:

```
1. clio_search_contacts(query="<name>")
2. If matches, show them and ask "is this the one?" or "create new anyway?"
3. Only create if the user explicitly confirms it's a new contact
```

For email matching specifically, search by email:

```
clio_search_contacts(query="<email>")
```

Clio's full-text matcher includes email addresses.

## Email/phone/address structure

Each contact has arrays of these. Each entry has:

- `name` — enum, must be one of: `Work`, `Home`, `Billing`, `Other` (Clio
  rejects other values)
- `address` / `number` / `email` — the actual value
- `default_email`, `default_phone`, `default_address` — booleans for the
  primary

When creating, set the primary explicitly:

```
{
  "email_addresses": [
    { "name": "Work", "address": "jane@example.com", "default_email": true }
  ]
}
```

To add a phone to an existing contact, use the subresource endpoint via
`clio_api_request`:

```
POST /contacts/{contact_id}/phone_numbers.json
{ "data": { "name": "Mobile", "number": "415-555-0100", "default_phone": false } }
```

Note: `Mobile` is *not* in the address-name enum — phone numbers have their
own enum. Check the Clio API docs before assuming.

## Updating contacts safely

Always GET first to get the ETag, then PATCH:

```
1. clio_get_contact(id, fields="id,etag,name,email_addresses,phone_numbers")
2. Build the patch (only changed fields)
3. clio_update_contact(id, etag, …)
```

Without the ETag, you risk overwriting concurrent edits from a paralegal
in the Clio UI.

## Linking contacts to matters

Matter contacts have a *role* — Client, Other Party, Co-Counsel, Witness,
etc. List them on a matter:

```
clio_list_matter_contacts(matter_id=<id>, fields="id,contact{id,name},relationship{id,description}")
```

To add a contact to a matter with a role, use `clio_api_request`:

```
POST /matters/{matter_id}/contacts.json
{ "data": { "contact_id": ..., "relationship": "Other Party" } }
```

## Don't

- Don't delete contacts in production. Use `clio_update_contact` with
  `archived: true` instead. Deletion in Clio cascades unexpectedly.
- Don't bulk-update primary emails without confirmation. Many firms have
  automation triggered by primary_email changes.
- Don't paste personally identifiable information into chat that isn't
  going to Clio. Audit mode `full` will log the args; mode `metadata` won't.
