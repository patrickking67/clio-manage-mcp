import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHash,
} from "node:crypto";
import { readFile, writeFile, mkdir, unlink, readdir } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import type { Config } from "../config.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { TokenSet } from "./storage.js";
import { log } from "../util/logger.js";

/**
 * Persistence layer for the remote OAuth bridge.
 *
 * Everything is encrypted at rest with the same AES-256-GCM key as the on-disk
 * token blob (`CLIO_ENCRYPTION_KEY`) and stored as ONE FILE PER RECORD under
 * `${CLIO_STATE_DIR}/{sessions,clients,pending}/`. File-per-record (rather than
 * one big JSON) is deliberate: it lets multiple horizontally-scaled Azure
 * Container App replicas share a single Azure Files mount without trampling
 * each other's writes. A small in-memory cache fronts disk for hot reads.
 *
 * Record kinds:
 *   - clients/<clientId>.enc   : DCR client registrations (RFC 7591).
 *   - sessions/<sha256(tok)>.enc : issued MCP sessions → bridged Clio tokens.
 *   - pending/<id>.enc         : short-lived `txn` (authorize round-trip) and
 *                                `authCode` (post-Clio-callback) records.
 *
 * Pending records are written to disk with a TTL so the authorize→Clio→callback
 * →token round-trip survives a replica hop. They are also cached in memory for
 * the common single-replica case. Expired pending records are best-effort
 * cleaned on read and via {@link SessionStore.sweep}.
 */

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

/** A short-lived record created when the client begins authorization. */
export interface TxnRecord {
  /** DCR client id that initiated the authorize request. */
  clientId: string;
  /** The client's (Claude's) redirect URI — where we send the MCP code back. */
  clientRedirectUri: string;
  /** The client's opaque `state`, echoed back verbatim on completion. */
  clientState?: string;
  /** PKCE challenge from the client; the SDK verifies the verifier at /token. */
  codeChallenge: string;
  /** RFC 8707 resource indicator, if the client supplied one. */
  resource?: string;
  /** Absolute expiry (epoch ms). */
  expiresAt: number;
}

/** A short-lived record created after Clio redirects back with its code. */
export interface AuthCodeRecord {
  /** The Clio tokens obtained by exchanging Clio's authorization code. */
  clioTokens: TokenSet;
  /** PKCE challenge carried over from the originating txn. */
  codeChallenge: string;
  /** DCR client id (must match the client presenting the code at /token). */
  clientId: string;
  /** The client redirect URI used (for redirect_uri match at /token). */
  clientRedirectUri: string;
  /** RFC 8707 resource indicator carried over from the txn, if any. */
  resource?: string;
  /** Absolute expiry (epoch ms). */
  expiresAt: number;
}

/** A persisted MCP session: the bridge between an MCP token pair and Clio. */
export interface SessionRecord {
  /** Stable session id (= sha256(access_token) hex). */
  id: string;
  /** DCR client this session belongs to. */
  clientId: string;
  /** sha256(refresh_token) — the access token hash is the filename/id. */
  refreshTokenHash: string;
  /** The end user's Clio tokens (rotated in place on refresh). */
  clioTokens: TokenSet;
  /** Epoch ms when this session was created. */
  createdAt: number;
  /** Epoch ms when the MCP access token expires (drives /mcp 401s). */
  expiresAt: number;
  /** RFC 8707 resource indicator the session was issued for, if any. */
  resource?: string;
}

const TXN_TTL_MS = 10 * 60 * 1000; // authorize round-trip window
const AUTH_CODE_TTL_MS = 10 * 60 * 1000; // code-exchange window

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Bounded most-recently-used cache. Keeps hot records off the disk path. */
class LruCache<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly max: number) {}

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      // Refresh recency.
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }
}

export class SessionStore implements OAuthRegisteredClientsStore {
  private readonly key: Buffer;
  private readonly sessionsDir: string;
  private readonly clientsDir: string;
  private readonly pendingDir: string;

  private readonly clientCache = new LruCache<OAuthClientInformationFull>(256);
  private readonly sessionCache = new LruCache<SessionRecord>(1024);
  private readonly txnCache = new LruCache<TxnRecord>(512);
  private readonly authCodeCache = new LruCache<AuthCodeRecord>(512);

  constructor(private readonly cfg: Config) {
    this.key = Buffer.from(cfg.encryptionKeyHex, "hex");
    this.sessionsDir = path.join(cfg.stateDir, "sessions");
    this.clientsDir = path.join(cfg.stateDir, "clients");
    this.pendingDir = path.join(cfg.stateDir, "pending");
    for (const dir of [this.sessionsDir, this.clientsDir, this.pendingDir]) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  // --- crypto + file helpers ------------------------------------------------

  private encrypt(value: unknown): Buffer {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const data = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(value), "utf8")),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, data]);
  }

  private decrypt<T>(blob: Buffer): T | null {
    if (blob.length < IV_LEN + TAG_LEN + 1) return null;
    try {
      const iv = blob.subarray(0, IV_LEN);
      const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
      const data = blob.subarray(IV_LEN + TAG_LEN);
      const decipher = createDecipheriv(ALGO, this.key, iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(data), decipher.final()]);
      return JSON.parse(plain.toString("utf8")) as T;
    } catch {
      return null;
    }
  }

  private async writeRecord(file: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, this.encrypt(value), { mode: 0o600 });
  }

  private async readRecord<T>(file: string): Promise<T | null> {
    if (!existsSync(file)) return null;
    try {
      return this.decrypt<T>(await readFile(file));
    } catch (err) {
      log.warn("failed to read encrypted record", {
        file,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private static safeId(id: string): string {
    // Defensive: ids are random hex / UUID, but never let one escape the dir.
    return id.replace(/[^A-Za-z0-9_-]/g, "_");
  }

  // --- OAuthRegisteredClientsStore -----------------------------------------

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const cached = this.clientCache.get(clientId);
    if (cached) return cached;
    const file = path.join(this.clientsDir, `${SessionStore.safeId(clientId)}.enc`);
    const rec = await this.readRecord<OAuthClientInformationFull>(file);
    if (rec) this.clientCache.set(clientId, rec);
    return rec ?? undefined;
  }

  async registerClient(
    client: OAuthClientInformationFull,
  ): Promise<OAuthClientInformationFull> {
    const file = path.join(this.clientsDir, `${SessionStore.safeId(client.client_id)}.enc`);
    await this.writeRecord(file, client);
    this.clientCache.set(client.client_id, client);
    log.info("registered OAuth client (DCR)", {
      client_id: client.client_id,
      redirect_uris: client.redirect_uris,
      token_endpoint_auth_method: client.token_endpoint_auth_method,
    });
    return client;
  }

  // --- transaction (authorize → Clio) records ------------------------------

  async createTxn(rec: Omit<TxnRecord, "expiresAt">): Promise<string> {
    const id = randomBytes(24).toString("base64url");
    const full: TxnRecord = { ...rec, expiresAt: Date.now() + TXN_TTL_MS };
    await this.writeRecord(path.join(this.pendingDir, `txn_${id}.enc`), full);
    this.txnCache.set(id, full);
    return id;
  }

  async consumeTxn(id: string): Promise<TxnRecord | null> {
    const file = path.join(this.pendingDir, `txn_${SessionStore.safeId(id)}.enc`);
    const rec = this.txnCache.get(id) ?? (await this.readRecord<TxnRecord>(file));
    this.txnCache.delete(id);
    await unlink(file).catch(() => {});
    if (!rec) return null;
    if (rec.expiresAt < Date.now()) return null;
    return rec;
  }

  // --- authorization-code records (Clio callback → /token) -----------------

  async createAuthCode(rec: Omit<AuthCodeRecord, "expiresAt">): Promise<string> {
    const code = randomBytes(32).toString("base64url");
    const full: AuthCodeRecord = { ...rec, expiresAt: Date.now() + AUTH_CODE_TTL_MS };
    await this.writeRecord(
      path.join(this.pendingDir, `code_${sha256Hex(code)}.enc`),
      full,
    );
    this.authCodeCache.set(code, full);
    return code;
  }

  /** Look up a code without consuming it (used by challengeForAuthorizationCode). */
  async peekAuthCode(code: string): Promise<AuthCodeRecord | null> {
    const cached = this.authCodeCache.get(code);
    if (cached) return cached.expiresAt < Date.now() ? null : cached;
    const file = path.join(this.pendingDir, `code_${sha256Hex(code)}.enc`);
    const rec = await this.readRecord<AuthCodeRecord>(file);
    if (!rec) return null;
    if (rec.expiresAt < Date.now()) return null;
    this.authCodeCache.set(code, rec);
    return rec;
  }

  /** Look up and atomically invalidate a code (single-use, at /token exchange). */
  async consumeAuthCode(code: string): Promise<AuthCodeRecord | null> {
    const file = path.join(this.pendingDir, `code_${sha256Hex(code)}.enc`);
    const rec = this.authCodeCache.get(code) ?? (await this.readRecord<AuthCodeRecord>(file));
    this.authCodeCache.delete(code);
    await unlink(file).catch(() => {});
    if (!rec) return null;
    if (rec.expiresAt < Date.now()) return null;
    return rec;
  }

  // --- sessions -------------------------------------------------------------

  /**
   * Mint and persist a new session. Returns the opaque MCP access/refresh
   * token pair; only their hashes are stored. The access-token hash is the
   * session id (and filename).
   */
  async createSession(input: {
    clientId: string;
    clioTokens: TokenSet;
    resource?: string;
  }): Promise<{ accessToken: string; refreshToken: string; record: SessionRecord }> {
    const accessToken = randomBytes(32).toString("base64url");
    const refreshToken = randomBytes(32).toString("base64url");
    const now = Date.now();
    const record: SessionRecord = {
      id: sha256Hex(accessToken),
      clientId: input.clientId,
      refreshTokenHash: sha256Hex(refreshToken),
      clioTokens: input.clioTokens,
      createdAt: now,
      expiresAt: now + this.cfg.mcpSessionTtlSeconds * 1000,
      ...(input.resource !== undefined ? { resource: input.resource } : {}),
    };
    await this.persistSession(record);
    return { accessToken, refreshToken, record };
  }

  private async persistSession(record: SessionRecord): Promise<void> {
    const file = path.join(this.sessionsDir, `${SessionStore.safeId(record.id)}.enc`);
    await this.writeRecord(file, record);
    this.sessionCache.set(record.id, record);
  }

  /** Resolve a presented MCP access token to its session, or null. */
  async getSessionByAccessToken(accessToken: string): Promise<SessionRecord | null> {
    const id = sha256Hex(accessToken);
    const cached = this.sessionCache.get(id);
    const rec =
      cached ??
      (await this.readRecord<SessionRecord>(
        path.join(this.sessionsDir, `${id}.enc`),
      ));
    if (!rec) return null;
    if (rec.expiresAt < Date.now()) {
      await this.deleteSession(id);
      return null;
    }
    if (!cached) this.sessionCache.set(id, rec);
    return rec;
  }

  /**
   * Persist rotated Clio tokens for an existing session (called when a
   * session-bound ClioClient refreshes the user's Clio access token). Keeps
   * Clio refresh-token rotation durable across requests and replicas.
   */
  async persistClioTokens(sessionId: string, clioTokens: TokenSet): Promise<void> {
    const rec =
      this.sessionCache.get(sessionId) ??
      (await this.readRecord<SessionRecord>(
        path.join(this.sessionsDir, `${SessionStore.safeId(sessionId)}.enc`),
      ));
    if (!rec) {
      // Session vanished (expired/revoked). Nothing to persist.
      return;
    }
    rec.clioTokens = clioTokens;
    await this.persistSession(rec);
  }

  /**
   * Rotate the MCP token pair for a refresh-token grant, preserving the bridged
   * Clio tokens. The old session file is removed and a fresh one is written.
   * Returns null if the refresh token does not match any live session.
   */
  async rotate(
    refreshToken: string,
    clientId: string,
  ): Promise<{ accessToken: string; refreshToken: string; record: SessionRecord } | null> {
    const refreshHash = sha256Hex(refreshToken);
    const match = await this.findSessionByRefreshHash(refreshHash);
    if (!match) return null;
    if (match.clientId !== clientId) return null;
    if (match.expiresAt < Date.now()) {
      await this.deleteSession(match.id);
      return null;
    }
    // Issue a new pair; carry the Clio tokens + resource over.
    const issued = await this.createSession({
      clientId: match.clientId,
      clioTokens: match.clioTokens,
      ...(match.resource !== undefined ? { resource: match.resource } : {}),
    });
    await this.deleteSession(match.id);
    return issued;
  }

  private async findSessionByRefreshHash(
    refreshHash: string,
  ): Promise<SessionRecord | null> {
    // Sessions are keyed by access-token hash, so a refresh-token lookup scans.
    // The session count per deployment is small (one per active user device),
    // and rotation is infrequent, so a directory scan is acceptable here.
    let files: string[];
    try {
      files = await readdir(this.sessionsDir);
    } catch {
      return null;
    }
    for (const f of files) {
      if (!f.endsWith(".enc")) continue;
      const rec = await this.readRecord<SessionRecord>(path.join(this.sessionsDir, f));
      if (rec && rec.refreshTokenHash === refreshHash) return rec;
    }
    return null;
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessionCache.delete(sessionId);
    await unlink(
      path.join(this.sessionsDir, `${SessionStore.safeId(sessionId)}.enc`),
    ).catch(() => {});
  }

  /** Revoke by presented access OR refresh token (best-effort, idempotent). */
  async revokeByToken(token: string): Promise<void> {
    const asAccess = await this.getSessionByAccessToken(token);
    if (asAccess) {
      await this.deleteSession(asAccess.id);
      return;
    }
    const match = await this.findSessionByRefreshHash(sha256Hex(token));
    if (match) await this.deleteSession(match.id);
  }

  /**
   * Best-effort sweep of expired pending + session records. Safe to call
   * periodically; never throws.
   */
  async sweep(): Promise<void> {
    const now = Date.now();
    await this.sweepDir(this.pendingDir, now);
    await this.sweepDir(this.sessionsDir, now);
  }

  private async sweepDir(dir: string, now: number): Promise<void> {
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return;
    }
    for (const f of files) {
      if (!f.endsWith(".enc")) continue;
      const rec = await this.readRecord<{ expiresAt?: number }>(path.join(dir, f));
      if (rec?.expiresAt !== undefined && rec.expiresAt < now) {
        await unlink(path.join(dir, f)).catch(() => {});
      }
    }
  }
}
