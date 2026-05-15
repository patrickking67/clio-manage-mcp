/**
 * Stderr-only logger.
 *
 * The MCP stdio transport speaks JSON-RPC on stdout — any stray stdout write
 * corrupts the protocol stream. All log output therefore goes to stderr.
 */

type Level = "error" | "warn" | "info" | "debug";

const LEVELS: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };

const envLevel = (process.env.LOG_LEVEL ?? "info").toLowerCase() as Level;
const threshold = LEVELS[envLevel] ?? LEVELS.info;

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (LEVELS[level] > threshold) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(meta ?? {}),
  };
  process.stderr.write(JSON.stringify(line) + "\n");
}

export const log = {
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  debug: (msg: string, meta?: Record<string, unknown>) => emit("debug", msg, meta),
};
