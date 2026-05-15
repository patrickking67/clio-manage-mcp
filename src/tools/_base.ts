import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ZodRawShape, z } from "zod";

import type { ClioClient } from "../clio/client.js";
import type { AuditLogger } from "../audit.js";
import type { Config } from "../config.js";
import { describeError } from "../util/errors.js";
import { log } from "../util/logger.js";

export interface ToolContext {
  client: ClioClient;
  audit: AuditLogger;
  cfg: Config;
  /** Transport identifier — recorded in the audit log. */
  transport: "stdio" | "http";
  /** Per-request caller hash for HTTP transport (token fingerprint). */
  callerId?: string;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDef<Shape extends ZodRawShape> {
  name: string;
  title?: string;
  description: string;
  inputSchema: Shape;
  annotations?: ToolAnnotations;
  /** Handler returns a JS value — we serialise it to JSON text content. */
  handler(args: z.objectOutputType<Shape, z.ZodTypeAny>, ctx: ToolContext): Promise<unknown>;
}

/**
 * Register a tool with consistent audit logging and error handling.
 *
 * Returning a non-object result is fine; we always wrap into a JSON text block.
 */
export function defineTool<Shape extends ZodRawShape>(
  server: McpServer,
  ctx: ToolContext,
  def: ToolDef<Shape>,
): void {
  const handler = async (raw: unknown) => {
      const started = Date.now();
      const args = raw as z.objectOutputType<Shape, z.ZodTypeAny>;
      const matterId = pickMatterId(args);
      try {
        const result = await def.handler(args, ctx);
        const resultCount = Array.isArray((result as { data?: unknown[] })?.data)
          ? (result as { data: unknown[] }).data.length
          : Array.isArray(result)
            ? (result as unknown[]).length
            : undefined;
        await ctx.audit.record({
          tool: def.name,
          outcome: "success",
          duration_ms: Date.now() - started,
          clio_user_id: ctx.client.currentUserId(),
          matter_id: matterId,
          result_count: resultCount,
          args,
          transport: ctx.transport,
          caller_id: ctx.callerId,
        });
        return {
          content: [
            {
              type: "text",
              text: stringify(result),
            },
          ],
          structuredContent: isPlainObject(result) ? (result as Record<string, unknown>) : undefined,
        };
      } catch (err) {
        const message = describeError(err);
        await ctx.audit.record({
          tool: def.name,
          outcome: "error",
          duration_ms: Date.now() - started,
          clio_user_id: ctx.client.currentUserId(),
          matter_id: matterId,
          args,
          error_message: message,
          transport: ctx.transport,
          caller_id: ctx.callerId,
        });
        log.error("tool error", { tool: def.name, error: message });
        return {
          isError: true,
          content: [{ type: "text", text: message }],
        };
      }
    };

  // The SDK's BaseToolCallback type is tied to a concrete inputSchema generic;
  // we erase the generic with a cast so this helper can stay schema-agnostic.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.registerTool(
    def.name,
    {
      title: def.title ?? def.name,
      description: def.description,
      inputSchema: def.inputSchema,
      ...(def.annotations ? { annotations: def.annotations } : {}),
    } as never,
    handler as never,
  );
}

function pickMatterId(args: unknown): string | number | undefined {
  if (!args || typeof args !== "object") return undefined;
  const a = args as Record<string, unknown>;
  const v = a.matter_id ?? a.matterId;
  if (typeof v === "string" || typeof v === "number") return v;
  return undefined;
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Common pagination params re-used across list tools. */
export const paginationShape = {
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max records to return across all pages. Capped by CLIO_MAX_PAGE_SIZE."),
  page_size: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe("Records per Clio API page (default from CLIO_DEFAULT_PAGE_SIZE)."),
};
