import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { config as loadDotenv } from "dotenv";

loadDotenv();

export type Region = "us" | "ca" | "eu" | "au";

const REGION_HOSTS: Record<Region, string> = {
  us: "app.clio.com",
  ca: "ca.app.clio.com",
  eu: "eu.app.clio.com",
  au: "au.app.clio.com",
};

export type AuditMode = "none" | "metadata" | "full";
export type Transport = "stdio" | "http";

/**
 * How the HTTP transport authenticates MCP clients.
 *
 *   - "oauth"  : remote OAuth 2.1 custom-connector flow only. Each end user
 *                bridges to their OWN Clio account. Requires PUBLIC_BASE_URL.
 *   - "static" : legacy shared static bearer token(s) only, mapped to a single
 *                shared Clio account (disk/bootstrap). No PUBLIC_BASE_URL needed.
 *   - "hybrid" : accept EITHER an OAuth-issued session token OR a configured
 *                static bearer token (default). Requires PUBLIC_BASE_URL.
 */
export type McpAuthMode = "oauth" | "static" | "hybrid";

export interface Config {
  clientId: string;
  clientSecret: string;
  region: Region;
  apiBase: string;
  authorizeUrl: string;
  tokenUrl: string;
  encryptionKeyHex: string;
  redirectHost: string;
  redirectPort: number;
  transport: Transport;
  httpPort: number;
  httpHost: string;
  httpAuthTokens: string[];
  stateDir: string;
  tokensPath: string;
  auditPath: string;
  auditMode: AuditMode;
  allowDestructive: boolean;
  defaultPageSize: number;
  maxPageSize: number;
  defaultUserId: number | null;
  /**
   * One-shot bootstrap. If no encrypted token blob exists on disk at startup
   * and this is set, the client refreshes once against this token and writes
   * the resulting encrypted blob. Used for headless/Azure deployments where
   * the loopback OAuth flow cannot run.
   */
  bootstrapRefreshToken: string | null;
  /**
   * Public, externally-reachable base URL of this server (no trailing slash),
   * e.g. "https://clio-mcp.example.com". Used to build the OAuth issuer,
   * authorize/token/registration endpoints and the Clio redirect URI. Required
   * when mcpAuthMode is "oauth" or "hybrid" (the SDK's mcpAuthRouter needs
   * fixed URLs at construction time). Null when unset.
   */
  publicBaseUrl: string | null;
  /** HTTP client authentication mode. Default "hybrid". */
  mcpAuthMode: McpAuthMode;
  /** Lifetime of an issued MCP session (access token) in seconds. Default 30 days. */
  mcpSessionTtlSeconds: number;
  /**
   * Optional space-separated Clio OAuth scopes. Only appended to the Clio
   * authorize URL when set (Clio grants full access by default if omitted).
   */
  clioOAuthScopes: string | null;
}

class ConfigError extends Error {}

function req(name: string, val: string | undefined): string {
  if (!val || val.trim() === "") {
    throw new ConfigError(`Missing required env var: ${name}`);
  }
  return val;
}

function optInt(name: string, val: string | undefined, fallback: number): number {
  if (val === undefined || val === "") return fallback;
  const n = Number.parseInt(val, 10);
  if (Number.isNaN(n)) throw new ConfigError(`${name} must be an integer, got: ${val}`);
  return n;
}

function optBool(val: string | undefined, fallback: boolean): boolean {
  if (val === undefined) return fallback;
  return val.toLowerCase() === "true" || val === "1" || val.toLowerCase() === "yes";
}

function parseTransport(cliArgs: string[]): Transport | null {
  if (cliArgs.includes("--stdio")) return "stdio";
  if (cliArgs.includes("--http")) return "http";
  return null;
}

export function loadConfig(cliArgs: string[] = process.argv.slice(2)): Config {
  const region = (process.env.CLIO_REGION ?? "us").toLowerCase() as Region;
  if (!(region in REGION_HOSTS)) {
    throw new ConfigError(
      `CLIO_REGION must be one of: ${Object.keys(REGION_HOSTS).join(", ")} (got: ${region})`,
    );
  }
  const host = REGION_HOSTS[region];

  const encryptionKeyHex = req("CLIO_ENCRYPTION_KEY", process.env.CLIO_ENCRYPTION_KEY);
  if (!/^[0-9a-f]{64}$/i.test(encryptionKeyHex)) {
    throw new ConfigError(
      "CLIO_ENCRYPTION_KEY must be 64 hex characters (32 bytes). " +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }

  const transportFromCli = parseTransport(cliArgs);
  const transport: Transport =
    transportFromCli ?? ((process.env.CLIO_TRANSPORT as Transport) ?? "stdio");
  if (transport !== "stdio" && transport !== "http") {
    throw new ConfigError(`CLIO_TRANSPORT must be stdio or http (got: ${transport})`);
  }

  const stateDir =
    process.env.CLIO_STATE_DIR && process.env.CLIO_STATE_DIR.trim() !== ""
      ? path.resolve(process.env.CLIO_STATE_DIR)
      : path.join(os.homedir(), ".clio-mcp");

  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  }

  const httpAuthTokens = (process.env.CLIO_HTTP_AUTH_TOKENS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const auditMode = ((process.env.CLIO_AUDIT_MODE as AuditMode) ?? "metadata").toLowerCase() as AuditMode;
  if (!["none", "metadata", "full"].includes(auditMode)) {
    throw new ConfigError(`CLIO_AUDIT_MODE must be one of: none, metadata, full (got: ${auditMode})`);
  }

  const defaultUserIdRaw = process.env.CLIO_DEFAULT_USER_ID;
  const defaultUserId =
    defaultUserIdRaw && defaultUserIdRaw.trim() !== "" ? Number.parseInt(defaultUserIdRaw, 10) : null;
  if (defaultUserId !== null && Number.isNaN(defaultUserId)) {
    throw new ConfigError(`CLIO_DEFAULT_USER_ID must be a number, got: ${defaultUserIdRaw}`);
  }

  const mcpAuthMode = ((process.env.MCP_AUTH_MODE as McpAuthMode) ?? "hybrid").toLowerCase() as McpAuthMode;
  if (!["oauth", "static", "hybrid"].includes(mcpAuthMode)) {
    throw new ConfigError(`MCP_AUTH_MODE must be one of: oauth, static, hybrid (got: ${mcpAuthMode})`);
  }

  const publicBaseUrlRaw = process.env.PUBLIC_BASE_URL;
  const publicBaseUrl =
    publicBaseUrlRaw && publicBaseUrlRaw.trim() !== ""
      ? publicBaseUrlRaw.trim().replace(/\/+$/, "")
      : null;
  if (publicBaseUrl !== null && !/^https?:\/\//i.test(publicBaseUrl)) {
    throw new ConfigError(`PUBLIC_BASE_URL must be an absolute http(s) URL, got: ${publicBaseUrl}`);
  }

  const clioOAuthScopesRaw = process.env.CLIO_OAUTH_SCOPES;
  const clioOAuthScopes =
    clioOAuthScopesRaw && clioOAuthScopesRaw.trim() !== "" ? clioOAuthScopesRaw.trim() : null;

  return {
    clientId: req("CLIO_CLIENT_ID", process.env.CLIO_CLIENT_ID),
    clientSecret: req("CLIO_CLIENT_SECRET", process.env.CLIO_CLIENT_SECRET),
    region,
    apiBase: `https://${host}/api/v4`,
    authorizeUrl: `https://${host}/oauth/authorize`,
    tokenUrl: `https://${host}/oauth/token`,
    encryptionKeyHex,
    redirectHost: process.env.CLIO_REDIRECT_HOST ?? "127.0.0.1",
    redirectPort: optInt("CLIO_REDIRECT_PORT", process.env.CLIO_REDIRECT_PORT, 5678),
    transport,
    httpPort: optInt("CLIO_HTTP_PORT", process.env.CLIO_HTTP_PORT, 8765),
    httpHost: process.env.CLIO_HTTP_HOST ?? "0.0.0.0",
    httpAuthTokens,
    stateDir,
    tokensPath: path.join(stateDir, "tokens.enc"),
    auditPath: path.join(stateDir, "audit.log"),
    auditMode,
    allowDestructive: optBool(process.env.CLIO_ALLOW_DESTRUCTIVE, false),
    defaultPageSize: optInt("CLIO_DEFAULT_PAGE_SIZE", process.env.CLIO_DEFAULT_PAGE_SIZE, 25),
    maxPageSize: optInt("CLIO_MAX_PAGE_SIZE", process.env.CLIO_MAX_PAGE_SIZE, 200),
    defaultUserId,
    bootstrapRefreshToken:
      process.env.CLIO_BOOTSTRAP_REFRESH_TOKEN && process.env.CLIO_BOOTSTRAP_REFRESH_TOKEN.trim() !== ""
        ? process.env.CLIO_BOOTSTRAP_REFRESH_TOKEN.trim()
        : null,
    publicBaseUrl,
    mcpAuthMode,
    mcpSessionTtlSeconds: optInt(
      "MCP_SESSION_TTL_SECONDS",
      process.env.MCP_SESSION_TTL_SECONDS,
      2_592_000,
    ),
    clioOAuthScopes,
  };
}

export function redirectUri(cfg: Config): string {
  return `http://${cfg.redirectHost}:${cfg.redirectPort}/callback`;
}
