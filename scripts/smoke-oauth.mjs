#!/usr/bin/env node
// End-to-end smoke test of the OAuth 2.1 remote-connector HTTP transport.
// Spawns the built binary in --http mode with MCP_AUTH_MODE=oauth and a
// loopback PUBLIC_BASE_URL (accepted by the SDK without any insecure flag),
// polls /healthz, then asserts the full custom-connector contract:
//   - /mcp without/with bad bearer -> 401 + WWW-Authenticate w/ resource_metadata
//   - both .well-known discovery docs + required fields
//   - RFC 7591 DCR (/register) returns a client_id
//   - /authorize 302s to the Clio authorize host with our redirect_uri + state
//   - GET /mcp -> 405
//
// The Clio leg itself cannot be completed (no real Clio creds); verifying the
// 302 target of /authorize is the goal. Exits 0 on success, non-zero (with the
// server stderr) on any failure.
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 19765 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const STATE_DIR = mkdtempSync(path.join(os.tmpdir(), "clio-mcp-smoke-oauth-"));

// Clio authorize host for region "us" (see src/config.ts REGION_HOSTS).
const CLIO_AUTHORIZE_URL = "https://app.clio.com/oauth/authorize";
const CLIENT_REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

const env = {
  ...process.env,
  CLIO_CLIENT_ID: "smoke-test",
  CLIO_CLIENT_SECRET: "smoke-test",
  CLIO_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  CLIO_STATE_DIR: STATE_DIR,
  CLIO_AUDIT_MODE: "none",
  CLIO_REGION: "us",
  CLIO_HTTP_HOST: "127.0.0.1",
  CLIO_HTTP_PORT: String(PORT),
  MCP_AUTH_MODE: "oauth",
  // Loopback base URL — the SDK allows a http://127.0.0.1:<port> issuer WITHOUT
  // any insecure flag. Do NOT set one.
  PUBLIC_BASE_URL: BASE,
  LOG_LEVEL: "warn",
};

const proc = spawn(process.execPath, ["build/index.js", "--http"], { env, stdio: "pipe" });
let stderrBuf = "";
proc.stderr.on("data", (d) => { stderrBuf += d.toString(); });
let exited = false;
proc.on("exit", () => { exited = true; });

function fail(msg) {
  console.error("FAIL:", msg);
  if (stderrBuf) console.error("server stderr:\n" + stderrBuf);
  if (!exited) proc.kill();
  process.exit(1);
}

// base64url(SHA-256(verifier)) — the S256 PKCE code_challenge.
function pkceChallenge(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

// The SDK constructs metadata URLs via `new URL(base)`, which appends a trailing
// slash to an origin-only issuer (e.g. "http://127.0.0.1:PORT/"). Compare base
// URLs by trimming trailing slashes so loopback issuers match the contract base.
function sameBase(a, b) {
  const norm = (s) => String(s).replace(/\/+$/, "");
  return norm(a) === norm(b);
}

// 1. Wait for /healthz
let ready = false;
let health;
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(`${BASE}/healthz`);
    if (r.ok) { health = await r.json(); ready = true; break; }
  } catch {}
  await sleep(150);
}
if (!ready) fail("server never returned 200 on /healthz");
if (health?.status !== "ok") fail(`/healthz status not ok: ${JSON.stringify(health)}`);
console.log("✓ /healthz -> 200 {status:\"ok\"}");

const expectedResourceMetadataUrl = `${BASE}/.well-known/oauth-protected-resource/mcp`;

// 2. /mcp without bearer -> 401 + WWW-Authenticate w/ resource_metadata
{
  const r = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  if (r.status !== 401) fail(`expected 401 without bearer, got ${r.status}`);
  const wwwAuth = r.headers.get("www-authenticate");
  if (!wwwAuth) fail("401 without bearer missing WWW-Authenticate header");
  if (!wwwAuth.includes(`resource_metadata="${expectedResourceMetadataUrl}"`)) {
    fail(`WWW-Authenticate missing resource_metadata="${expectedResourceMetadataUrl}"; got: ${wwwAuth}`);
  }
  console.log("✓ POST /mcp without bearer -> 401 + WWW-Authenticate resource_metadata");
}

// 3. /mcp with an invalid bearer -> 401 + WWW-Authenticate w/ resource_metadata
{
  const r = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: "Bearer not-a-real-session-token",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  if (r.status !== 401) fail(`expected 401 with bad bearer, got ${r.status}`);
  const wwwAuth = r.headers.get("www-authenticate");
  if (!wwwAuth || !wwwAuth.includes(`resource_metadata="${expectedResourceMetadataUrl}"`)) {
    fail(`bad-bearer 401 missing resource_metadata; got: ${wwwAuth}`);
  }
  console.log("✓ POST /mcp with invalid bearer -> 401 + WWW-Authenticate resource_metadata");
}

// 4. Protected Resource Metadata doc
{
  const r = await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`);
  if (!r.ok) fail(`oauth-protected-resource not OK: ${r.status}`);
  const doc = await r.json();
  if (doc.resource !== `${BASE}/mcp`) {
    fail(`PRM resource expected ${BASE}/mcp, got ${doc.resource}`);
  }
  if (
    !Array.isArray(doc.authorization_servers) ||
    !doc.authorization_servers.some((s) => sameBase(s, BASE))
  ) {
    fail(`PRM authorization_servers must contain ${BASE}; got ${JSON.stringify(doc.authorization_servers)}`);
  }
  console.log("✓ /.well-known/oauth-protected-resource/mcp -> resource + authorization_servers");
}

// 5. Authorization Server Metadata doc
let asMeta;
{
  const r = await fetch(`${BASE}/.well-known/oauth-authorization-server`);
  if (!r.ok) fail(`oauth-authorization-server not OK: ${r.status}`);
  asMeta = await r.json();
  for (const field of [
    "issuer",
    "authorization_endpoint",
    "token_endpoint",
    "registration_endpoint",
  ]) {
    if (!asMeta[field]) fail(`AS metadata missing ${field}`);
  }
  if (!sameBase(asMeta.issuer, BASE)) fail(`AS metadata issuer expected ${BASE}, got ${asMeta.issuer}`);
  if (
    !Array.isArray(asMeta.code_challenge_methods_supported) ||
    !asMeta.code_challenge_methods_supported.includes("S256")
  ) {
    fail(
      `AS metadata code_challenge_methods_supported must contain "S256"; got ${JSON.stringify(
        asMeta.code_challenge_methods_supported,
      )}`,
    );
  }
  console.log(
    "✓ /.well-known/oauth-authorization-server -> issuer + endpoints + S256",
  );
}

// 6. RFC 7591 Dynamic Client Registration
let clientId;
{
  const registrationEndpoint = asMeta.registration_endpoint ?? `${BASE}/register`;
  const r = await fetch(registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [CLIENT_REDIRECT_URI],
      client_name: "test",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (r.status !== 200 && r.status !== 201) {
    fail(`DCR expected 200/201, got ${r.status}: ${await r.text()}`);
  }
  const doc = await r.json();
  if (!doc.client_id) fail(`DCR response missing client_id: ${JSON.stringify(doc)}`);
  clientId = doc.client_id;
  console.log("✓ POST /register (DCR) -> client_id");
}

// 7. /authorize -> 302 to the Clio authorize host with our redirect_uri + state
{
  const verifier = randomBytes(40).toString("base64url"); // > 43 chars base64url
  const challenge = pkceChallenge(verifier);
  if (challenge.length < 43) fail(`code_challenge too short: ${challenge.length}`);

  const authorize = new URL(`${BASE}/authorize`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", CLIENT_REDIRECT_URI);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("state", "xyz");
  authorize.searchParams.set("scope", "clio");

  const r = await fetch(authorize, { redirect: "manual" });
  if (r.status !== 302) fail(`expected 302 from /authorize, got ${r.status}: ${await r.text()}`);
  const location = r.headers.get("location");
  if (!location) fail("/authorize 302 missing Location header");

  const loc = new URL(location);
  const clioHost = new URL(CLIO_AUTHORIZE_URL);
  if (loc.origin !== clioHost.origin || loc.pathname !== clioHost.pathname) {
    fail(`/authorize Location not the Clio authorize host; got ${loc.origin}${loc.pathname}`);
  }
  const sentRedirect = loc.searchParams.get("redirect_uri");
  if (sentRedirect !== `${BASE}/oauth/clio/callback`) {
    fail(`/authorize -> Clio redirect_uri expected ${BASE}/oauth/clio/callback, got ${sentRedirect}`);
  }
  if (!loc.searchParams.get("state")) {
    fail("/authorize -> Clio Location missing state");
  }
  console.log("✓ GET /authorize -> 302 to Clio host w/ our redirect_uri + state");
}

// 8. GET /mcp -> 405 (stateless POST-only)
{
  const r = await fetch(`${BASE}/mcp`);
  if (r.status !== 405) fail(`expected 405 on GET /mcp, got ${r.status}`);
  console.log("✓ GET /mcp -> 405 (stateless POST-only)");
}

proc.kill();
console.log("\nALL OAUTH CHECKS PASSED ✓");
process.exit(0);
