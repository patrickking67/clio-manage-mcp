import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { defineTool, paginationShape, type ToolContext } from "./_base.js";

const DEFAULT_MATTER_FIELDS =
  "id,display_number,description,status,open_date,close_date,pending_date,practice_area{id,name}," +
  "client{id,name,type},responsible_attorney{id,name},originating_attorney{id,name},billable,billing_method";

export function registerMatterTools(server: McpServer, ctx: ToolContext): void {
  defineTool(server, ctx, {
    name: "clio_list_matters",
    title: "List matters",
    description:
      "Lists matters with optional filtering. Use `query` for free-text search across matter names, " +
      "`client_id` to scope to a single client, and `status` to filter by lifecycle stage.",
    inputSchema: {
      status: z
        .enum(["Open", "Pending", "Closed"])
        .optional()
        .describe("Matter status. Clio enums are case-sensitive."),
      client_id: z.number().int().optional().describe("Numeric Clio contact id of the client."),
      practice_area_id: z.number().int().optional(),
      responsible_attorney_id: z.number().int().optional(),
      query: z.string().optional().describe("Free-text search across matter names and descriptions."),
      updated_since: z
        .string()
        .optional()
        .describe("ISO 8601 timestamp — return matters updated after this time."),
      fields: z.string().optional().describe(`Override the default fields list. Default: ${DEFAULT_MATTER_FIELDS}`),
      ...paginationShape,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async handler(args, c) {
      const items = await c.client.paginate<unknown>("matters.json", {
        query: {
          status: args.status,
          client_id: args.client_id,
          practice_area_id: args.practice_area_id,
          responsible_attorney_id: args.responsible_attorney_id,
          query: args.query,
          updated_since: args.updated_since,
        },
        fields: args.fields ?? DEFAULT_MATTER_FIELDS,
        limit: args.limit,
        pageSize: args.page_size,
      });
      return { data: items, count: items.length };
    },
  });

  defineTool(server, ctx, {
    name: "clio_get_matter",
    title: "Get matter",
    description: "Returns full detail for a single matter by id.",
    inputSchema: {
      matter_id: z.number().int().describe("Numeric Clio matter id."),
      fields: z
        .string()
        .optional()
        .describe("Optional comma-separated field list. Default is comprehensive."),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async handler(args, c) {
      return c.client.request(`/matters/${args.matter_id}.json`, {
        fields:
          args.fields ??
          DEFAULT_MATTER_FIELDS +
            ",custom_field_values,custom_fields,relationships,notes,date_created,date_updated",
      });
    },
  });

  defineTool(server, ctx, {
    name: "clio_create_matter",
    title: "Create matter",
    description:
      "Creates a new matter. `client_id` is required. If `flat_rate_amount` is supplied, the matter " +
      "is created and then PATCHed with the `custom_rate` association — which is how Clio actually " +
      "flips `billing_method` to `flat` (the top-level `billing_method` field is silently ignored on " +
      "POST/PATCH; this is a confirmed Clio API quirk).",
    inputSchema: {
      client_id: z.number().int().describe("Numeric id of the client contact this matter belongs to."),
      description: z.string().describe("Matter description / name shown in Clio."),
      display_number: z.string().optional().describe("Custom matter number. If omitted Clio auto-assigns."),
      practice_area_id: z.number().int().optional(),
      status: z.enum(["Open", "Pending", "Closed"]).optional().default("Open"),
      open_date: z.string().optional().describe("YYYY-MM-DD."),
      responsible_attorney_id: z
        .number()
        .int()
        .optional()
        .describe("Falls back to CLIO_DEFAULT_USER_ID if unset."),
      originating_attorney_id: z.number().int().optional(),
      billable: z.boolean().optional(),
      flat_rate_amount: z
        .number()
        .positive()
        .optional()
        .describe(
          "Set a flat fee for the whole matter. The server will POST the matter and then PATCH it " +
            "with a custom_rate association (Clio creates the billable line item automatically).",
        ),
      flat_rate_user_id: z
        .number()
        .int()
        .optional()
        .describe("User the flat rate is attributed to. Defaults to responsible_attorney_id or CLIO_DEFAULT_USER_ID."),
    },
    annotations: { readOnlyHint: false, idempotentHint: false },
    async handler(args, c) {
      const responsible = args.responsible_attorney_id ?? c.cfg.defaultUserId ?? undefined;
      const originating = args.originating_attorney_id ?? responsible;

      interface MatterCreated {
        data: { id: number; display_number?: string };
      }
      const created = await c.client.request<MatterCreated>("/matters.json", {
        method: "POST",
        data: {
          client: { id: args.client_id },
          description: args.description,
          display_number: args.display_number,
          practice_area: args.practice_area_id ? { id: args.practice_area_id } : undefined,
          status: args.status,
          open_date: args.open_date,
          responsible_attorney: responsible ? { id: responsible } : undefined,
          originating_attorney: originating ? { id: originating } : undefined,
          billable: args.billable,
        },
      });

      if (args.flat_rate_amount === undefined) {
        return created;
      }

      const flatUser =
        args.flat_rate_user_id ?? responsible ?? c.cfg.defaultUserId ?? undefined;
      if (!flatUser) {
        throw new Error(
          "flat_rate_amount supplied but no flat_rate_user_id, responsible_attorney_id, " +
            "or CLIO_DEFAULT_USER_ID available to attribute it to.",
        );
      }
      const patched = await c.client.request(`/matters/${created.data.id}.json`, {
        method: "PATCH",
        data: {
          custom_rate: {
            type: "FlatRate",
            rates: [{ user: { id: flatUser }, rate: args.flat_rate_amount }],
          },
        },
      });
      return { create: created, flat_rate_patch: patched };
    },
  });

  defineTool(server, ctx, {
    name: "clio_update_matter",
    title: "Update matter",
    description: "PATCH a matter. Pass only the fields you want to change.",
    inputSchema: {
      matter_id: z.number().int(),
      description: z.string().optional(),
      status: z.enum(["Open", "Pending", "Closed"]).optional(),
      open_date: z.string().optional(),
      close_date: z.string().optional(),
      pending_date: z.string().optional(),
      practice_area_id: z.number().int().optional(),
      responsible_attorney_id: z.number().int().optional(),
      billable: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, idempotentHint: false },
    async handler(args, c) {
      const { matter_id, practice_area_id, responsible_attorney_id, ...rest } = args;
      const data: Record<string, unknown> = { ...rest };
      if (practice_area_id !== undefined) data.practice_area = { id: practice_area_id };
      if (responsible_attorney_id !== undefined) data.responsible_attorney = { id: responsible_attorney_id };
      return c.client.request(`/matters/${matter_id}.json`, { method: "PATCH", data });
    },
  });

  defineTool(server, ctx, {
    name: "clio_delete_matter",
    title: "Delete matter",
    description:
      "Soft-deletes a matter. Disabled unless CLIO_ALLOW_DESTRUCTIVE=true. Returns 204 on success, " +
      "404 if already deleted, 422 if the matter has dependencies (e.g. open bills).",
    inputSchema: { matter_id: z.number().int() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    async handler(args, c) {
      if (!c.cfg.allowDestructive) {
        throw new Error(
          "Destructive operations are disabled. Set CLIO_ALLOW_DESTRUCTIVE=true to enable.",
        );
      }
      await c.client.request(`/matters/${args.matter_id}.json`, { method: "DELETE" });
      return { ok: true, matter_id: args.matter_id };
    },
  });

  defineTool(server, ctx, {
    name: "clio_list_matter_contacts",
    title: "List related contacts on a matter",
    description: "Returns related contacts for the given matter (the client plus any related parties).",
    inputSchema: {
      matter_id: z.number().int(),
      ...paginationShape,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async handler(args, c) {
      const items = await c.client.paginate<unknown>(`/matters/${args.matter_id}/related_contacts.json`, {
        limit: args.limit,
        pageSize: args.page_size,
      });
      return { data: items, count: items.length };
    },
  });
}
