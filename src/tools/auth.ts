import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { defineTool, type ToolContext } from "./_base.js";

export function registerAuthTools(server: McpServer, ctx: ToolContext): void {
  defineTool(server, ctx, {
    name: "clio_authenticate",
    title: "Authenticate with Clio",
    description:
      "Starts the OAuth 2.0 authorization-code flow with Clio in the user's default browser, " +
      "then persists the resulting access + refresh tokens (encrypted with AES-256-GCM) to disk. " +
      "Local stdio transport only — HTTP transports must be seeded with tokens out-of-band.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async handler(_args, c) {
      if (c.transport === "http") {
        throw new Error(
          "clio_authenticate is only usable from a local stdio session. " +
            "For HTTP/Azure deployments, perform the OAuth dance once locally and copy the encrypted " +
            "token blob (or the refresh token) into a Key Vault secret. See docs/deployment-azure.md.",
        );
      }
      const tokens = await c.client.authenticate();
      return {
        ok: true,
        clio_user_id: tokens.user_id,
        expires_at: new Date(tokens.expires_at).toISOString(),
        message:
          "Authentication successful. Tokens are stored encrypted at " +
          `${c.cfg.tokensPath}. They auto-refresh ahead of expiry.`,
      };
    },
  });

  defineTool(server, ctx, {
    name: "clio_auth_status",
    title: "Auth status",
    description:
      "Reports whether the server is currently holding valid Clio credentials, the Clio user id " +
      "they were issued to, and when the access token expires.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
    async handler(_args, c) {
      const expiresAt = c.client.tokenExpiresAt();
      return {
        authenticated: c.client.isAuthenticated(),
        clio_user_id: c.client.currentUserId() ?? null,
        expires_at: expiresAt?.toISOString() ?? null,
        region: c.cfg.region,
        api_base: c.cfg.apiBase,
      };
    },
  });

  defineTool(server, ctx, {
    name: "clio_logout",
    title: "Clear stored Clio credentials",
    description:
      "Deletes the encrypted token file. After logout the server cannot make Clio API calls until " +
      "`clio_authenticate` is run again. Does not revoke the token on Clio's side — use Clio's " +
      "Developer Applications screen to fully revoke.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    async handler(_args, c) {
      await c.client.logout();
      return { ok: true, message: "Local tokens cleared." };
    },
  });

  defineTool(server, ctx, {
    name: "clio_who_am_i",
    title: "Identify the active Clio user",
    description:
      "Calls GET /users/who_am_i.json to confirm credentials work and return the current user record.",
    inputSchema: {
      fields: z
        .string()
        .optional()
        .describe(
          "Optional comma-separated list of fields to return. Defaults to a sensible " +
            "subset: id,name,email,enabled,roles.",
        ),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async handler(args, c) {
      return c.client.request("/users/who_am_i.json", {
        fields: args.fields ?? "id,name,first_name,last_name,email,enabled,roles,subscription_type",
      });
    },
  });
}
