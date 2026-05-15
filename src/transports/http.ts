import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import express, { type Request, type Response, type NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createMcpServer } from "../server.js";
import type { ToolContext } from "../tools/_base.js";
import { log } from "../util/logger.js";

/**
 * Stateless Streamable HTTP transport.
 *
 * Each /mcp request gets its own McpServer + transport pair — no session state
 * is kept between requests. This is the simplest model to scale horizontally
 * on Azure Container Apps (no sticky sessions, no shared in-memory state).
 *
 * Authentication is bearer-token. Tokens are configured at deploy time via
 * CLIO_HTTP_AUTH_TOKENS (comma-separated) — in Azure these come from Key Vault.
 * We compare with timingSafeEqual on a SHA-256 digest to avoid leaking length
 * differences via a string-equality timing side channel.
 */
export async function runHttp(ctx: ToolContext): Promise<void> {
  const { cfg } = ctx;

  if (cfg.httpAuthTokens.length === 0) {
    log.warn(
      "no CLIO_HTTP_AUTH_TOKENS configured — HTTP transport is OPEN. Set tokens before exposing this server to the network.",
    );
  }
  const acceptDigests = cfg.httpAuthTokens.map((t) =>
    createHash("sha256").update(t).digest(),
  );

  const app = express();
  app.use(express.json({ limit: "4mb" }));

  // Health probe for Azure Container Apps / Kubernetes / load balancers.
  app.get("/healthz", (_req, res) => {
    res.json({
      status: "ok",
      server: "clio-mcp",
      authenticated: ctx.client.isAuthenticated(),
      region: cfg.region,
    });
  });

  // Readiness — only OK once we have Clio credentials.
  app.get("/readyz", (_req, res) => {
    if (ctx.client.isAuthenticated()) {
      res.json({ status: "ready" });
    } else {
      res.status(503).json({ status: "not_authenticated" });
    }
  });

  app.use("/mcp", (req: Request, res: Response, next: NextFunction) => {
    if (acceptDigests.length === 0) return next();
    const header = req.header("authorization") ?? "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    const presented = match?.[1]?.trim();
    if (!presented) {
      res.status(401).json({ error: "missing bearer token" });
      return;
    }
    const digest = createHash("sha256").update(presented).digest();
    const ok = acceptDigests.some(
      (accept) => accept.length === digest.length && timingSafeEqual(accept, digest),
    );
    if (!ok) {
      res.status(401).json({ error: "invalid bearer token" });
      return;
    }
    (req as Request & { callerId: string }).callerId = digest.subarray(0, 6).toString("hex");
    next();
  });

  // Stateless MCP endpoint — one server + transport per request.
  app.post("/mcp", async (req, res) => {
    const callerId = (req as Request & { callerId?: string }).callerId;
    const requestCtx: ToolContext = callerId ? { ...ctx, callerId } : ctx;
    const requestId = randomUUID();
    try {
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

  // The Streamable HTTP spec uses POST exclusively for stateless mode; GET/DELETE
  // are reserved for SSE/session resumption which we don't support here.
  app.get("/mcp", (_req, res) => {
    res.status(405).json({ error: "method not allowed; this server is stateless POST-only" });
  });
  app.delete("/mcp", (_req, res) => {
    res.status(405).json({ error: "method not allowed; this server is stateless POST-only" });
  });

  await new Promise<void>((resolve) => {
    app.listen(cfg.httpPort, cfg.httpHost, () => {
      log.info("clio-mcp listening on HTTP", {
        host: cfg.httpHost,
        port: cfg.httpPort,
        region: cfg.region,
        auth_required: acceptDigests.length > 0,
      });
      resolve();
    });
  });
}
