import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerAllTools } from "./tools/index.js";
import { registerResources } from "./resources.js";
import type { ToolContext } from "./tools/_base.js";

export const SERVER_NAME = "clio-mcp";
export const SERVER_VERSION = "0.1.0";

/**
 * Build a fresh McpServer instance.
 *
 * For stdio the server lives for the process lifetime; for stateless HTTP
 * we build a new one per request (and close it on response end), so this
 * function is cheap and side-effect-free.
 */
export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });
  registerAllTools(server, ctx);
  registerResources(server, ctx);
  return server;
}
