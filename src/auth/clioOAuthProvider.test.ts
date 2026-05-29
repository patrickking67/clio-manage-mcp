import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";

import type { Response } from "express";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";

import type { Config } from "../config.js";
import type { OAuthFlow } from "./oauth.js";
import type { TokenSet } from "./storage.js";
import { SessionStore } from "./sessionStore.js";
import { ClioOAuthProvider } from "./clioOAuthProvider.js";

/**
 * Hermetic unit tests for the OAuth bridge provider. We exercise only the pure,
 * network-free paths: the authorize -> Clio redirect, PKCE challenge stashing,
 * code/refresh exchange (which operate on records already in the store), and
 * access-token verification. The Clio leg (exchangeCodeForTokens) lives in the
 * HTTP transport and is never invoked here, so no OAuthFlow network call runs.
 */

const BASE = "http://127.0.0.1:9876";
const CLIENT_REDIRECT = "https://claude.ai/api/mcp/auth_callback";

let stateDir: string;
let cfg: Config;
let sessions: SessionStore;
let provider: ClioOAuthProvider;

const client: OAuthClientInformationFull = {
  client_id: "dcr-client-1",
  redirect_uris: [CLIENT_REDIRECT],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

function makeConfig(dir: string): Config {
  return {
    clientId: "clio-app-client-id",
    region: "us",
    authorizeUrl: "https://app.clio.com/oauth/authorize",
    tokenUrl: "https://app.clio.com/oauth/token",
    encryptionKeyHex: randomBytes(32).toString("hex"),
    stateDir: dir,
    mcpSessionTtlSeconds: 2_592_000,
    clioOAuthScopes: null,
  } as unknown as Config;
}

function fakeClioTokens(overrides: Partial<TokenSet> = {}): TokenSet {
  return {
    access_token: "clio-access",
    refresh_token: "clio-refresh",
    expires_at: Date.now() + 3_600_000,
    token_type: "bearer",
    user_id: 4242,
    ...overrides,
  };
}

/** Minimal Express Response stub capturing res.redirect(status, location). */
function fakeRes(): { res: Response; redirects: Array<{ status: number; url: string }> } {
  const redirects: Array<{ status: number; url: string }> = [];
  const res = {
    redirect(status: number, url: string) {
      redirects.push({ status, url });
    },
  } as unknown as Response;
  return { res, redirects };
}

// The OAuthFlow is only used by the HTTP transport's Clio callback, never by the
// provider under test. A throwing stub guards against accidental network use.
const oauthStub = {
  exchangeCodeForTokens() {
    throw new Error("network call must not happen in provider unit tests");
  },
} as unknown as OAuthFlow;

before(async () => {
  stateDir = await mkdtemp(path.join(os.tmpdir(), "clio-mcp-provider-"));
  cfg = makeConfig(stateDir);
  sessions = new SessionStore(cfg);
  provider = new ClioOAuthProvider(cfg, oauthStub, sessions, BASE);
});

after(async () => {
  if (stateDir) await rm(stateDir, { recursive: true, force: true });
});

test("clientsStore is the SessionStore and clioRedirectUri is derived from base", () => {
  assert.equal(provider.clientsStore, sessions);
  assert.equal(provider.clioRedirectUri(), `${BASE}/oauth/clio/callback`);
  // PKCE is validated locally by the SDK (must not be skipped).
  assert.equal(provider.skipLocalPkceValidation, false);
});

test("authorize() persists a txn and 302-redirects to the Clio authorize host", async () => {
  const { res, redirects } = fakeRes();
  const params: AuthorizationParams = {
    redirectUri: CLIENT_REDIRECT,
    codeChallenge: "challenge-abc",
    state: "client-state-xyz",
  };
  await provider.authorize(client, params, res);

  assert.equal(redirects.length, 1);
  assert.equal(redirects[0].status, 302);

  const loc = new URL(redirects[0].url);
  assert.equal(loc.origin + loc.pathname, "https://app.clio.com/oauth/authorize");
  assert.equal(loc.searchParams.get("response_type"), "code");
  // Clio sees OUR app client id and OUR callback as its redirect_uri.
  assert.equal(loc.searchParams.get("client_id"), "clio-app-client-id");
  assert.equal(loc.searchParams.get("redirect_uri"), `${BASE}/oauth/clio/callback`);

  // The `state` sent to Clio is the opaque txn id (NOT the client's state).
  const txnId = loc.searchParams.get("state");
  assert.ok(txnId && txnId.length > 0);
  assert.notEqual(txnId, "client-state-xyz");

  // The txn was persisted and round-trips with the client's details.
  const txn = await sessions.consumeTxn(txnId);
  assert.ok(txn);
  assert.equal(txn.clientId, "dcr-client-1");
  assert.equal(txn.clientRedirectUri, CLIENT_REDIRECT);
  assert.equal(txn.clientState, "client-state-xyz");
  assert.equal(txn.codeChallenge, "challenge-abc");
});

test("authorize() appends scope only when configured", async () => {
  // Default config: no scopes => no scope param.
  {
    const { res, redirects } = fakeRes();
    await provider.authorize(client, { redirectUri: CLIENT_REDIRECT, codeChallenge: "c" }, res);
    const loc = new URL(redirects[0].url);
    assert.equal(loc.searchParams.has("scope"), false);
  }
  // With scopes configured, scope is forwarded to Clio.
  {
    const scopedCfg = { ...cfg, clioOAuthScopes: "clio offline_access" };
    const scopedProvider = new ClioOAuthProvider(scopedCfg, oauthStub, sessions, BASE);
    const { res, redirects } = fakeRes();
    await scopedProvider.authorize(client, { redirectUri: CLIENT_REDIRECT, codeChallenge: "c" }, res);
    const loc = new URL(redirects[0].url);
    assert.equal(loc.searchParams.get("scope"), "clio offline_access");
  }
});

test("challengeForAuthorizationCode returns the stashed challenge (without consuming)", async () => {
  const code = await sessions.createAuthCode({
    clioTokens: fakeClioTokens(),
    codeChallenge: "stashed-challenge",
    clientId: "dcr-client-1",
    clientRedirectUri: CLIENT_REDIRECT,
  });

  const challenge = await provider.challengeForAuthorizationCode(client, code);
  assert.equal(challenge, "stashed-challenge");

  // It must NOT have consumed the code — the SDK calls exchange immediately after.
  const stillThere = await sessions.peekAuthCode(code);
  assert.ok(stillThere, "challenge lookup must not consume the auth code");
});

test("challengeForAuthorizationCode rejects unknown code and client mismatch", async () => {
  await assert.rejects(
    () => provider.challengeForAuthorizationCode(client, "no-such-code"),
    InvalidGrantError,
  );

  const code = await sessions.createAuthCode({
    clioTokens: fakeClioTokens(),
    codeChallenge: "x",
    clientId: "some-other-client",
    clientRedirectUri: CLIENT_REDIRECT,
  });
  await assert.rejects(
    () => provider.challengeForAuthorizationCode(client, code),
    InvalidGrantError,
  );
});

test("exchangeAuthorizationCode mints a session bridged to the Clio tokens", async () => {
  const code = await sessions.createAuthCode({
    clioTokens: fakeClioTokens({ user_id: 555 }),
    codeChallenge: "c",
    clientId: "dcr-client-1",
    clientRedirectUri: CLIENT_REDIRECT,
    resource: `${BASE}/mcp`,
  });

  const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, CLIENT_REDIRECT);
  assert.equal(tokens.token_type, "Bearer");
  assert.ok(tokens.access_token);
  assert.ok(tokens.refresh_token);
  assert.ok((tokens.expires_in ?? 0) > 0);

  // The minted access token resolves to a session carrying the bridged Clio tokens.
  const session = await sessions.getSessionByAccessToken(tokens.access_token);
  assert.ok(session);
  assert.equal(session.clientId, "dcr-client-1");
  assert.equal(session.clioTokens.user_id, 555);
  assert.equal(session.resource, `${BASE}/mcp`);

  // The code was consumed (single-use).
  assert.equal(await sessions.peekAuthCode(code), null);
});

test("exchangeAuthorizationCode rejects a redirect_uri mismatch and unknown codes", async () => {
  const code = await sessions.createAuthCode({
    clioTokens: fakeClioTokens(),
    codeChallenge: "c",
    clientId: "dcr-client-1",
    clientRedirectUri: CLIENT_REDIRECT,
  });
  await assert.rejects(
    () => provider.exchangeAuthorizationCode(client, code, undefined, "https://evil.example/cb"),
    InvalidGrantError,
  );

  await assert.rejects(
    () => provider.exchangeAuthorizationCode(client, "unknown-code", undefined, CLIENT_REDIRECT),
    InvalidGrantError,
  );
});

test("exchangeRefreshToken rotates the pair and rejects bad refresh tokens", async () => {
  // Seed a session via the code-exchange path, then refresh it.
  const code = await sessions.createAuthCode({
    clioTokens: fakeClioTokens({ user_id: 999 }),
    codeChallenge: "c",
    clientId: "dcr-client-1",
    clientRedirectUri: CLIENT_REDIRECT,
  });
  const first = await provider.exchangeAuthorizationCode(client, code, undefined, CLIENT_REDIRECT);

  const refreshed = await provider.exchangeRefreshToken(client, first.refresh_token as string);
  assert.equal(refreshed.token_type, "Bearer");
  assert.notEqual(refreshed.access_token, first.access_token);

  // Old access token is invalid; new one resolves and still bridges Clio user 999.
  assert.equal(await sessions.getSessionByAccessToken(first.access_token), null);
  const newSession = await sessions.getSessionByAccessToken(refreshed.access_token);
  assert.ok(newSession);
  assert.equal(newSession.clioTokens.user_id, 999);

  await assert.rejects(
    () => provider.exchangeRefreshToken(client, "not-a-real-refresh-token"),
    InvalidGrantError,
  );
});

test("verifyAccessToken returns AuthInfo (expiresAt in seconds, sessionId in extra)", async () => {
  const code = await sessions.createAuthCode({
    clioTokens: fakeClioTokens(),
    codeChallenge: "c",
    clientId: "dcr-client-1",
    clientRedirectUri: CLIENT_REDIRECT,
    resource: `${BASE}/mcp`,
  });
  const issued = await provider.exchangeAuthorizationCode(client, code, undefined, CLIENT_REDIRECT);

  const info = await provider.verifyAccessToken(issued.access_token);
  assert.equal(info.token, issued.access_token);
  assert.equal(info.clientId, "dcr-client-1");
  assert.deepEqual(info.scopes, []);
  // expiresAt must be in SECONDS (the SDK compares against Date.now()/1000).
  const nowSec = Date.now() / 1000;
  assert.ok(info.expiresAt && info.expiresAt > nowSec, "expiresAt should be a future epoch in seconds");
  assert.ok(info.expiresAt < nowSec + cfg.mcpSessionTtlSeconds + 60);
  // The session id is threaded through extra for resolveClient().
  assert.equal(typeof (info.extra?.sessionId), "string");
  assert.ok(info.resource instanceof URL);
  assert.equal(info.resource?.href, `${BASE}/mcp`);
});

test("verifyAccessToken throws InvalidTokenError for an unknown token", async () => {
  // InvalidTokenError is the ONE error the bearer middleware maps to 401 + the
  // RFC 9728 WWW-Authenticate challenge; anything else would be a wrong status.
  await assert.rejects(
    () => provider.verifyAccessToken("totally-bogus-token"),
    InvalidTokenError,
  );
});

test("revokeToken invalidates the session (best-effort, idempotent)", async () => {
  const code = await sessions.createAuthCode({
    clioTokens: fakeClioTokens(),
    codeChallenge: "c",
    clientId: "dcr-client-1",
    clientRedirectUri: CLIENT_REDIRECT,
  });
  const issued = await provider.exchangeAuthorizationCode(client, code, undefined, CLIENT_REDIRECT);
  assert.ok(await sessions.getSessionByAccessToken(issued.access_token));

  await provider.revokeToken(client, { token: issued.access_token });
  assert.equal(await sessions.getSessionByAccessToken(issued.access_token), null);

  // Revoking again / an unknown token must not throw.
  await provider.revokeToken(client, { token: issued.access_token });
  await provider.revokeToken(client, { token: "unknown" });
});
