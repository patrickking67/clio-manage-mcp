import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { defineTool, paginationShape, type ToolContext } from "./_base.js";

const DEFAULT_CALENDAR_FIELDS =
  "id,summary,description,location,start_at,end_at,all_day,calendar{id,name}," +
  "matter{id,display_number},event_type{id,name},attendees{id,name}";

export function registerCalendarTools(server: McpServer, ctx: ToolContext): void {
  defineTool(server, ctx, {
    name: "clio_list_calendar_entries",
    title: "List calendar entries",
    description: "Lists calendar entries within a date range. Use ISO dates (YYYY-MM-DD).",
    inputSchema: {
      from: z.string().describe("Start of range, YYYY-MM-DD (inclusive)."),
      to: z.string().describe("End of range, YYYY-MM-DD (inclusive)."),
      calendar_id: z.number().int().optional(),
      matter_id: z.number().int().optional(),
      ...paginationShape,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async handler(args, c) {
      const items = await c.client.paginate<unknown>("calendar_entries.json", {
        query: {
          from: args.from,
          to: args.to,
          calendar_id: args.calendar_id,
          matter_id: args.matter_id,
        },
        fields: DEFAULT_CALENDAR_FIELDS,
        limit: args.limit,
        pageSize: args.page_size,
      });
      return { data: items, count: items.length };
    },
  });

  defineTool(server, ctx, {
    name: "clio_create_calendar_entry",
    title: "Create calendar entry",
    description: "Creates a calendar entry. All-day events should set all_day=true and use date-only timestamps.",
    inputSchema: {
      summary: z.string().describe("Title shown in calendar."),
      start_at: z.string().describe("ISO 8601 timestamp."),
      end_at: z.string().describe("ISO 8601 timestamp."),
      description: z.string().optional(),
      location: z.string().optional(),
      all_day: z.boolean().optional(),
      calendar_id: z.number().int().optional(),
      matter_id: z.number().int().optional(),
      event_type_id: z.number().int().optional(),
    },
    annotations: { readOnlyHint: false, idempotentHint: false },
    async handler(args, c) {
      return c.client.request("/calendar_entries.json", {
        method: "POST",
        data: {
          summary: args.summary,
          start_at: args.start_at,
          end_at: args.end_at,
          description: args.description,
          location: args.location,
          all_day: args.all_day,
          calendar: args.calendar_id ? { id: args.calendar_id } : undefined,
          matter: args.matter_id ? { id: args.matter_id } : undefined,
          event_type: args.event_type_id ? { id: args.event_type_id } : undefined,
        },
      });
    },
  });

  defineTool(server, ctx, {
    name: "clio_list_calendars",
    title: "List calendars",
    description: "Lists the calendars available to the current user.",
    inputSchema: {
      ...paginationShape,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async handler(args, c) {
      const items = await c.client.paginate<unknown>("calendars.json", {
        fields: "id,name,source,color,visible",
        limit: args.limit,
        pageSize: args.page_size,
      });
      return { data: items, count: items.length };
    },
  });
}
