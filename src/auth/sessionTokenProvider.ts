import type { TokenProvider } from "../clio/client.js";
import type { TokenSet } from "./storage.js";
import type { SessionStore } from "./sessionStore.js";

/**
 * A {@link TokenProvider} bound to one OAuth-bridge session.
 *
 * Built per `/mcp` request from `req.auth.extra.sessionId`. It serves the
 * session's bridged Clio tokens to a freshly-constructed {@link
 * import("../clio/client.js").ClioClient} and, when the client rotates the
 * Clio access token, persists the new tokens back into the session record via
 * {@link SessionStore.persistClioTokens} — so Clio refresh-token rotation
 * survives subsequent requests and replica hops.
 *
 * Holds an in-memory copy of the current tokens so multiple calls within a
 * single request see rotations immediately without re-reading disk.
 */
export class SessionTokenProvider implements TokenProvider {
  constructor(
    private readonly sessions: SessionStore,
    private readonly sessionId: string,
    private current: TokenSet,
  ) {}

  get(): TokenSet | null {
    return this.current;
  }

  async set(tokens: TokenSet): Promise<void> {
    this.current = tokens;
    await this.sessions.persistClioTokens(this.sessionId, tokens);
  }
}
