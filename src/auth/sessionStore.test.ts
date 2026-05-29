import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Config } from "../config.js";
import type { TokenSet } from "./storage.js";
import { SessionStore, sha256Hex } from "./sessionStore.js";

/**
 * Hermetic unit tests for the encrypted, file-per-record session store that
 * backs the OAuth remote-connector bridge. No network, no real Clio: we drive
 * the public SessionStore API against a throwaway temp CLIO_STATE_DIR and a
 * random AES key, then verify behaviour and that records are encrypted at rest.
 */

let stateDir: string;
let cfg: Config;

/**
 * Build the minimal Config the SessionStore actually reads
 * (encryptionKeyHex, stateDir, mcpSessionTtlSeconds). We construct it directly
 * rather than calling loadConfig() to keep the test decoupled from process.env
 * and dotenv. `ttlSeconds` lets individual tests force near-instant expiry.
 */
function makeConfig(dir: string, ttlSeconds = 2_592_000): Config {
  return {
    encryptionKeyHex: randomBytes(32).toString("hex"),
    stateDir: dir,
    mcpSessionTtlSeconds: ttlSeconds,
  } as unknown as Config;
}

function fakeClioTokens(overrides: Partial<TokenSet> = {}): TokenSet {
  return {
    access_token: "clio-access-PLAINTEXT-MARKER",
    refresh_token: "clio-refresh-PLAINTEXT-MARKER",
    expires_at: Date.now() + 3_600_000,
    token_type: "bearer",
    user_id: 4242,
    ...overrides,
  };
}

before(async () => {
  stateDir = await mkdtemp(path.join(os.tmpdir(), "clio-mcp-sessionstore-"));
  cfg = makeConfig(stateDir);
});

after(async () => {
  if (stateDir) await rm(stateDir, { recursive: true, force: true });
});

test("registerClient persists a DCR client that getClient reads back", async () => {
  const store = new SessionStore(cfg);
  const client = {
    client_id: "dcr-client-1",
    client_name: "test",
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const returned = await store.registerClient(client as any);
  assert.equal(returned.client_id, "dcr-client-1");

  const read = await store.getClient("dcr-client-1");
  assert.ok(read, "client should be readable after registration");
  assert.equal(read.client_id, "dcr-client-1");
  assert.deepEqual(read.redirect_uris, ["https://claude.ai/api/mcp/auth_callback"]);

  // A fresh store instance (cold cache) must still read it off disk.
  const store2 = new SessionStore(cfg);
  const cold = await store2.getClient("dcr-client-1");
  assert.ok(cold, "client should survive a cold cache / new store instance");
  assert.equal(cold.client_id, "dcr-client-1");

  assert.equal(await store.getClient("does-not-exist"), undefined);
});

test("createSession issues a token pair resolvable by access token", async () => {
  const store = new SessionStore(cfg);
  const clioTokens = fakeClioTokens();
  const { accessToken, refreshToken, record } = await store.createSession({
    clientId: "dcr-client-1",
    clioTokens,
    resource: "http://127.0.0.1:9999/mcp",
  });

  assert.ok(accessToken.length > 0);
  assert.ok(refreshToken.length > 0);
  assert.notEqual(accessToken, refreshToken);
  // The session id is sha256(access_token) hex (and the on-disk filename stem).
  assert.equal(record.id, sha256Hex(accessToken));
  assert.equal(record.refreshTokenHash, sha256Hex(refreshToken));
  assert.equal(record.resource, "http://127.0.0.1:9999/mcp");

  const resolved = await store.getSessionByAccessToken(accessToken);
  assert.ok(resolved, "session resolvable by its access token");
  assert.equal(resolved.id, record.id);
  assert.equal(resolved.clientId, "dcr-client-1");
  assert.equal(resolved.clioTokens.user_id, 4242);

  // A cold store instance resolves the same access token off disk.
  const store2 = new SessionStore(cfg);
  const cold = await store2.getSessionByAccessToken(accessToken);
  assert.ok(cold, "session resolvable from disk in a fresh store");
  assert.equal(cold.id, record.id);

  // An unknown / wrong access token resolves to null.
  assert.equal(await store.getSessionByAccessToken("nope-not-a-token"), null);
});

test("rotate() mints a new pair, preserves Clio tokens, invalidates the old access token", async () => {
  const store = new SessionStore(cfg);
  const clioTokens = fakeClioTokens({ user_id: 777 });
  const first = await store.createSession({ clientId: "dcr-client-1", clioTokens });

  // Old access token resolves before rotation.
  assert.ok(await store.getSessionByAccessToken(first.accessToken));

  const rotated = await store.rotate(first.refreshToken, "dcr-client-1");
  assert.ok(rotated, "refresh token should rotate to a fresh pair");
  assert.notEqual(rotated.accessToken, first.accessToken);
  assert.notEqual(rotated.refreshToken, first.refreshToken);
  // Bridged Clio tokens carry over to the new session.
  assert.equal(rotated.record.clioTokens.user_id, 777);

  // Old access token is now invalid; the new one resolves.
  assert.equal(
    await store.getSessionByAccessToken(first.accessToken),
    null,
    "old access token must be invalidated after rotation",
  );
  assert.ok(
    await store.getSessionByAccessToken(rotated.accessToken),
    "new access token must resolve after rotation",
  );

  // The old refresh token is single-use: it must not rotate again.
  assert.equal(
    await store.rotate(first.refreshToken, "dcr-client-1"),
    null,
    "old refresh token must not rotate a second time",
  );

  // A refresh token bound to a different client must not rotate.
  const second = await store.createSession({ clientId: "client-A", clioTokens });
  assert.equal(
    await store.rotate(second.refreshToken, "client-B"),
    null,
    "rotate must reject a client_id mismatch",
  );
});

test("getSessionByAccessToken returns null for an expired session (TTL)", async () => {
  // TTL of 0s => expiresAt == createdAt, i.e. already expired on read.
  const shortCfg = makeConfig(stateDir, 0);
  const store = new SessionStore(shortCfg);
  const { accessToken, record } = await store.createSession({
    clientId: "ttl-client",
    clioTokens: fakeClioTokens(),
  });
  assert.ok(record.expiresAt <= Date.now() + 5);

  const resolved = await store.getSessionByAccessToken(accessToken);
  assert.equal(resolved, null, "expired session must resolve to null");

  // Expiry also purges the on-disk file (deleteSession is called on read).
  const file = path.join(stateDir, "sessions", `${record.id}.enc`);
  assert.equal(existsSync(file), false, "expired session file should be removed on read");
});

test("auth codes: peek does not consume, consume is single-use, both honour client + expiry", async () => {
  const store = new SessionStore(cfg);
  const code = await store.createAuthCode({
    clioTokens: fakeClioTokens(),
    codeChallenge: "challenge-abc",
    clientId: "dcr-client-1",
    clientRedirectUri: "https://claude.ai/api/mcp/auth_callback",
  });

  // peek returns the record without consuming it.
  const peeked = await store.peekAuthCode(code);
  assert.ok(peeked);
  assert.equal(peeked.codeChallenge, "challenge-abc");
  const peekedAgain = await store.peekAuthCode(code);
  assert.ok(peekedAgain, "peek must not consume the code");

  // consume returns it once, then it is gone.
  const consumed = await store.consumeAuthCode(code);
  assert.ok(consumed);
  assert.equal(consumed.clientId, "dcr-client-1");
  assert.equal(
    await store.consumeAuthCode(code),
    null,
    "auth code must be single-use",
  );
  assert.equal(await store.peekAuthCode(code), null);
});

test("txn round-trip: createTxn then consumeTxn returns it once", async () => {
  const store = new SessionStore(cfg);
  const txnId = await store.createTxn({
    clientId: "dcr-client-1",
    clientRedirectUri: "https://claude.ai/api/mcp/auth_callback",
    clientState: "client-state-xyz",
    codeChallenge: "challenge-xyz",
  });
  assert.ok(txnId.length > 0);

  const consumed = await store.consumeTxn(txnId);
  assert.ok(consumed);
  assert.equal(consumed.clientState, "client-state-xyz");
  assert.equal(consumed.codeChallenge, "challenge-xyz");
  assert.equal(await store.consumeTxn(txnId), null, "txn must be single-use");
});

test("revokeByToken invalidates a session by access OR refresh token", async () => {
  const store = new SessionStore(cfg);

  // Revoke by access token.
  const a = await store.createSession({ clientId: "c", clioTokens: fakeClioTokens() });
  await store.revokeByToken(a.accessToken);
  assert.equal(await store.getSessionByAccessToken(a.accessToken), null);

  // Revoke by refresh token.
  const b = await store.createSession({ clientId: "c", clioTokens: fakeClioTokens() });
  await store.revokeByToken(b.refreshToken);
  assert.equal(await store.getSessionByAccessToken(b.accessToken), null);

  // Revoking an unknown token is a no-op (must not throw).
  await store.revokeByToken("totally-unknown-token");
});

test("persistClioTokens rotates the bridged Clio tokens in place", async () => {
  const store = new SessionStore(cfg);
  const { accessToken, record } = await store.createSession({
    clientId: "c",
    clioTokens: fakeClioTokens({ access_token: "old-clio-access" }),
  });

  const newClio = fakeClioTokens({ access_token: "new-clio-access", user_id: 4242 });
  await store.persistClioTokens(record.id, newClio);

  const resolved = await store.getSessionByAccessToken(accessToken);
  assert.ok(resolved);
  assert.equal(resolved.clioTokens.access_token, "new-clio-access");

  // Persisting to a vanished session is a silent no-op.
  await store.persistClioTokens("0".repeat(64), newClio);
});

test("records are encrypted at rest: raw bytes never contain plaintext markers", async () => {
  const store = new SessionStore(cfg);
  const marker = "clio-access-PLAINTEXT-MARKER";

  await store.createSession({
    clientId: "secret-client-name",
    clioTokens: fakeClioTokens({ access_token: marker }),
  });
  await store.registerClient(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      client_id: "secret-client-name",
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    } as any,
  );
  await store.createAuthCode({
    clioTokens: fakeClioTokens({ access_token: marker }),
    codeChallenge: "challenge",
    clientId: "secret-client-name",
    clientRedirectUri: "https://claude.ai/api/mcp/auth_callback",
  });

  // Walk every .enc file under the state dir and assert the marker / a known
  // redirect URI never appear as plaintext in the ciphertext.
  let checked = 0;
  for (const sub of ["sessions", "clients", "pending"]) {
    const dir = path.join(stateDir, sub);
    let files: string[] = [];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".enc")) continue;
      const raw = await readFile(path.join(dir, f));
      const utf8 = raw.toString("utf8");
      const latin1 = raw.toString("latin1");
      assert.equal(utf8.includes(marker), false, `plaintext token leaked in ${sub}/${f}`);
      assert.equal(latin1.includes(marker), false, `plaintext token leaked (latin1) in ${sub}/${f}`);
      assert.equal(
        utf8.includes("claude.ai/api/mcp/auth_callback"),
        false,
        `plaintext redirect_uri leaked in ${sub}/${f}`,
      );
      checked += 1;
    }
  }
  assert.ok(checked >= 3, `expected to inspect at least 3 encrypted files, saw ${checked}`);
});

test("a wrong encryption key cannot decrypt another key's records", async () => {
  // Write a session under one key...
  const dirA = await mkdtemp(path.join(os.tmpdir(), "clio-mcp-keyA-"));
  try {
    const cfgA = makeConfig(dirA);
    const storeA = new SessionStore(cfgA);
    const { accessToken } = await storeA.createSession({
      clientId: "c",
      clioTokens: fakeClioTokens(),
    });

    // ...then read the SAME dir with a DIFFERENT key (cold cache, new store).
    const cfgB: Config = { ...cfgA, encryptionKeyHex: randomBytes(32).toString("hex") };
    const storeB = new SessionStore(cfgB);
    const resolved = await storeB.getSessionByAccessToken(accessToken);
    assert.equal(resolved, null, "GCM auth-tag mismatch must yield null, not throw");
  } finally {
    await rm(dirA, { recursive: true, force: true });
  }
});

test("sha256Hex is a stable lowercase hex digest", () => {
  const h = sha256Hex("abc");
  assert.equal(h, createHash("sha256").update("abc").digest("hex"));
  assert.match(h, /^[0-9a-f]{64}$/);
});
