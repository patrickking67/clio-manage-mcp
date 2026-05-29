import type { Config } from "../config.js";
import { AuthError, ClioError } from "../util/errors.js";
import { log } from "../util/logger.js";
import { OAuthFlow } from "../auth/oauth.js";
import { TokenStorage, type TokenSet } from "../auth/storage.js";
import type { ClioErrorBody, ClioListResponse, ClioSingleResponse } from "./types.js";

const REFRESH_SKEW_MS = 60_000; // refresh 60s before nominal expiry
const MAX_RETRIES = 3;

/**
 * The token source/sink a {@link ClioClient} reads from and writes back to.
 *
 * Decoupling the client from a concrete store is what makes the server
 * multi-tenant: the same request/retry/refresh logic serves both the
 * single-account stdio/static deployment and the per-user OAuth sessions.
 *
 *   - stdio / static-shared : a {@link DiskTokenProvider} backed by the
 *     on-disk encrypted {@link TokenStorage} (one shared Clio account).
 *   - OAuth session          : a provider whose `get`/`set` read and persist
 *     the Clio tokens stored inside that user's encrypted session record, so
 *     Clio refresh-token rotation survives across requests and replicas.
 *
 * `set` is async because persistence may hit disk (or shared Azure Files).
 */
export interface TokenProvider {
  /** Current Clio tokens, or null if this provider has none yet. */
  get(): TokenSet | null;
  /** Persist rotated Clio tokens back to the underlying store. */
  set(tokens: TokenSet): Promise<void>;
}

/**
 * Disk-backed provider used by stdio and static-shared HTTP mode.
 *
 * Holds the single shared account's tokens in memory and mirrors every
 * rotation to the encrypted token blob on disk — preserving the exact
 * behaviour the server had before multi-tenancy, including
 * CLIO_BOOTSTRAP_REFRESH_TOKEN seeding (see {@link ClioClient.init}).
 */
export class DiskTokenProvider implements TokenProvider {
  private tokens: TokenSet | null = null;

  constructor(private readonly storage: TokenStorage) {}

  get(): TokenSet | null {
    return this.tokens;
  }

  async set(tokens: TokenSet): Promise<void> {
    this.tokens = tokens;
    await this.storage.save(tokens);
  }

  /** In-memory only assignment used when loading the initial blob. */
  hydrate(tokens: TokenSet | null): void {
    this.tokens = tokens;
  }

  async clear(): Promise<void> {
    await this.storage.clear();
    this.tokens = null;
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown; // raw JSON body — will NOT be wrapped in `{ data: ... }`
  data?: unknown; // wrapped body — will be sent as `{ data: ... }` (recommended for POST/PATCH)
  fields?: string; // shorthand for query.fields
  /** If true, return raw Response without parsing body. */
  raw?: boolean;
}

export class ClioClient {
  /**
   * @param cfg      shared, immutable configuration.
   * @param oauth    shared, stateless OAuth helper (used only for `refresh`).
   * @param tokens   per-client token source/sink. For stdio/static this is a
   *                 shared {@link DiskTokenProvider}; for OAuth sessions it is
   *                 a thin per-request provider over the session record.
   *
   * Construction is intentionally cheap (no I/O) so a fresh client can be
   * built for every HTTP request.
   */
  constructor(
    private readonly cfg: Config,
    private readonly oauth: OAuthFlow,
    private readonly tokens: TokenProvider,
  ) {}

  /**
   * Load the shared account's tokens from disk (stdio / static mode).
   *
   * Only meaningful for a {@link DiskTokenProvider}; session-backed clients
   * already carry their tokens and never call this. Preserves the original
   * bootstrap-from-refresh-token behaviour for headless deployments.
   */
  async init(): Promise<void> {
    if (!(this.tokens instanceof DiskTokenProvider)) return;
    const loaded = await new TokenStorage(this.cfg).load();
    if (loaded) {
      this.tokens.hydrate(loaded);
      log.info("loaded encrypted tokens from disk", {
        path: this.cfg.tokensPath,
        expires_at: new Date(loaded.expires_at).toISOString(),
      });
      return;
    }
    if (this.cfg.bootstrapRefreshToken) {
      log.info("no token blob on disk — bootstrapping from CLIO_BOOTSTRAP_REFRESH_TOKEN");
      try {
        const refreshed = await this.oauth.refresh(this.cfg.bootstrapRefreshToken);
        await this.tokens.set(refreshed);
        log.info("bootstrap successful; encrypted token blob written", {
          path: this.cfg.tokensPath,
        });
      } catch (err) {
        log.error("bootstrap refresh failed", {
          error: err instanceof Error ? err.message : String(err),
          hint: "Re-run the local OAuth dance and update the bootstrap refresh token.",
        });
      }
    }
  }

  isAuthenticated(): boolean {
    return this.tokens.get() !== null;
  }

  currentUserId(): number | undefined {
    return this.tokens.get()?.user_id;
  }

  tokenExpiresAt(): Date | null {
    const t = this.tokens.get();
    return t ? new Date(t.expires_at) : null;
  }

  /**
   * Run the loopback authorize flow and persist the result (stdio only).
   * Session-backed clients never call this — their tokens come from the
   * connector OAuth bridge.
   */
  async authenticate(): Promise<TokenSet> {
    const tokens = await this.oauth.authorize();
    await this.tokens.set(tokens);
    return tokens;
  }

  async logout(): Promise<void> {
    if (this.tokens instanceof DiskTokenProvider) {
      await this.tokens.clear();
    }
  }

  private async ensureFreshToken(): Promise<string> {
    const current = this.tokens.get();
    if (!current) {
      throw new AuthError(
        "not authenticated",
        "On local stdio, run the `clio_authenticate` tool. On the remote connector, " +
          "authenticate through the connector's OAuth sign-in. For static/shared HTTP mode, " +
          "seed CLIO_BOOTSTRAP_REFRESH_TOKEN at deploy time.",
      );
    }
    if (Date.now() >= current.expires_at - REFRESH_SKEW_MS) {
      log.debug("refreshing access token");
      const refreshed = await this.oauth.refresh(current.refresh_token);
      await this.tokens.set(refreshed);
      return refreshed.access_token;
    }
    return current.access_token;
  }

  /**
   * Issue a request against the Clio v4 API.
   *
   * Path is the part after `/api/v4`, with or without leading slash:
   *   "matters.json", "/matters/123.json", "users/who_am_i.json".
   */
  async request<T = unknown>(rawPath: string, opts: RequestOptions = {}): Promise<T> {
    const access = await this.ensureFreshToken();

    const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
    const url = new URL(this.cfg.apiBase + path);
    if (opts.fields) url.searchParams.set("fields", opts.fields);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v === undefined || v === null) continue;
        url.searchParams.set(k, String(v));
      }
    }

    const method = opts.method ?? "GET";
    const headers: Record<string, string> = {
      Authorization: `Bearer ${access}`,
      Accept: "application/json",
      "User-Agent": "clio-mcp/0.1.0",
    };

    let body: string | undefined;
    if (opts.data !== undefined) {
      body = JSON.stringify({ data: opts.data });
      headers["Content-Type"] = "application/json";
    } else if (opts.body !== undefined) {
      body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
      headers["Content-Type"] = "application/json";
    }

    let attempt = 0;
    let lastErr: unknown = null;
    while (attempt < MAX_RETRIES) {
      attempt += 1;
      try {
        const res = await fetch(url.toString(), { method, headers, body });
        if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
          const retryAfter = parseRetryAfter(res.headers.get("Retry-After"));
          const wait = retryAfter ?? Math.min(2 ** attempt * 250, 4000);
          log.warn("clio transient error, retrying", { status: res.status, attempt, wait_ms: wait });
          await sleep(wait);
          continue;
        }
        if (res.status === 401) {
          // Token may have been revoked mid-request; try one refresh.
          const current = this.tokens.get();
          if (attempt === 1 && current) {
            log.info("got 401, refreshing token and retrying once");
            const refreshed = await this.oauth.refresh(current.refresh_token);
            await this.tokens.set(refreshed);
            headers.Authorization = `Bearer ${refreshed.access_token}`;
            continue;
          }
        }
        if (opts.raw) {
          return res as unknown as T;
        }
        const text = await res.text();
        const parsed = text ? safeJson(text) : null;
        if (!res.ok) {
          throw new ClioError(
            extractMessage(parsed) ?? `request failed: ${res.status} ${res.statusText}`,
            res.status,
            parsed ?? text,
            hintForStatus(res.status, path),
          );
        }
        return (parsed ?? (null as unknown)) as T;
      } catch (err) {
        if (err instanceof ClioError) throw err;
        if (err instanceof AuthError) throw err;
        lastErr = err;
        const wait = Math.min(2 ** attempt * 250, 2000);
        log.warn("network error, retrying", { attempt, wait_ms: wait, error: String(err) });
        await sleep(wait);
      }
    }
    throw new ClioError(
      `request failed after ${MAX_RETRIES} attempts: ${String(lastErr)}`,
      0,
      null,
    );
  }

  async list<T>(path: string, opts: RequestOptions = {}): Promise<ClioListResponse<T>> {
    return this.request<ClioListResponse<T>>(path, opts);
  }

  async one<T>(path: string, opts: RequestOptions = {}): Promise<ClioSingleResponse<T>> {
    return this.request<ClioSingleResponse<T>>(path, opts);
  }

  /**
   * Walk a paginated endpoint up to `limit` items total.
   *
   * Clio's `meta.paging.next` is a full URL — we honour it rather than re-deriving page numbers.
   */
  async paginate<T>(
    path: string,
    opts: RequestOptions & { limit?: number; pageSize?: number } = {},
  ): Promise<T[]> {
    const limit = opts.limit ?? this.cfg.maxPageSize;
    const pageSize = Math.min(opts.pageSize ?? this.cfg.defaultPageSize, this.cfg.maxPageSize);
    const out: T[] = [];
    let nextUrl: string | null = null;
    let firstQuery: Record<string, string | number | boolean | undefined | null> | undefined = {
      ...(opts.query ?? {}),
      limit: pageSize,
    };

    for (;;) {
      let res: ClioListResponse<T>;
      if (nextUrl) {
        const full = await this.requestRawUrl<ClioListResponse<T>>(nextUrl);
        res = full;
      } else {
        res = await this.list<T>(path, { ...opts, query: firstQuery });
        firstQuery = undefined;
      }
      for (const item of res.data) {
        out.push(item);
        if (out.length >= limit) return out;
      }
      const next = res.meta?.paging?.next;
      if (!next) return out;
      nextUrl = next;
    }
  }

  private async requestRawUrl<T>(absoluteUrl: string): Promise<T> {
    const access = await this.ensureFreshToken();
    const res = await fetch(absoluteUrl, {
      headers: {
        Authorization: `Bearer ${access}`,
        Accept: "application/json",
        "User-Agent": "clio-mcp/0.1.0",
      },
    });
    const text = await res.text();
    const parsed = text ? safeJson(text) : null;
    if (!res.ok) {
      throw new ClioError(
        extractMessage(parsed) ?? `request failed: ${res.status}`,
        res.status,
        parsed ?? text,
        hintForStatus(res.status, absoluteUrl),
      );
    }
    return parsed as T;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseRetryAfter(h: string | null): number | null {
  if (!h) return null;
  const n = Number.parseFloat(h);
  if (!Number.isNaN(n)) return Math.min(Math.max(n * 1000, 250), 30_000);
  const dateMs = Date.parse(h);
  if (!Number.isNaN(dateMs)) return Math.max(dateMs - Date.now(), 250);
  return null;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function extractMessage(parsed: unknown): string | undefined {
  if (parsed && typeof parsed === "object") {
    const err = (parsed as ClioErrorBody).error;
    if (err?.message) return err.message;
  }
  return undefined;
}

function hintForStatus(status: number, path: string): string | undefined {
  switch (status) {
    case 401:
      return "Token rejected. Re-authenticate; refresh tokens can be revoked when scopes change or a user revokes the app in Clio.";
    case 403:
      return "Token lacks the required scope. Add the scope to your Clio Developer Application and re-run OAuth.";
    case 404:
      return `Resource not found at ${path}. Confirm the id and that it exists in this region.`;
    case 422:
      return "Validation error. Check the response body for the offending field. Address `name` must be one of: Work, Home, Billing, Other.";
    case 429:
      return "Rate limited by Clio. The client will back off automatically; if this persists, lower your traffic.";
    default:
      return undefined;
  }
}
