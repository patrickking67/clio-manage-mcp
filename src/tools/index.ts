import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ToolContext } from "./_base.js";
import { registerAuthTools } from "./auth.js";
import { registerMatterTools } from "./matters.js";
import { registerContactTools } from "./contacts.js";
import { registerActivityTools } from "./activities.js";
import { registerTaskTools } from "./tasks.js";
import { registerNoteTools } from "./notes.js";
import { registerCalendarTools } from "./calendar.js";
import { registerDocumentTools } from "./documents.js";
import { registerBillTools } from "./bills.js";
import { registerUserTools } from "./users.js";
import { registerPracticeAreaTools } from "./practiceAreas.js";
import { registerGenericTool } from "./generic.js";
import { registerWorkflowTools } from "./workflows.js";

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  registerAuthTools(server, ctx);
  registerMatterTools(server, ctx);
  registerContactTools(server, ctx);
  registerActivityTools(server, ctx);
  registerTaskTools(server, ctx);
  registerNoteTools(server, ctx);
  registerCalendarTools(server, ctx);
  registerDocumentTools(server, ctx);
  registerBillTools(server, ctx);
  registerUserTools(server, ctx);
  registerPracticeAreaTools(server, ctx);
  registerWorkflowTools(server, ctx);
  registerGenericTool(server, ctx);
}
