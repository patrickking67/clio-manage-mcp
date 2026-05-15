import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { defineTool, paginationShape, type ToolContext } from "./_base.js";

export function registerUserTools(server: McpServer, ctx: ToolContext): void {
  defineTool(server, ctx, {
    name: "clio_list_users",
    title: "List users",
    description: "Lists firm users.",
    inputSchema: {
      enabled: z.boolean().optional(),
      ...paginationShape,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async handler(args, c) {
      const items = await c.client.paginate<unknown>("users.json", {
        query: { enabled: args.enabled },
        fields: "id,name,first_name,last_name,email,enabled,subscription_type,roles",
        limit: args.limit,
        pageSize: args.page_size,
      });
      return { data: items, count: items.length };
    },
  });

  defineTool(server, ctx, {
    name: "clio_get_user",
    title: "Get user",
    description: "Returns a single user by id.",
    inputSchema: { user_id: z.number().int() },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async handler(args, c) {
      return c.client.request(`/users/${args.user_id}.json`, {
        fields: "id,name,first_name,last_name,email,enabled,subscription_type,roles",
      });
    },
  });
}
