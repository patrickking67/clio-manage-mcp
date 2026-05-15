import http from "node:http";
import { randomBytes } from "node:crypto";
import { URL } from "node:url";
import open from "open";

import type { Config } from "../config.js";
import { redirectUri } from "../config.js";
import { AuthError } from "../util/errors.js";
import { log } from "../util/logger.js";
import { TokenStorage, type TokenSet } from "./storage.js";

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000; // 5 min to complete login

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  user_id?: number;
}

export class OAuthFlow {
  constructor(
    private readonly cfg: Config,
    private readonly storage: TokenStorage,
  ) {}

  /**
   * Run the authorization-code flow against Clio:
   *   1. Start a local loopback HTTP server on the configured port
   *   2. Open the user's browser to Clio's authorize endpoint
   *   3. Receive the redirect, exchange code for tokens
   *   4. Persist encrypted tokens, return them
   */
  async authorize(opts: { openBrowser?: boolean } = {}): Promise<TokenSet> {
    const state = randomBytes(16).toString("hex");
    const redirect = redirectUri(this.cfg);

    const authorizeUrl = new URL(this.cfg.authorizeUrl);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", this.cfg.clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirect);
    authorizeUrl.searchParams.set("state", state);

    log.info("starting OAuth code flow", { authorizeUrl: authorizeUrl.toString() });

    const codePromise = this.listenForCallback(state);

    if (opts.openBrowser !== false) {
      try {
        await open(authorizeUrl.toString());
      } catch {
        log.warn("could not auto-open browser; please open this URL manually", {
          url: authorizeUrl.toString(),
        });
      }
    } else {
      log.info("open this URL in a browser to continue", { url: authorizeUrl.toString() });
    }

    const code = await codePromise;
    const tokens = await this.exchangeCode(code, redirect);
    await this.storage.save(tokens);
    log.info("authorization complete; tokens persisted (encrypted)");
    return tokens;
  }

  /** Use the saved refresh token to mint a new access token. */
  async refresh(refreshToken: string): Promise<TokenSet> {
    const res = await fetch(this.cfg.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new AuthError(
        `refresh failed: ${res.status} ${body}`,
        "Re-run authenticate to mint a fresh refresh token. " +
          "Refresh tokens are revoked when scopes change or the user revokes the app in Clio.",
      );
    }
    const json = (await res.json()) as TokenResponse;
    const tokens: TokenSet = {
      access_token: json.access_token,
      refresh_token: json.refresh_token ?? refreshToken,
      expires_at: Date.now() + json.expires_in * 1000,
      token_type: json.token_type,
      user_id: json.user_id,
    };
    await this.storage.save(tokens);
    return tokens;
  }

  private async exchangeCode(code: string, redirect: string): Promise<TokenSet> {
    const res = await fetch(this.cfg.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirect,
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new AuthError(
        `code exchange failed: ${res.status} ${body}`,
        "Confirm that the Redirect URI in your Clio Developer Application " +
          `matches exactly: ${redirect}`,
      );
    }
    const json = (await res.json()) as TokenResponse;
    return {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_at: Date.now() + json.expires_in * 1000,
      token_type: json.token_type,
      user_id: json.user_id,
    };
  }

  private listenForCallback(expectedState: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        if (!req.url) {
          res.writeHead(400);
          res.end("bad request");
          return;
        }
        const reqUrl = new URL(req.url, `http://${this.cfg.redirectHost}:${this.cfg.redirectPort}`);
        if (reqUrl.pathname !== "/callback") {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        const code = reqUrl.searchParams.get("code");
        const state = reqUrl.searchParams.get("state");
        const error = reqUrl.searchParams.get("error");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`<h1>Authorization failed</h1><pre>${escapeHtml(error)}</pre>`);
          server.close();
          reject(new AuthError(`Clio returned error: ${error}`));
          return;
        }
        if (!code || state !== expectedState) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`<h1>Authorization failed</h1><p>Missing or invalid state.</p>`);
          server.close();
          reject(new AuthError("OAuth state mismatch — possible CSRF; aborting"));
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
          <!doctype html><html><head><meta charset="utf-8">
          <title>Clio MCP — authenticated</title>
          <style>body{font-family:system-ui;margin:3rem;max-width:36rem}h1{color:#0a7}</style>
          </head><body>
          <h1>Authentication successful</h1>
          <p>You can close this window and return to your MCP client.</p>
          </body></html>
        `);
        server.close();
        resolve(code);
      });

      server.on("error", (err) => {
        reject(
          new AuthError(
            `Could not bind loopback ${this.cfg.redirectHost}:${this.cfg.redirectPort}: ${
              err instanceof Error ? err.message : String(err)
            }`,
            "Another process is already using that port. Change CLIO_REDIRECT_PORT and update the Redirect URI in your Clio Developer Application to match.",
          ),
        );
      });

      const timer = setTimeout(() => {
        server.close();
        reject(new AuthError("OAuth callback timed out after 5 minutes"));
      }, CALLBACK_TIMEOUT_MS);
      timer.unref();

      server.listen(this.cfg.redirectPort, this.cfg.redirectHost);
    });
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
