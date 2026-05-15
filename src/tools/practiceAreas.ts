import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { defineTool, paginationShape, type ToolContext } from "./_base.js";

export function registerPracticeAreaTools(server: McpServer, ctx: ToolContext): void {
  defineTool(server, ctx, {
    name: "clio_list_practice_areas",
    title: "List practice areas",
    description: "Lists practice areas configured on the firm.",
    inputSchema: { ...paginationShape },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async handler(args, c) {
      const items = await c.client.paginate<unknown>("practice_areas.json", {
        fields: "id,name,category",
        limit: args.limit,
        pageSize: args.page_size,
      });
      return { data: items, count: items.length };
    },
  });
}
