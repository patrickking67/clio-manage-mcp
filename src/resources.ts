import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ToolContext } from "./tools/_base.js";

/**
 * MCP resources surfaced by the server. Compatible clients (Claude Desktop, etc.)
 * may auto-include these in the model's working context at session start.
 */
export function registerResources(server: McpServer, ctx: ToolContext): void {
  server.registerResource(
    "compliance-notice",
    "clio://compliance/notice",
    {
      title: "Clio MCP — compliance notice",
      description: "ABA Opinion 512 reminder and an audit-logging summary.",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [
        {
          uri: "clio://compliance/notice",
          mimeType: "text/markdown",
          text: COMPLIANCE_TEXT,
        },
      ],
    }),
  );

  server.registerResource(
    "auth-status",
    "clio://auth/status",
    {
      title: "Clio authentication status",
      description: "Live view of whether the server holds valid Clio credentials.",
      mimeType: "application/json",
    },
    async () => {
      const expires = ctx.client.tokenExpiresAt();
      const body = {
        authenticated: ctx.client.isAuthenticated(),
        clio_user_id: ctx.client.currentUserId() ?? null,
        expires_at: expires?.toISOString() ?? null,
        minutes_until_expiry: expires ? Math.round((expires.getTime() - Date.now()) / 60000) : null,
        region: ctx.cfg.region,
        api_base: ctx.cfg.apiBase,
        audit_mode: ctx.cfg.auditMode,
        allow_destructive: ctx.cfg.allowDestructive,
      };
      return {
        contents: [
          {
            uri: "clio://auth/status",
            mimeType: "application/json",
            text: JSON.stringify(body, null, 2),
          },
        ],
      };
    },
  );
}

const COMPLIANCE_TEXT = `# Clio MCP — compliance notice

This connector accesses live data from Clio Manage on the user's behalf. Per
ABA Formal Opinion 512:

- **Confidentiality.** Tool results may include client matter information.
  Treat outputs as protected. Do not paste them into chats outside the
  user's authorized AI workflow.
- **Competence and supervision.** AI-drafted content (notes, tasks, summaries)
  must be reviewed by a responsible attorney before it is acted upon.
- **Audit trail.** Every tool call is appended to the local audit log
  (path: see CLIO_STATE_DIR). The log is append-only and is the firm's
  record of AI-initiated data access. Retention is the firm's responsibility.

If the user appears to be requesting something that could constitute the
unauthorized practice of law, or that bypasses attorney review, decline and
surface the concern.
`;
