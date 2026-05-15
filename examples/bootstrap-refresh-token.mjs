#!/usr/bin/env node
/**
 * Bootstrap a Clio refresh token for headless / Azure deployments.
 *
 *   node examples/bootstrap-refresh-token.mjs
 *
 * Runs the OAuth authorization-code flow against Clio (same dance as the
 * `clio_authenticate` tool), but writes the refresh token to stdout instead
 * of encrypted disk. Drop the resulting value into Key Vault as
 * `clio-refresh-token`; the deployed Container App reads it on startup via
 * the `CLIO_BOOTSTRAP_REFRESH_TOKEN` env var.
 *
 * Required env: CLIO_CLIENT_ID, CLIO_CLIENT_SECRET, CLIO_REGION.
 * Optional:     CLIO_REDIRECT_PORT (default 5678), CLIO_REDIRECT_HOST (127.0.0.1).
 */
import http from "node:http";
import { randomBytes } from "node:crypto";
import { exec } from "node:child_process";
import { promisify } from "node:util";

import "dotenv/config";

const REGION_HOSTS = {
  us: "app.clio.com",
  ca: "ca.app.clio.com",
  eu: "eu.app.clio.com",
  au: "au.app.clio.com",
};

const region = (process.env.CLIO_REGION ?? "us").toLowerCase();
const host = REGION_HOSTS[region];
if (!host) throw new Error(`CLIO_REGION must be one of: ${Object.keys(REGION_HOSTS).join(", ")}`);

const clientId = need("CLIO_CLIENT_ID");
const clientSecret = need("CLIO_CLIENT_SECRET");
const redirectHost = process.env.CLIO_REDIRECT_HOST ?? "127.0.0.1";
const redirectPort = Number.parseInt(process.env.CLIO_REDIRECT_PORT ?? "5678", 10);
const redirectUri = `http://${redirectHost}:${redirectPort}/callback`;
const state = randomBytes(16).toString("hex");

const authorizeUrl = new URL(`https://${host}/oauth/authorize`);
authorizeUrl.searchParams.set("response_type", "code");
authorizeUrl.searchParams.set("client_id", clientId);
authorizeUrl.searchParams.set("redirect_uri", redirectUri);
authorizeUrl.searchParams.set("state", state);

const code = await new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, `http://${redirectHost}:${redirectPort}`);
    if (u.pathname !== "/callback") {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const c = u.searchParams.get("code");
    const s = u.searchParams.get("state");
    if (!c || s !== state) {
      res.writeHead(400);
      res.end("invalid state or missing code");
      server.close();
      reject(new Error("invalid state or missing code"));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<h1>Authentication successful</h1><p>You can close this window.</p>`);
    server.close();
    resolve(c);
  });
  server.listen(redirectPort, redirectHost, async () => {
    console.error(`Listening on ${redirectUri}`);
    console.error(`Opening: ${authorizeUrl.toString()}`);
    try {
      await openUrl(authorizeUrl.toString());
    } catch {
      console.error("Could not auto-open browser. Open this URL manually:");
      console.error(authorizeUrl.toString());
    }
  });
  setTimeout(() => {
    server.close();
    reject(new Error("OAuth callback timed out after 5 minutes"));
  }, 5 * 60 * 1000).unref();
});

console.error("Exchanging code for tokens…");
const res = await fetch(`https://${host}/oauth/token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  }),
});
if (!res.ok) {
  const body = await res.text();
  throw new Error(`token exchange failed: ${res.status} ${body}`);
}
const tokens = await res.json();
console.error("✓ Done.\n");
console.error("Drop this into Key Vault as `clio-refresh-token`:\n");
process.stdout.write(`${tokens.refresh_token}\n`);

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function openUrl(url) {
  const execAsync = promisify(exec);
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  await execAsync(cmd);
}
