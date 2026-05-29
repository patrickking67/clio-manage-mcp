#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { TokenStorage } from "./auth/storage.js";
import { OAuthFlow } from "./auth/oauth.js";
import { ClioClient, DiskTokenProvider } from "./clio/client.js";
import { SessionStore } from "./auth/sessionStore.js";
import { AuditLogger } from "./audit.js";
import { log } from "./util/logger.js";
import { runStdio } from "./transports/stdio.js";
import { runHttp } from "./transports/http.js";
import type { ToolContext } from "./tools/_base.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const storage = new TokenStorage(cfg);
  // The OAuthFlow is stateless (no persistence side effects) and shared across
  // every tenant — both the shared disk account and per-user OAuth sessions.
  const oauth = new OAuthFlow(cfg, storage);
  const audit = new AuditLogger(cfg);

  // The shared single-account client (disk / bootstrap refresh token). Used by
  // stdio and by static/shared HTTP mode. Construction is cheap; init() loads
  // the encrypted blob (and bootstraps from CLIO_BOOTSTRAP_REFRESH_TOKEN).
  const sharedClient = new ClioClient(cfg, oauth, new DiskTokenProvider(storage));
  await sharedClient.init();

  if (cfg.transport === "stdio") {
    // stdio is single-tenant and behaves exactly as before: one process, one
    // shared Clio account, the `clio_authenticate` tool drives the login.
    const ctx: ToolContext = {
      cfg,
      audit,
      client: sharedClient,
      transport: "stdio",
    };
    await runStdio(ctx);
    return;
  }

  // HTTP: build the multi-tenant session store and hand the shared singletons
  // to the transport, which builds a per-request ClioClient + ToolContext.
  const sessions = new SessionStore(cfg);
  await runHttp({
    cfg,
    audit,
    oauth,
    sessions,
    // In pure "oauth" mode there is no shared account; static/hybrid keep it.
    sharedClient: cfg.mcpAuthMode === "oauth" ? null : sharedClient,
  });
}

main().catch((err) => {
  log.error("fatal", { error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
