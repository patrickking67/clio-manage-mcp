import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { defineTool, paginationShape, type ToolContext } from "./_base.js";

const DEFAULT_NOTE_FIELDS =
  "id,subject,detail,date,user{id,name},matter{id,display_number},contact{id,name},type,date_created,date_updated";

export function registerNoteTools(server: McpServer, ctx: ToolContext): void {
  defineTool(server, ctx, {
    name: "clio_list_notes",
    title: "List notes",
    description: "Lists notes attached to a matter or contact.",
    inputSchema: {
      matter_id: z.number().int().optional(),
      contact_id: z.number().int().optional(),
      ...paginationShape,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async handler(args, c) {
      const items = await c.client.paginate<unknown>("notes.json", {
        query: { matter_id: args.matter_id, contact_id: args.contact_id },
        fields: DEFAULT_NOTE_FIELDS,
        limit: args.limit,
        pageSize: args.page_size,
      });
      return { data: items, count: items.length };
    },
  });

  defineTool(server, ctx, {
    name: "clio_create_note",
    title: "Create note",
    description:
      "Creates a note on a matter or contact. Notes appear in Clio's matter timeline and survive " +
      "indefinitely — appropriate for memorializing client conversations and AI-generated summaries.",
    inputSchema: {
      subject: z.string().describe("Short title — visible in matter timeline."),
      detail: z.string().describe("Note body. Plain text or HTML."),
      matter_id: z.number().int().optional(),
      contact_id: z.number().int().optional(),
      date: z.string().optional().describe("ISO 8601 timestamp. Defaults to now."),
    },
    annotations: { readOnlyHint: false, idempotentHint: false },
    async handler(args, c) {
      if (!args.matter_id && !args.contact_id) {
        throw new Error("Must supply either matter_id or contact_id (or both).");
      }
      return c.client.request("/notes.json", {
        method: "POST",
        data: {
          subject: args.subject,
          detail: args.detail,
          date: args.date,
          matter: args.matter_id ? { id: args.matter_id } : undefined,
          contact: args.contact_id ? { id: args.contact_id } : undefined,
          type: args.matter_id ? "Matter" : "Contact",
        },
      });
    },
  });
}
