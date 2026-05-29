#!/usr/bin/env node
// End-to-end smoke test of the HTTP MCP transport. Spawns the built binary
// in --http mode, polls /healthz, then uses the official MCP SDK Client
// (over StreamableHTTPClientTransport) to drive a real protocol session.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 18765 + Math.floor(Math.random() * 100);
const TOKEN = randomBytes(16).toString("hex");

const env = {
  ...process.env,
  CLIO_CLIENT_ID: "smoke-test",
  CLIO_CLIENT_SECRET: "smoke-test",
  CLIO_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  CLIO_STATE_DIR: "/tmp/clio-mcp-smoke-http",
  CLIO_AUDIT_MODE: "none",
  CLIO_HTTP_PORT: String(PORT),
  CLIO_HTTP_HOST: "127.0.0.1",
  CLIO_HTTP_AUTH_TOKENS: TOKEN,
  // This script exercises the shared static-bearer path; pin the mode so it
  // does not require PUBLIC_BASE_URL (the OAuth/hybrid modes do — see
  // scripts/smoke-oauth.mjs for end-to-end coverage of the connector flow).
  MCP_AUTH_MODE: "static",
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

const base = `http://127.0.0.1:${PORT}`;

// 1. Wait for /healthz
let ready = false;
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(`${base}/healthz`);
    if (r.ok) { ready = true; break; }
  } catch {}
  await sleep(150);
}
if (!ready) fail("server never returned 200 on /healthz");
console.log("✓ /healthz ready");

// 2. Auth required: a request with no bearer should 401
const noauth = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
});
if (noauth.status !== 401) fail(`expected 401 without bearer, got ${noauth.status}`);
console.log("✓ /mcp without bearer -> 401");

// 3. With a bad bearer also 401
const bad = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: "Bearer not-the-right-one",
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
});
if (bad.status !== 401) fail(`expected 401 with bad bearer, got ${bad.status}`);
console.log("✓ /mcp with wrong bearer -> 401");

// 4. With the right bearer, drive a real session through the SDK Client.
const client = new Client({ name: "smoke-http", version: "0.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
  requestInit: {
    headers: { Authorization: `Bearer ${TOKEN}` },
  },
});
await client.connect(transport);
console.log("✓ Client.connect (initialize round-trip) succeeded");

const tools = await client.listTools();
if (!Array.isArray(tools.tools) || tools.tools.length < 30) {
  fail(`tools/list returned ${tools.tools?.length}`);
}
console.log(`✓ tools/list -> ${tools.tools.length} tools`);

const r = await client.readResource({ uri: "clio://auth/status" });
if (!r?.contents?.[0]?.text) fail("auth status resource empty");
const parsed = JSON.parse(r.contents[0].text);
if (parsed.authenticated !== false) fail(`expected unauthenticated, got ${parsed.authenticated}`);
console.log("✓ resources/read clio://auth/status -> authenticated:false");

// 5. Method-not-allowed on GET
const get = await fetch(`${base}/mcp`, {
  headers: { Authorization: `Bearer ${TOKEN}` },
});
if (get.status !== 405) fail(`expected 405 on GET /mcp, got ${get.status}`);
console.log("✓ GET /mcp -> 405 (server is stateless POST-only)");

await transport.close();
proc.kill();
console.log("\nALL HTTP CHECKS PASSED ✓");
process.exit(0);
