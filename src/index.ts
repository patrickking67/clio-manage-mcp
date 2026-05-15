#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { TokenStorage } from "./auth/storage.js";
import { OAuthFlow } from "./auth/oauth.js";
import { ClioClient } from "./clio/client.js";
import { AuditLogger } from "./audit.js";
import { log } from "./util/logger.js";
import { runStdio } from "./transports/stdio.js";
import { runHttp } from "./transports/http.js";
import type { ToolContext } from "./tools/_base.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const storage = new TokenStorage(cfg);
  const oauth = new OAuthFlow(cfg, storage);
  const client = new ClioClient(cfg, storage, oauth);
  await client.init();
  const audit = new AuditLogger(cfg);

  const ctx: ToolContext = {
    cfg,
    client,
    audit,
    transport: cfg.transport,
  };

  if (cfg.transport === "stdio") {
    await runStdio(ctx);
  } else {
    await runHttp(ctx);
  }
}

main().catch((err) => {
  log.error("fatal", { error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
