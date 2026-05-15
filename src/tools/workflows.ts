import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { defineTool, type ToolContext } from "./_base.js";

/**
 * Workflow tools — composite operations that chain several API calls into a single
 * agent-facing action. Workflows are higher-level than the raw CRUD tools and exist
 * to remove ambiguity in multi-step flows (e.g. "open a new matter for this client").
 *
 * The agent can always compose the raw tools itself; workflows are convenience
 * shortcuts that also let you centralize policy (defaults, audit metadata,
 * required fields) for the operations your firm performs most often.
 */

export function registerWorkflowTools(server: McpServer, ctx: ToolContext): void {
  defineTool(server, ctx, {
    name: "clio_open_new_matter",
    title: "Open a new matter (intake workflow)",
    description:
      "End-to-end intake: creates the client contact (or uses an existing one), opens the matter, " +
      "and optionally seeds an opening note and an intake task. Returns a summary of everything created.",
    inputSchema: {
      // --- client ----
      existing_client_id: z
        .number()
        .int()
        .optional()
        .describe("If the client already exists in Clio, pass their contact id and skip the new_client_* fields."),
      new_client_kind: z.enum(["Person", "Company"]).optional(),
      new_client_first_name: z.string().optional(),
      new_client_last_name: z.string().optional(),
      new_client_company_name: z.string().optional(),
      new_client_email: z.string().email().optional(),
      new_client_phone: z.string().optional(),
      // --- matter ---
      description: z.string().describe("Matter description / name."),
      practice_area_id: z.number().int().optional(),
      responsible_attorney_id: z.number().int().optional(),
      flat_rate_amount: z.number().positive().optional(),
      // --- optional side effects ---
      opening_note_subject: z.string().optional().describe("If supplied, create a note on the new matter."),
      opening_note_detail: z.string().optional(),
      intake_task_name: z.string().optional().describe("If supplied, create a Pending task on the new matter."),
      intake_task_due_at: z.string().optional().describe("ISO 8601 / YYYY-MM-DD."),
    },
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    async handler(args, c) {
      // ------------------------------------------------------------------
      // ★ YOUR TURN (Learning Mode) ★
      //
      // The orchestration below is intentionally minimal. Replace the marked
      // block with the policy YOUR firm wants when opening a new matter. Some
      // examples of decisions you might encode:
      //
      //   - On duplicate detection: should we search clio_search_contacts by
      //     email/phone before creating a new client, and error or merge if
      //     a match is found?
      //   - On partial failure: if the matter creates successfully but the
      //     opening note fails, should we roll back the matter, leave it,
      //     or just report both outcomes?
      //   - On required fields: should certain practice areas require a
      //     specific custom field or task template before proceeding?
      //
      // Write 5–10 lines below that reflect your firm's intake policy.
      // The rest of the tool is wired — your code just has to set
      // `clientId` and (optionally) augment `result`.
      // ------------------------------------------------------------------
      let clientId: number;
      if (args.existing_client_id) {
        clientId = args.existing_client_id;
      } else if (args.new_client_kind === "Company") {
        if (!args.new_client_company_name) throw new Error("new_client_company_name required for Company client.");
        const created = await c.client.request<{ data: { id: number } }>("/contacts.json", {
          method: "POST",
          data: {
            type: "Company",
            name: args.new_client_company_name,
            ...(args.new_client_email
              ? { email_addresses: [{ address: args.new_client_email, default_email: true, name: "Work" }] }
              : {}),
            ...(args.new_client_phone
              ? { phone_numbers: [{ number: args.new_client_phone, default_number: true, name: "Work" }] }
              : {}),
          },
        });
        clientId = created.data.id;
      } else {
        if (!args.new_client_first_name || !args.new_client_last_name) {
          throw new Error("For a Person client supply new_client_first_name and new_client_last_name.");
        }
        const created = await c.client.request<{ data: { id: number } }>("/contacts.json", {
          method: "POST",
          data: {
            type: "Person",
            first_name: args.new_client_first_name,
            last_name: args.new_client_last_name,
            ...(args.new_client_email
              ? { email_addresses: [{ address: args.new_client_email, default_email: true, name: "Work" }] }
              : {}),
            ...(args.new_client_phone
              ? { phone_numbers: [{ number: args.new_client_phone, default_number: true, name: "Work" }] }
              : {}),
          },
        });
        clientId = created.data.id;
      }
      // ------------------------------------------------------------------
      // ★ END YOUR TURN ★
      // ------------------------------------------------------------------

      const responsible = args.responsible_attorney_id ?? c.cfg.defaultUserId ?? undefined;
      const matter = await c.client.request<{ data: { id: number; display_number?: string } }>(
        "/matters.json",
        {
          method: "POST",
          data: {
            client: { id: clientId },
            description: args.description,
            practice_area: args.practice_area_id ? { id: args.practice_area_id } : undefined,
            responsible_attorney: responsible ? { id: responsible } : undefined,
            originating_attorney: responsible ? { id: responsible } : undefined,
            status: "Open",
          },
        },
      );

      const result: Record<string, unknown> = {
        client_id: clientId,
        matter_id: matter.data.id,
        matter_display_number: matter.data.display_number,
      };

      if (args.flat_rate_amount && responsible) {
        result.flat_rate = await c.client.request(`/matters/${matter.data.id}.json`, {
          method: "PATCH",
          data: {
            custom_rate: {
              type: "FlatRate",
              rates: [{ user: { id: responsible }, rate: args.flat_rate_amount }],
            },
          },
        });
      }

      if (args.opening_note_subject && args.opening_note_detail) {
        result.opening_note = await c.client.request("/notes.json", {
          method: "POST",
          data: {
            subject: args.opening_note_subject,
            detail: args.opening_note_detail,
            matter: { id: matter.data.id },
            type: "Matter",
          },
        });
      }

      if (args.intake_task_name) {
        result.intake_task = await c.client.request("/tasks.json", {
          method: "POST",
          data: {
            name: args.intake_task_name,
            due_at: args.intake_task_due_at,
            priority: "Normal",
            matter: { id: matter.data.id },
            assignee: responsible ? { id: responsible, type: "User" } : undefined,
          },
        });
      }

      return result;
    },
  });
}
