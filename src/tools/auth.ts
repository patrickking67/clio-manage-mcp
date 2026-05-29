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
      "LOCAL STDIO TRANSPORT ONLY. On a remote/HTTP deployment (the Clio custom connector), each " +
      "end user authenticates through the connector's own OAuth sign-in — Claude drives that flow " +
      "when you add the connector — so this tool is unavailable there and is not needed.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async handler(_args, c) {
      if (c.transport === "http") {
        throw new Error(
          "clio_authenticate is only usable from a local stdio session. " +
            "On the remote connector, authentication is per-user via the connector's OAuth sign-in " +
            "(Claude opens the Clio login when you add the connector); there is nothing to run here. " +
            "For static/shared HTTP mode, seed CLIO_BOOTSTRAP_REFRESH_TOKEN at deploy time.",
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
      "Reports whether valid Clio credentials are currently available, the Clio user id they were " +
      "issued to, and when the access token expires. On the remote connector this reflects YOUR " +
      "own per-user session (established via the connector's OAuth sign-in); on local stdio and " +
      "static/shared HTTP mode it reflects the single shared account.",
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
        auth_mode: c.transport === "http" ? "connector-oauth-or-shared" : "stdio-shared",
      };
    },
  });

  defineTool(server, ctx, {
    name: "clio_logout",
    title: "Clear stored Clio credentials",
    description:
      "Deletes the encrypted token file for the shared account (local stdio / static HTTP mode). " +
      "Does not revoke the token on Clio's side — use Clio's Developer Applications screen to fully " +
      "revoke. On the remote connector, per-user sessions are not cleared by this tool; disconnect " +
      "the connector in Claude (or revoke the app in Clio) to end a session.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    async handler(_args, c) {
      if (c.transport === "http" && c.callerId?.startsWith("clio:")) {
        return {
          ok: false,
          message:
            "This is a per-user connector session. Disconnect the connector in Claude, or revoke " +
            "the application under Clio Settings → Developer Applications, to end it.",
        };
      }
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
