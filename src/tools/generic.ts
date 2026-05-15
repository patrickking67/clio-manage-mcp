import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { defineTool, type ToolContext } from "./_base.js";

/**
 * Escape hatch for endpoints we haven't modelled as first-class tools.
 *
 * Notes:
 *   - The caller is responsible for the `{ data: ... }` wrapping on mutations
 *     (pass it via `body` if you want it sent as-is, or `data` to have it wrapped).
 *   - DELETE is allow-listed only when CLIO_ALLOW_DESTRUCTIVE=true.
 *   - This is documented in the tool description so the agent treats it as a fallback.
 */
export function registerGenericTool(server: McpServer, ctx: ToolContext): void {
  defineTool(server, ctx, {
    name: "clio_api_request",
    title: "Raw Clio API request (escape hatch)",
    description:
      "Issue an arbitrary request against the Clio v4 API. Prefer the dedicated tools — this exists " +
      "for endpoints not yet wrapped (custom_fields, trust_requests, webhooks, etc.). The path is " +
      "relative to the API root (`/matters.json`, `/users/who_am_i.json`). For POST/PATCH bodies, " +
      "pass `data` and we will wrap it in `{ data: ... }`; pass `body` for already-wrapped JSON.",
    inputSchema: {
      method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]).default("GET"),
      path: z.string().describe('Path relative to /api/v4 — e.g. "/matters.json" or "users/who_am_i.json".'),
      query: z
        .record(z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe("Query string parameters."),
      fields: z.string().optional().describe("Shorthand for query.fields."),
      data: z
        .any()
        .optional()
        .describe("Body content — will be sent as `{ data: <your-value> }` (Clio's required envelope)."),
      body: z
        .any()
        .optional()
        .describe("Raw JSON body (sent verbatim). Use this only if you have already wrapped it yourself."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    async handler(args, c) {
      if (args.method === "DELETE" && !c.cfg.allowDestructive) {
        throw new Error("DELETE via generic tool is disabled. Set CLIO_ALLOW_DESTRUCTIVE=true to enable.");
      }
      return c.client.request(args.path, {
        method: args.method,
        query: args.query,
        fields: args.fields,
        data: args.data,
        body: args.body,
      });
    },
  });
}
