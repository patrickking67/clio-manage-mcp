import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { defineTool, paginationShape, type ToolContext } from "./_base.js";

/**
 * Clio quirks around activities (time/expense entries):
 *   - On GET, requesting `description` returns 400; use `note` instead.
 *   - `rate` is NOT a valid GET field; compute total from price × quantity.
 *   - TimeEntry.total = quantity_in_hours × rate (NOT × price).
 *   - For flat-fee line items use ExpenseEntry (total = quantity × price).
 *   - List filter is `matter_id` (singular int); `matter` or `matter[id]` silently ignored.
 *   - Default GET on activities returns only id + etag — must pass ?fields=...
 */
const DEFAULT_ACTIVITY_FIELDS =
  "id,type,date,note,total,price,quantity,quantity_in_hours,non_billable,billed,user{id,name}," +
  "matter{id,display_number},activity_description{id,name},expense_category{id,name}";

export function registerActivityTools(server: McpServer, ctx: ToolContext): void {
  defineTool(server, ctx, {
    name: "clio_list_activities",
    title: "List activities (time + expense entries)",
    description:
      "Lists time entries and expenses. Filter by matter, user, date range, or type. Defaults to a " +
      "useful field set since a bare GET on activities returns only id + etag.",
    inputSchema: {
      matter_id: z.number().int().optional().describe("MUST be a single int — `matter[id]` is silently ignored."),
      user_id: z.number().int().optional(),
      type: z.enum(["TimeEntry", "ExpenseEntry"]).optional(),
      start_date: z.string().optional().describe("YYYY-MM-DD."),
      end_date: z.string().optional().describe("YYYY-MM-DD."),
      non_billable: z.boolean().optional(),
      billed: z.boolean().optional(),
      fields: z.string().optional(),
      ...paginationShape,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async handler(args, c) {
      const items = await c.client.paginate<unknown>("activities.json", {
        query: {
          matter_id: args.matter_id,
          user_id: args.user_id,
          type: args.type,
          start_date: args.start_date,
          end_date: args.end_date,
          non_billable: args.non_billable,
          billed: args.billed,
        },
        fields: args.fields ?? DEFAULT_ACTIVITY_FIELDS,
        limit: args.limit,
        pageSize: args.page_size,
      });
      return { data: items, count: items.length };
    },
  });

  defineTool(server, ctx, {
    name: "clio_get_activity",
    title: "Get activity",
    description:
      "Returns a single activity. You MUST request specific fields — Clio's default response is just id + etag.",
    inputSchema: {
      activity_id: z.number().int(),
      fields: z.string().optional(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async handler(args, c) {
      return c.client.request(`/activities/${args.activity_id}.json`, {
        fields: args.fields ?? DEFAULT_ACTIVITY_FIELDS,
      });
    },
  });

  defineTool(server, ctx, {
    name: "clio_create_time_entry",
    title: "Create time entry",
    description: "Logs billable or non-billable time on a matter. TimeEntry.total = quantity_in_hours × rate.",
    inputSchema: {
      matter_id: z.number().int(),
      user_id: z.number().int().optional().describe("Defaults to CLIO_DEFAULT_USER_ID."),
      date: z.string().describe("YYYY-MM-DD."),
      quantity_in_hours: z.number().positive().describe("Hours worked. Drives the total."),
      note: z.string().optional().describe("Free-text description (Clio also accepts `description` on POST)."),
      rate: z.number().optional().describe("Hourly rate. If omitted Clio uses the user's default."),
      activity_description_id: z.number().int().optional(),
      non_billable: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, idempotentHint: false },
    async handler(args, c) {
      const userId = args.user_id ?? c.cfg.defaultUserId ?? undefined;
      if (!userId) throw new Error("user_id required (or set CLIO_DEFAULT_USER_ID).");
      return c.client.request("/activities.json", {
        method: "POST",
        data: {
          type: "TimeEntry",
          matter: { id: args.matter_id },
          user: { id: userId },
          date: args.date,
          quantity_in_hours: args.quantity_in_hours,
          note: args.note,
          rate: args.rate,
          activity_description: args.activity_description_id
            ? { id: args.activity_description_id }
            : undefined,
          non_billable: args.non_billable,
        },
      });
    },
  });

  defineTool(server, ctx, {
    name: "clio_create_expense_entry",
    title: "Create expense entry / flat-fee line item",
    description:
      "Creates an ExpenseEntry. Use this for flat-fee line items as well — total = quantity × price " +
      "(not rate × hours).",
    inputSchema: {
      matter_id: z.number().int(),
      user_id: z.number().int().optional(),
      date: z.string().describe("YYYY-MM-DD."),
      quantity: z.number().describe("Usually 1 for flat-fee line items."),
      price: z.number().describe("Per-unit cost; total = quantity × price."),
      note: z.string().optional(),
      expense_category_id: z.number().int().optional(),
      non_billable: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, idempotentHint: false },
    async handler(args, c) {
      const userId = args.user_id ?? c.cfg.defaultUserId ?? undefined;
      return c.client.request("/activities.json", {
        method: "POST",
        data: {
          type: "ExpenseEntry",
          matter: { id: args.matter_id },
          user: userId ? { id: userId } : undefined,
          date: args.date,
          quantity: args.quantity,
          price: args.price,
          note: args.note,
          expense_category: args.expense_category_id ? { id: args.expense_category_id } : undefined,
          non_billable: args.non_billable,
        },
      });
    },
  });
}
