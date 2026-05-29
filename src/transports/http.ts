import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { URL } from "node:url";

import express, {
  type Request,
  type Response,
  type NextFunction,
  type RequestHandler,
} from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";

import { createMcpServer } from "../server.js";
import type { ToolContext } from "../tools/_base.js";
import type { Config } from "../config.js";
import type { AuditLogger } from "../audit.js";
import type { OAuthFlow } from "../auth/oauth.js";
import { ClioClient } from "../clio/client.js";
import { ClioOAuthProvider } from "../auth/clioOAuthProvider.js";
import { SessionStore, sha256Hex } from "../auth/sessionStore.js";
import { SessionTokenProvider } from "../auth/sessionTokenProvider.js";
import { AuthError } from "../util/errors.js";
import { log } from "../util/logger.js";

/**
 * Shared, process-lifetime singletons handed to the HTTP transport. Per-request
 * state (the bound ClioClient + ToolContext) is built inside the request
 * handlers, never stored here.
 */
export interface HttpDeps {
  cfg: Config;
  audit: AuditLogger;
  /** Stateless Clio OAuth helper, shared by every tenant. */
  oauth: OAuthFlow;
  /** Encrypted multi-tenant session/client/pending store. */
  sessions: SessionStore;
  /**
   * The single shared-account client used by static/shared mode (disk or
   * CLIO_BOOTSTRAP_REFRESH_TOKEN). Null when running in pure "oauth" mode.
   */
  sharedClient: ClioClient | null;
}

const SWEEP_INTERVAL_MS = 15 * 60 * 1000; // periodic expiry cleanup

/**
 * Streamable HTTP transport with a remote OAuth 2.1 custom-connector layer.
 *
 * Auth modes (MCP_AUTH_MODE):
 *   - "oauth"  : every /mcp request must carry an MCP session token minted via
 *                the connector OAuth bridge (each user → their own Clio acct).
 *   - "static" : legacy shared static bearer token(s) → one shared Clio acct.
 *   - "hybrid" : accept EITHER (default). A static token maps to the shared
 *                client; an OAuth session token maps to that user's Clio acct.
 *
 * In oauth/hybrid mode PUBLIC_BASE_URL is REQUIRED — the SDK's mcpAuthRouter
 * needs fixed issuer/authorize/token URLs at construction time, and the Clio
 * Developer Application must be configured with a fixed redirect URI. We fail
 * fast at startup if it is missing.
 *
 * Each /mcp POST gets its own McpServer + transport (stateless), so the server
 * scales horizontally with no sticky sessions; all cross-request state lives in
 * the encrypted, file-per-record session store on the shared mount.
 */
export async function runHttp(deps: HttpDeps): Promise<void> {
  const { cfg, audit, oauth, sessions, sharedClient } = deps;
  const oauthEnabled = cfg.mcpAuthMode === "oauth" || cfg.mcpAuthMode === "hybrid";
  const staticEnabled = cfg.mcpAuthMode === "static" || cfg.mcpAuthMode === "hybrid";

  if (oauthEnabled && !cfg.publicBaseUrl) {
    throw new AuthError(
      `MCP_AUTH_MODE="${cfg.mcpAuthMode}" requires PUBLIC_BASE_URL to be set ` +
        "(e.g. https://clio-mcp.example.com). The OAuth Authorization Server " +
        "metadata and the Clio redirect URI must be fixed, absolute URLs. " +
        'Set PUBLIC_BASE_URL, or use MCP_AUTH_MODE="static" for shared-token mode.',
    );
  }

  // Static bearer token digests (constant-time compared against presented tokens).
  const staticDigests = staticEnabled
    ? cfg.httpAuthTokens.map((t) => createHash("sha256").update(t).digest())
    : [];
  if (staticEnabled && !oauthEnabled && staticDigests.length === 0) {
    log.warn(
      "MCP_AUTH_MODE=static but no CLIO_HTTP_AUTH_TOKENS configured — HTTP transport is OPEN. " +
        "Set tokens before exposing this server to the network.",
    );
  }

  const app = express();
  // Behind Azure Container Apps / a reverse proxy: honour X-Forwarded-* so
  // req.protocol/req.hostname reflect the external scheme + host.
  app.set("trust proxy", true);

  // --- OAuth Authorization Server + Protected Resource layer ---------------
  let provider: ClioOAuthProvider | null = null;
  let resourceMetadataUrl: string | undefined;
  if (oauthEnabled) {
    const base = cfg.publicBaseUrl as string;
    const issuerUrl = new URL(base);
    const resourceServerUrl = new URL(`${base}/mcp`);
    provider = new ClioOAuthProvider(cfg, oauth, sessions, base);
    resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);

    // Mounts: /authorize /token /register /revoke and the two .well-known docs.
    app.use(
      mcpAuthRouter({
        provider,
        issuerUrl,
        baseUrl: issuerUrl,
        resourceServerUrl,
        scopesSupported: [],
        resourceName: "Clio MCP",
      }),
    );

    // Clio's redirect target — OUTSIDE the SDK router. Completes the bridge.
    app.get("/oauth/clio/callback", clioCallbackHandler(deps, provider));
  }

  // --- Health + readiness probes -------------------------------------------
  // Liveness: always 200 so the orchestrator does not kill a healthy process
  // that simply has no shared-account credentials yet (OAuth mode is per-user).
  app.get("/healthz", (_req, res) => {
    res.json({
      status: "ok",
      server: "clio-mcp",
      auth_mode: cfg.mcpAuthMode,
      region: cfg.region,
    });
  });

  // Readiness: in static/shared mode we are only ready with shared creds; in
  // pure OAuth mode readiness is independent of any single account.
  app.get("/readyz", (_req, res) => {
    if (cfg.mcpAuthMode === "oauth") {
      res.json({ status: "ready" });
      return;
    }
    if (sharedClient?.isAuthenticated()) {
      res.json({ status: "ready" });
      return;
    }
    res.status(503).json({ status: "not_authenticated" });
  });

  // --- /mcp authentication --------------------------------------------------
  // In hybrid mode we try the static token first (cheap, no async); if it does
  // not match we fall through to the SDK's bearer verifier (OAuth sessions),
  // which also emits the RFC 9728 WWW-Authenticate challenge for unknown tokens.
  const bearer: RequestHandler | null = oauthEnabled
    ? requireBearerAuth({
        verifier: provider as ClioOAuthProvider,
        ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
      })
    : null;

  const authMcp: RequestHandler = (req, res, next) => {
    const presented = parseBearer(req);

    // Static / shared bearer token path.
    if (staticEnabled && presented && matchesStatic(presented, staticDigests)) {
      (req as McpRequest).clioSource = { kind: "static" };
      next();
      return;
    }

    // OAuth session-token path (delegated to the SDK verifier).
    if (oauthEnabled && bearer) {
      bearer(req, res, next);
      return;
    }

    // Static-only mode with no/!matching token.
    if (staticEnabled && staticDigests.length === 0) {
      // Open mode (already warned at startup).
      (req as McpRequest).clioSource = { kind: "static" };
      next();
      return;
    }
    res.status(401).json({ error: "invalid bearer token" });
  };

  // Stateless MCP endpoint — one server + transport per request.
  app.post("/mcp", express.json({ limit: "4mb" }), authMcp, async (req, res) => {
    const requestId = randomUUID();
    try {
      const { client, callerId } = await resolveClient(req as McpRequest, deps);
      const requestCtx: ToolContext = {
        cfg,
        audit,
        client,
        transport: "http",
        ...(callerId ? { callerId } : {}),
      };

      const server = createMcpServer(requestCtx);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      });
      res.on("close", () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error("mcp handler crashed", {
        request_id: requestId,
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "internal server error" },
          id: null,
        });
      }
    }
  });

  // Streamable HTTP stateless mode is POST-only; GET/DELETE are for SSE/session
  // resumption which we do not support.
  app.get("/mcp", (_req, res) => {
    res.status(405).json({ error: "method not allowed; this server is stateless POST-only" });
  });
  app.delete("/mcp", (_req, res) => {
    res.status(405).json({ error: "method not allowed; this server is stateless POST-only" });
  });

  // Periodic best-effort cleanup of expired sessions + pending records.
  const sweepTimer = setInterval(() => {
    sessions.sweep().catch((err) =>
      log.warn("session sweep failed", {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  await new Promise<void>((resolve) => {
    app.listen(cfg.httpPort, cfg.httpHost, () => {
      log.info("clio-mcp listening on HTTP", {
        host: cfg.httpHost,
        port: cfg.httpPort,
        region: cfg.region,
        auth_mode: cfg.mcpAuthMode,
        public_base_url: cfg.publicBaseUrl ?? "(per-request)",
        oauth_enabled: oauthEnabled,
        static_tokens: staticDigests.length,
        clio_redirect_uri: provider ? provider.clioRedirectUri() : "(n/a)",
      });
      resolve();
    });
  });
}

// --- request typing ---------------------------------------------------------

/** Marker attached to a request describing which Clio account it maps to. */
type ClioSource = { kind: "static" } | { kind: "session"; sessionId: string };

interface McpRequest extends Request {
  clioSource?: ClioSource;
}

// --- helpers ----------------------------------------------------------------

function parseBearer(req: Request): string | null {
  const header = req.header("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

function matchesStatic(presented: string, digests: Buffer[]): boolean {
  if (digests.length === 0) return false;
  const digest = createHash("sha256").update(presented).digest();
  return digests.some(
    (accept) => accept.length === digest.length && timingSafeEqual(accept, digest),
  );
}

/**
 * Build the per-request ClioClient + caller fingerprint from the authenticated
 * request. OAuth sessions get a fresh session-bound client; static tokens reuse
 * the shared client.
 */
async function resolveClient(
  req: McpRequest,
  deps: HttpDeps,
): Promise<{ client: ClioClient; callerId?: string }> {
  // OAuth session: req.auth was populated by requireBearerAuth.
  const auth = req.auth;
  if (auth?.extra && typeof auth.extra.sessionId === "string") {
    const sessionId = auth.extra.sessionId;
    const session = await deps.sessions.getSessionByAccessToken(auth.token);
    if (!session) {
      throw new AuthError("session not found or expired");
    }
    const provider = new SessionTokenProvider(deps.sessions, sessionId, session.clioTokens);
    const client = new ClioClient(deps.cfg, deps.oauth, provider);
    // Fingerprint the user without leaking the token: prefer the Clio user id.
    const callerId =
      session.clioTokens.user_id !== undefined
        ? `clio:${session.clioTokens.user_id}`
        : `sess:${sessionId.slice(0, 12)}`;
    return { client, callerId };
  }

  // Static / shared.
  if (req.clioSource?.kind === "static" && deps.sharedClient) {
    const presented = parseBearer(req);
    const callerId = presented ? sha256Hex(presented).slice(0, 12) : "static";
    return { client: deps.sharedClient, callerId };
  }

  // Should be unreachable: authMcp gates this. Defensive fallback.
  throw new AuthError("no Clio credentials resolved for request");
}

/**
 * Express handler for `GET /oauth/clio/callback` — the Clio Developer
 * Application redirect target. Completes the bridge:
 *   - look up the txn by Clio's `state`;
 *   - exchange Clio's `code` for Clio tokens;
 *   - mint an MCP authorization code bound to those tokens + the client PKCE;
 *   - 302 back to the client's redirect URI with our code + their state.
 *
 * Errors are surfaced to the originating client redirect where possible (so
 * Claude shows a clean failure), otherwise as a plain 400.
 */
function clioCallbackHandler(deps: HttpDeps, provider: ClioOAuthProvider): RequestHandler {
  return async (req: Request, res: Response, _next: NextFunction) => {
    const code = typeof req.query.code === "string" ? req.query.code : null;
    const state = typeof req.query.state === "string" ? req.query.state : null;
    const clioError = typeof req.query.error === "string" ? req.query.error : null;

    if (!state) {
      res.status(400).send(htmlError("Missing state from Clio callback."));
      return;
    }

    const txn = await deps.sessions.consumeTxn(state);
    if (!txn) {
      res.status(400).send(htmlError("Authorization session expired or was already used."));
      return;
    }

    // Build the client redirect; we report errors back through it.
    const clientRedirect = new URL(txn.clientRedirectUri);
    if (txn.clientState !== undefined) clientRedirect.searchParams.set("state", txn.clientState);

    if (clioError) {
      clientRedirect.searchParams.set("error", "access_denied");
      clientRedirect.searchParams.set("error_description", `Clio: ${clioError}`);
      res.redirect(302, clientRedirect.toString());
      return;
    }
    if (!code) {
      clientRedirect.searchParams.set("error", "invalid_request");
      clientRedirect.searchParams.set("error_description", "Clio did not return an authorization code");
      res.redirect(302, clientRedirect.toString());
      return;
    }

    try {
      const clioTokens = await deps.oauth.exchangeCodeForTokens(code, provider.clioRedirectUri());
      const mcpCode = await deps.sessions.createAuthCode({
        clioTokens,
        codeChallenge: txn.codeChallenge,
        clientId: txn.clientId,
        clientRedirectUri: txn.clientRedirectUri,
        ...(txn.resource !== undefined ? { resource: txn.resource } : {}),
      });
      clientRedirect.searchParams.set("code", mcpCode);
      log.info("completed Clio bridge; redirecting to client", {
        client_id: txn.clientId,
        clio_user_id: clioTokens.user_id,
      });
      res.redirect(302, clientRedirect.toString());
    } catch (err) {
      log.error("Clio code exchange failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      clientRedirect.searchParams.set("error", "server_error");
      clientRedirect.searchParams.set(
        "error_description",
        "Failed to exchange the Clio authorization code",
      );
      res.redirect(302, clientRedirect.toString());
    }
  };
}

function htmlError(message: string): string {
  const safe = message.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>Clio MCP — sign-in error</title>` +
    `<style>body{font-family:system-ui;margin:3rem;max-width:36rem}h1{color:#c00}</style></head>` +
    `<body><h1>Sign-in failed</h1><p>${safe}</p>` +
    `<p>Return to your MCP client and try connecting again.</p></body></html>`
  );
}
