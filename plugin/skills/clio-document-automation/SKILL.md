---
name: clio-document-automation
description: Work with documents in Clio Manage — list, download, find templates, and prepare for automated document generation. Use when the user says "document", "template", "engagement letter", "draft a", "merge fields", "automation", "download", "upload", "find the file", or asks about Clio's document templates or document automations.
---

# Documents in Clio

Clio's document model: **Documents** are files, **Document Templates** are
fillable templates with merge fields, **Document Automations** are
generated outputs that bind a template to a matter. The MCP wraps reads
and download URLs; bulk content generation typically goes through
companion tools.

## Tool map

| Intent | Tool |
|---|---|
| List documents on a matter | `clio_list_documents` (matter_id, parent_id) |
| List folders on a matter | `clio_list_folders` (matter_id, parent_id) |
| Get one document's metadata | `clio_get_document` |
| Get a download URL | `clio_get_document_download_url` |
| Search templates | `clio_api_request` GET `/document_templates.json` |
| Trigger a document automation | `clio_api_request` POST `/document_automations.json` |
| Archive bulk download | `clio_api_request` against `/document_archives` |

## Common workflows

### "Find the engagement letter for matter 4821"

```
1. clio_list_documents(matter_id=4821, fields="id,name,category{id,name},updated_at")
2. Filter for name containing "engagement" or category "Engagement Letters"
3. clio_get_document_download_url(id=<doc id>) for a temporary signed URL
4. Hand the URL to the user (or fetch the content via WebFetch if needed)
```

### "Draft an engagement letter for matter 4821"

The MCP doesn't word-process. Two paths:

1. **Clio Document Automation:** if the firm has a template configured,
   trigger it via `clio_api_request` POST `/document_automations.json`
   with the template ID and matter ID. Clio renders and stores the doc.
2. **External:** generate the letter in Word (Microsoft Word MCP) or
   Google Docs (Google Drive MCP) using matter metadata as merge fields,
   then upload back to Clio.

Ask the user which path they want before doing either.

### "Show me all templates"

```
clio_api_request(method="GET", path="/document_templates.json", params={fields:"id,name,description,category{id,name}"})
```

### "Upload a signed PDF"

The MCP currently exposes reads and download URLs. Upload paths (POST
`/documents.json`) aren't wrapped as a typed tool — use `clio_api_request`
with a multipart body, or instruct the user to upload via the Clio UI.

## Document categories

Documents in Clio can be organized into categories (Engagement Letters,
Pleadings, Correspondence, etc.). List them:

```
clio_api_request(method="GET", path="/document_categories.json")
```

Filter `clio_list_documents` with `category_id` for clean per-type
queries.

## Merge fields

When generating documents externally (Word/Docs), the typical merge fields
the user will want to populate from Clio:

- `matter.display_number`
- `matter.description`
- `client.name`, `client.primary_address`, `client.primary_email_address`,
  `client.primary_phone_number`
- `responsible_attorney.name`
- `today` (current date)
- `firm.name`, `firm.address` (from `clio_who_am_i` and config)

Pull these in one `clio_get_matter` call with `fields=` explicit; one
network round-trip beats six.

## Don't

- Don't upload sensitive client documents anywhere else without explicit
  user permission. (See [`clio-best-practices`](../clio-best-practices/SKILL.md).)
- Don't `clio_get_document_download_url` URLs in chat history if the
  conversation might be exported. The URLs are time-limited but they're
  still credentials.
- Don't bulk-archive without confirming the user wants a heavy operation —
  document_archives can take minutes for large matters.
