import { URL } from "node:url";

import type { Response } from "express";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidGrantError,
  InvalidTokenError,
  ServerError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";

import type { Config } from "../config.js";
import type { OAuthFlow } from "./oauth.js";
import { SessionStore } from "./sessionStore.js";
import { log } from "../util/logger.js";

/**
 * OAuth 2.1 Authorization-Server provider that BRIDGES each MCP client to the
 * end user's own Clio account.
 *
 * The SDK's `mcpAuthRouter` drives this provider through the standard
 * discovery/registration/authorize/token endpoints. The flow:
 *
 *   1. /authorize → {@link authorize}: persist a `txn` and 302 the browser to
 *      Clio's authorize endpoint, with our `/oauth/clio/callback` as Clio's
 *      redirect URI and the txn id as Clio's `state`.
 *   2. Clio → /oauth/clio/callback (handled in the HTTP transport, not here):
 *      exchange Clio's code for Clio tokens, mint an MCP authorization code,
 *      then 302 back to the client's redirect URI with our code + their state.
 *   3. /token (authorization_code) → SDK verifies PKCE against
 *      {@link challengeForAuthorizationCode}, then {@link exchangeAuthorizationCode}
 *      mints an MCP session (access + refresh) bridged to the Clio tokens.
 *   4. /token (refresh_token) → {@link exchangeRefreshToken} rotates the MCP
 *      tokens while preserving the bridged Clio tokens.
 *   5. /mcp requests → {@link verifyAccessToken} resolves the session.
 *
 * We keep PKCE verification local ({@link skipLocalPkceValidation} = false): we
 * stash the client's `code_challenge` and let the SDK verify the verifier. Clio
 * is a plain OAuth2 server upstream and is not involved in the client↔MCP PKCE.
 */
export class ClioOAuthProvider implements OAuthServerProvider {
  /** PKCE is validated locally by the SDK using the stored code_challenge. */
  readonly skipLocalPkceValidation = false;

  constructor(
    private readonly cfg: Config,
    private readonly oauth: OAuthFlow,
    private readonly sessions: SessionStore,
    /** Fixed public base URL (no trailing slash). Required in oauth/hybrid. */
    private readonly baseUrl: string,
  ) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    return this.sessions;
  }

  /** The Clio Developer Application redirect URI this server listens on. */
  clioRedirectUri(): string {
    return `${this.baseUrl}/oauth/clio/callback`;
  }

  /**
   * Begin authorization by redirecting the user-agent to Clio.
   *
   * The SDK has already validated the client and that `params.redirectUri`
   * matches a registered redirect URI. We persist a short-lived txn keyed by an
   * opaque id and pass that id to Clio as `state` so the callback can correlate.
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const txnId = await this.sessions.createTxn({
      clientId: client.client_id,
      clientRedirectUri: params.redirectUri,
      ...(params.state !== undefined ? { clientState: params.state } : {}),
      codeChallenge: params.codeChallenge,
      ...(params.resource !== undefined ? { resource: params.resource.href } : {}),
    });

    const clioAuthorize = new URL(this.cfg.authorizeUrl);
    clioAuthorize.searchParams.set("response_type", "code");
    clioAuthorize.searchParams.set("client_id", this.cfg.clientId);
    clioAuthorize.searchParams.set("redirect_uri", this.clioRedirectUri());
    clioAuthorize.searchParams.set("state", txnId);
    if (this.cfg.clioOAuthScopes) {
      clioAuthorize.searchParams.set("scope", this.cfg.clioOAuthScopes);
    }

    log.info("bridging authorize to Clio", {
      client_id: client.client_id,
      txn: txnId.slice(0, 8),
    });
    res.redirect(302, clioAuthorize.toString());
  }

  /**
   * Return the PKCE challenge stashed for an MCP authorization code so the SDK
   * can verify the presented code_verifier. We must NOT consume the code here;
   * the SDK calls {@link exchangeAuthorizationCode} immediately afterwards.
   */
  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const rec = await this.sessions.peekAuthCode(authorizationCode);
    if (!rec || rec.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    return rec.codeChallenge;
  }

  /**
   * Exchange an MCP authorization code for an MCP session.
   *
   * PKCE was already verified by the SDK (skipLocalPkceValidation = false), so
   * `codeVerifier` is undefined here. We consume the code (single-use), bind a
   * new session to the Clio tokens, and return the MCP token pair.
   */
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    _resource?: URL,
  ): Promise<OAuthTokens> {
    const rec = await this.sessions.consumeAuthCode(authorizationCode);
    if (!rec || rec.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    // RFC 6749 §4.1.3: if a redirect_uri was used in the authorize request, the
    // token request's redirect_uri MUST match it exactly.
    if (redirectUri !== undefined && redirectUri !== rec.clientRedirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }

    const issued = await this.sessions.createSession({
      clientId: client.client_id,
      clioTokens: rec.clioTokens,
      ...(rec.resource !== undefined ? { resource: rec.resource } : {}),
    });

    log.info("issued MCP session", {
      client_id: client.client_id,
      session: issued.record.id.slice(0, 8),
      clio_user_id: rec.clioTokens.user_id,
    });

    return this.tokensFor(issued);
  }

  /**
   * Rotate the MCP token pair for a refresh-token grant. The bridged Clio
   * tokens are preserved on the new session; the old session is invalidated.
   */
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    _resource?: URL,
  ): Promise<OAuthTokens> {
    const issued = await this.sessions.rotate(refreshToken, client.client_id);
    if (!issued) {
      throw new InvalidGrantError("Invalid or expired refresh token");
    }
    log.info("rotated MCP session", {
      client_id: client.client_id,
      session: issued.record.id.slice(0, 8),
    });
    return this.tokensFor(issued);
  }

  /**
   * Verify a presented MCP access token and return its auth info.
   *
   * This only resolves the MCP session. The user's Clio access token is
   * refreshed lazily by the session-bound ClioClient on its next Clio call (and
   * persisted back into the session record via SessionTokenProvider), so nothing
   * Clio-side happens here. `expiresAt` is returned in SECONDS — the SDK's bearer
   * middleware compares it against `Date.now() / 1000`.
   */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const session = await this.sessions.getSessionByAccessToken(token);
    if (!session) {
      // InvalidTokenError is the one error the SDK's bearer middleware maps to a
      // 401 + RFC 9728 WWW-Authenticate challenge (other OAuthErrors become 400).
      throw new InvalidTokenError("invalid or expired access token");
    }
    return {
      token,
      clientId: session.clientId,
      scopes: [],
      expiresAt: Math.floor(session.expiresAt / 1000),
      ...(session.resource !== undefined ? { resource: new URL(session.resource) } : {}),
      extra: { sessionId: session.id },
    };
  }

  /** Revoke an MCP access or refresh token (RFC 7009). Best-effort. */
  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    await this.sessions.revokeByToken(request.token);
  }

  /** Shape an issued session into the SDK's OAuthTokens response. */
  private tokensFor(issued: {
    accessToken: string;
    refreshToken: string;
    record: { expiresAt: number; createdAt: number };
  }): OAuthTokens {
    const expiresIn = Math.max(
      1,
      Math.floor((issued.record.expiresAt - Date.now()) / 1000),
    );
    return {
      access_token: issued.accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      refresh_token: issued.refreshToken,
    };
  }
}

// Surface ServerError so callers can throw a typed 500 where appropriate.
export { ServerError };
