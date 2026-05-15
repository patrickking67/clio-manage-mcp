import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { defineTool, paginationShape, type ToolContext } from "./_base.js";

const DEFAULT_BILL_FIELDS =
  "id,number,subject,state,status,total,balance,paid,issued_at,due_at,sent_at," +
  "client{id,name},matter{id,display_number}";

interface BillRecord {
  id: number;
  number?: string;
  total?: number;
  balance?: number;
  paid?: number;
  state?: string;
  issued_at?: string;
}

export function registerBillTools(server: McpServer, ctx: ToolContext): void {
  defineTool(server, ctx, {
    name: "clio_list_bills",
    title: "List bills",
    description: "Lists bills with optional filtering by matter, client, state, or issued-date range.",
    inputSchema: {
      matter_id: z.number().int().optional(),
      client_id: z.number().int().optional(),
      state: z
        .enum(["draft", "pending_approval", "awaiting_payment", "paid", "void"])
        .optional(),
      issued_since: z.string().optional().describe("ISO 8601."),
      ...paginationShape,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async handler(args, c) {
      const items = await c.client.paginate<unknown>("bills.json", {
        query: {
          matter_id: args.matter_id,
          client_id: args.client_id,
          state: args.state,
          issued_since: args.issued_since,
        },
        fields: DEFAULT_BILL_FIELDS,
        limit: args.limit,
        pageSize: args.page_size,
      });
      return { data: items, count: items.length };
    },
  });

  defineTool(server, ctx, {
    name: "clio_get_bill",
    title: "Get bill",
    description: "Returns a single bill by id.",
    inputSchema: { bill_id: z.number().int() },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async handler(args, c) {
      return c.client.request(`/bills/${args.bill_id}.json`, {
        fields: DEFAULT_BILL_FIELDS + ",line_items{id,description,total,quantity}",
      });
    },
  });

  defineTool(server, ctx, {
    name: "clio_get_billing_summary",
    title: "Get billing summary for a matter",
    description:
      "Aggregates totals across all bills on a matter: total billed, total paid, outstanding balance, " +
      "and the date of the most-recently-issued bill.",
    inputSchema: { matter_id: z.number().int() },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async handler(args, c) {
      const bills = await c.client.paginate<BillRecord>("bills.json", {
        query: { matter_id: args.matter_id },
        fields: "id,number,total,balance,paid,state,issued_at",
        limit: c.cfg.maxPageSize,
      });
      let totalBilled = 0;
      let totalPaid = 0;
      let outstanding = 0;
      let lastIssuedAt: string | null = null;
      for (const b of bills) {
        totalBilled += Number(b.total ?? 0);
        totalPaid += Number(b.paid ?? 0);
        outstanding += Number(b.balance ?? 0);
        if (b.issued_at && (!lastIssuedAt || b.issued_at > lastIssuedAt)) {
          lastIssuedAt = b.issued_at;
        }
      }
      return {
        matter_id: args.matter_id,
        bill_count: bills.length,
        total_billed: totalBilled,
        total_paid: totalPaid,
        outstanding_balance: outstanding,
        last_issued_at: lastIssuedAt,
      };
    },
  });
}
