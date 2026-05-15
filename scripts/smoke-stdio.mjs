#!/usr/bin/env node
// End-to-end smoke test of the stdio MCP transport. Spawns the built binary
// with fake-but-valid env, sends initialize + tools/list + resources/list over
// stdin as JSON-RPC, asserts the server responds in spec.
//
// Exits 0 on success, 1 on any protocol failure.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const env = {
  ...process.env,
  CLIO_CLIENT_ID: "smoke-test",
  CLIO_CLIENT_SECRET: "smoke-test",
  CLIO_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  CLIO_STATE_DIR: "/tmp/clio-mcp-smoke",
  CLIO_AUDIT_MODE: "none",
  LOG_LEVEL: "error",
};

const proc = spawn(process.execPath, ["build/index.js", "--stdio"], { env });

let stdoutBuf = "";
const pending = new Map();
let nextId = 1;
let stderrBuf = "";

proc.stderr.on("data", (d) => { stderrBuf += d.toString(); });

proc.stdout.on("data", (chunk) => {
  stdoutBuf += chunk.toString();
  let nl;
  while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
    const line = stdoutBuf.slice(0, nl).trim();
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { fail(`bad JSON on stdout: ${line}`); return; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  }
});

function call(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }
    }, 10_000);
  });
}

function notify(method, params) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function fail(msg) {
  console.error("FAIL:", msg);
  if (stderrBuf) console.error("stderr was:\n" + stderrBuf);
  proc.kill();
  process.exit(1);
}

try {
  // 1. initialize
  const init = await call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0.0.0" },
  });
  if (!init?.serverInfo?.name) fail("initialize missing serverInfo");
  console.log("✓ initialize ->", init.serverInfo.name, init.serverInfo.version);

  notify("notifications/initialized");

  // 2. tools/list
  const tools = await call("tools/list", {});
  if (!Array.isArray(tools?.tools)) fail("tools/list did not return an array");
  if (tools.tools.length < 30) fail(`expected ≥30 tools, got ${tools.tools.length}`);
  console.log(`✓ tools/list -> ${tools.tools.length} tools`);

  const expected = [
    "clio_authenticate",
    "clio_who_am_i",
    "clio_list_matters",
    "clio_create_matter",
    "clio_search_contacts",
    "clio_create_time_entry",
    "clio_create_note",
    "clio_open_new_matter",
    "clio_api_request",
  ];
  const names = new Set(tools.tools.map((t) => t.name));
  for (const e of expected) if (!names.has(e)) fail(`missing tool: ${e}`);
  console.log("✓ tool catalog includes expected names");

  // 3. resources/list
  const res = await call("resources/list", {});
  if (!Array.isArray(res?.resources)) fail("resources/list did not return an array");
  const uris = new Set(res.resources.map((r) => r.uri));
  for (const u of ["clio://compliance/notice", "clio://auth/status"]) {
    if (!uris.has(u)) fail(`missing resource: ${u}`);
  }
  console.log(`✓ resources/list -> ${res.resources.length} resources`);

  // 4. resources/read for the auth status — should work without authentication
  const auth = await call("resources/read", { uri: "clio://auth/status" });
  if (!auth?.contents?.[0]?.text) fail("auth status resource returned empty");
  const parsed = JSON.parse(auth.contents[0].text);
  if (parsed.authenticated !== false) fail(`expected unauthenticated, got ${parsed.authenticated}`);
  console.log("✓ resources/read clio://auth/status -> authenticated:false");

  // 5. tool call that requires auth should fail cleanly (not crash the server)
  const whoami = await call("tools/call", { name: "clio_who_am_i", arguments: {} });
  if (!whoami?.isError) fail("expected clio_who_am_i to error when unauthenticated");
  console.log("✓ tools/call clio_who_am_i (no auth) -> isError:true");

  console.log("\nALL CHECKS PASSED ✓");
  proc.kill();
  process.exit(0);
} catch (err) {
  fail(err.message);
}
