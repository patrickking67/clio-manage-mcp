import { appendFile } from "node:fs/promises";

import type { Config } from "./config.js";
import { log } from "./util/logger.js";

/**
 * Append-only JSONL audit log for ABA Formal Opinion 512 compliance.
 *
 * One JSON object per line. Never rotated by this software — use logrotate or
 * Azure Container Apps log streaming if you want retention policy.
 *
 * Audit modes (set via CLIO_AUDIT_MODE):
 *   - none      : disabled entirely (NOT recommended for production)
 *   - metadata  : timestamp, tool, outcome, user_id, matter_id, result_count
 *   - full      : metadata + tool arguments with secrets redacted
 *
 * In `full` mode the redaction policy below strips known sensitive keys.
 * Review and tighten before deploying for a regulated firm — this is the
 * boundary between "useful debug trail" and "PII leak to a log file".
 */

export interface AuditEntry {
  timestamp: string;
  tool: string;
  outcome: "success" | "error";
  duration_ms: number;
  clio_user_id?: number | string;
  matter_id?: number | string;
  result_count?: number;
  args?: unknown;
  error_message?: string;
  transport?: "stdio" | "http";
  caller_id?: string; // for HTTP transport: a hash of the bearer token
}

const SENSITIVE_KEYS = new Set([
  "access_token",
  "refresh_token",
  "client_secret",
  "encryption_key",
  "authorization",
  "password",
  "ssn",
  "social_security_number",
  "tax_id",
  "credit_card",
  "cc_number",
]);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated:depth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (value.length > 2000) return value.slice(0, 2000) + "…[truncated]";
    return value;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

export class AuditLogger {
  constructor(private readonly cfg: Config) {}

  async record(entry: Omit<AuditEntry, "timestamp">): Promise<void> {
    if (this.cfg.auditMode === "none") return;
    const out: AuditEntry = {
      timestamp: new Date().toISOString(),
      ...entry,
    };
    if (this.cfg.auditMode === "metadata") {
      delete out.args;
    } else if (this.cfg.auditMode === "full" && entry.args !== undefined) {
      out.args = redact(entry.args);
    }
    try {
      await appendFile(this.cfg.auditPath, JSON.stringify(out) + "\n", { mode: 0o600 });
    } catch (err) {
      log.error("audit write failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
