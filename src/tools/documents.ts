import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { defineTool, paginationShape, type ToolContext } from "./_base.js";

const DEFAULT_DOCUMENT_FIELDS =
  "id,name,filename,description,size,content_type,locked,latest_document_version{id,version_number,size,date}," +
  "matter{id,display_number},parent{id,name},category{id,name}";

export function registerDocumentTools(server: McpServer, ctx: ToolContext): void {
  defineTool(server, ctx, {
    name: "clio_list_documents",
    title: "List documents",
    description: "Lists documents in a matter or folder.",
    inputSchema: {
      matter_id: z.number().int().optional(),
      parent_id: z.number().int().optional().describe("Folder id to list contents of."),
      query: z.string().optional().describe("Name-substring search."),
      ...paginationShape,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async handler(args, c) {
      const items = await c.client.paginate<unknown>("documents.json", {
        query: {
          matter_id: args.matter_id,
          parent_id: args.parent_id,
          query: args.query,
        },
        fields: DEFAULT_DOCUMENT_FIELDS,
        limit: args.limit,
        pageSize: args.page_size,
      });
      return { data: items, count: items.length };
    },
  });

  defineTool(server, ctx, {
    name: "clio_get_document",
    title: "Get document",
    description: "Returns document metadata.",
    inputSchema: { document_id: z.number().int() },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async handler(args, c) {
      return c.client.request(`/documents/${args.document_id}.json`, {
        fields:
          DEFAULT_DOCUMENT_FIELDS +
          ",document_versions{id,version_number,size,date,uuid}",
      });
    },
  });

  defineTool(server, ctx, {
    name: "clio_get_document_download_url",
    title: "Get short-lived download URL for a document",
    description:
      "Resolves the GET /documents/{id}/download.json endpoint and returns the redirect target — " +
      "a short-lived signed URL. We do NOT proxy the bytes through the MCP server.",
    inputSchema: { document_id: z.number().int() },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async handler(args, c) {
      // Use raw mode so we can inspect the 303 redirect target without following it.
      const res = (await c.client.request(`/documents/${args.document_id}/download.json`, {
        raw: true,
      })) as Response;
      const location = res.headers.get("location") ?? res.headers.get("Location");
      if (location) {
        return {
          document_id: args.document_id,
          download_url: location,
          note: "URL is short-lived; download promptly.",
        };
      }
      const text = await res.text();
      return { document_id: args.document_id, status: res.status, body: text };
    },
  });

  defineTool(server, ctx, {
    name: "clio_list_folders",
    title: "List folders",
    description: "Lists folders under a parent, or top-level if no parent_id given.",
    inputSchema: {
      parent_id: z.number().int().optional(),
      matter_id: z.number().int().optional(),
      ...paginationShape,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async handler(args, c) {
      const items = await c.client.paginate<unknown>("folders.json", {
        query: { parent_id: args.parent_id, matter_id: args.matter_id },
        fields: "id,name,parent{id,name},matter{id,display_number}",
        limit: args.limit,
        pageSize: args.page_size,
      });
      return { data: items, count: items.length };
    },
  });
}
