import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { defineTool, paginationShape, type ToolContext } from "./_base.js";

const DEFAULT_TASK_FIELDS =
  "id,name,description,priority,status,due_at,completed_at,assignee{id,name}," +
  "matter{id,display_number},task_type{id,name}";

export function registerTaskTools(server: McpServer, ctx: ToolContext): void {
  defineTool(server, ctx, {
    name: "clio_list_tasks",
    title: "List tasks",
    description: "Lists tasks with optional filters by matter, status, priority, due date range, and assignee.",
    inputSchema: {
      matter_id: z.number().int().optional(),
      assignee_id: z.number().int().optional(),
      status: z.enum(["Pending", "Complete"]).optional(),
      priority: z.enum(["High", "Normal", "Low"]).optional(),
      due_date_start: z.string().optional().describe("YYYY-MM-DD."),
      due_date_end: z.string().optional().describe("YYYY-MM-DD."),
      ...paginationShape,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async handler(args, c) {
      const items = await c.client.paginate<unknown>("tasks.json", {
        query: {
          matter_id: args.matter_id,
          assignee_id: args.assignee_id,
          status: args.status,
          priority: args.priority,
          due_date_start: args.due_date_start,
          due_date_end: args.due_date_end,
        },
        fields: DEFAULT_TASK_FIELDS,
        limit: args.limit,
        pageSize: args.page_size,
      });
      return { data: items, count: items.length };
    },
  });

  defineTool(server, ctx, {
    name: "clio_get_task",
    title: "Get task",
    description: "Returns a single task by id.",
    inputSchema: { task_id: z.number().int() },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async handler(args, c) {
      return c.client.request(`/tasks/${args.task_id}.json`, { fields: DEFAULT_TASK_FIELDS });
    },
  });

  defineTool(server, ctx, {
    name: "clio_create_task",
    title: "Create task",
    description: "Creates a task. Optionally scoped to a matter and/or assignee.",
    inputSchema: {
      name: z.string(),
      matter_id: z.number().int().optional(),
      description: z.string().optional(),
      priority: z.enum(["High", "Normal", "Low"]).optional().default("Normal"),
      due_at: z.string().optional().describe("ISO 8601 timestamp or YYYY-MM-DD."),
      assignee_id: z.number().int().optional().describe("Defaults to CLIO_DEFAULT_USER_ID."),
      task_type_id: z.number().int().optional(),
    },
    annotations: { readOnlyHint: false, idempotentHint: false },
    async handler(args, c) {
      const assigneeId = args.assignee_id ?? c.cfg.defaultUserId ?? undefined;
      return c.client.request("/tasks.json", {
        method: "POST",
        data: {
          name: args.name,
          description: args.description,
          priority: args.priority,
          due_at: args.due_at,
          matter: args.matter_id ? { id: args.matter_id } : undefined,
          assignee: assigneeId ? { id: assigneeId, type: "User" } : undefined,
          task_type: args.task_type_id ? { id: args.task_type_id } : undefined,
        },
      });
    },
  });

  defineTool(server, ctx, {
    name: "clio_update_task",
    title: "Update task",
    description: "PATCH a task. Common use: mark complete by setting status=Complete.",
    inputSchema: {
      task_id: z.number().int(),
      name: z.string().optional(),
      description: z.string().optional(),
      priority: z.enum(["High", "Normal", "Low"]).optional(),
      due_at: z.string().optional(),
      status: z.enum(["Pending", "Complete"]).optional(),
      assignee_id: z.number().int().optional(),
    },
    annotations: { readOnlyHint: false, idempotentHint: false },
    async handler(args, c) {
      const { task_id, assignee_id, ...rest } = args;
      const data: Record<string, unknown> = { ...rest };
      if (assignee_id !== undefined) data.assignee = { id: assignee_id, type: "User" };
      return c.client.request(`/tasks/${task_id}.json`, { method: "PATCH", data });
    },
  });
}
