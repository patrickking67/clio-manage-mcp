import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createMcpServer } from "../server.js";
import type { ToolContext } from "../tools/_base.js";
import { log } from "../util/logger.js";

export async function runStdio(ctx: ToolContext): Promise<void> {
  const server = createMcpServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("clio-mcp listening on stdio", {
    region: ctx.cfg.region,
    audit_mode: ctx.cfg.auditMode,
    state_dir: ctx.cfg.stateDir,
  });
}
