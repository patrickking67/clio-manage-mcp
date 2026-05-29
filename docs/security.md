# Security posture

Threat model + design notes for the security-conscious reviewer. The headline
deployment is a **per-user remote OAuth connector** on Azure; a shared-account
`static` mode is also available.

## What this server is and isn't

- **Is:** a programmable, audited boundary between an AI agent and Clio v4. In
  OAuth mode it's an OAuth 2.1 Authorization Server + Protected Resource that
  bridges each Claude user to **their own** Clio account. It issues Clio requests
  on a user's behalf with proper auth and pagination handling.
- **Isn't:** a Clio mirror, a data warehouse, or a credential broker that hands
  out long-lived shared keys. It does not cache, snapshot, or store Clio content
  beyond what's needed to return a tool result. Only OAuth tokens are persisted,
  encrypted, and (in OAuth mode) scoped to a single user's session.

## Data flow & trust boundaries (OAuth mode)

For a law firm, the meaningful boundaries are:

1. **User ↔ Clio sign-in.** The user authenticates **directly on Clio's domain**.
   The server never sees a Clio password — only the authorization `code` Clio
   redirects back, which it exchanges for that user's tokens.
2. **Claude ↔ server (the connector).** OAuth 2.1 with PKCE and Dynamic Client
   Registration. Claude obtains a short-lived MCP **session token** that maps to
   one encrypted session. An unauthenticated `/mcp` call returns 401 with an RFC
   9728 `WWW-Authenticate` challenge; it never exposes data.
3. **Server ↔ Clio (per request).** The server calls Clio v4 with that user's
   bridged access token, refreshing it transparently as it nears expiry.
4. **Server ↔ Azure platform.** Secrets come from Key Vault via managed identity;
   state (encrypted sessions + audit log) sits on a mounted Azure Files share.

Each user's session — and the Clio tokens inside it — is isolated. One user's
connector session cannot read another user's Clio data.

## Threat model — Azure (OAuth connector)

| Actor                              | Capability                                                              | Mitigation                                                                                          |
|------------------------------------|-------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------|
| Internet attacker, no token        | POST `/mcp`                                                             | 401 + RFC 9728 challenge; no data returned                                                          |
| Internet attacker, stolen session  | Act as that one user until the session/Clio token expires or is revoked | Sessions are short-lived (`MCP_SESSION_TTL_SECONDS`, 30d default) and revocable via `/revoke` or Clio |
| Attacker forging the OAuth flow     | Trade a stolen auth code / skip PKCE                                    | Single-use auth codes, PKCE verified locally by the SDK, CSRF `state` bound to each transaction      |
| Internet attacker, `GET /mcp`      | Probe                                                                   | 405 Method Not Allowed (server is stateless POST-only)                                              |
| One user reading another's data    | Cross-tenant access                                                    | Tokens are bridged per session; a session resolves to exactly one Clio account                       |
| Azure RBAC compromise              | Read Key Vault secrets                                                  | Enable Key Vault firewall / private endpoint (not in default Bicep — extend if needed)               |
| Container compromise               | Read encryption key / client secret from env                            | Key Vault references mount as in-memory env vars, not on the file system                             |
| Container / file-share compromise  | Read `/state` (`sessions/`, `tokens.enc`, `audit.log`)                  | Sessions + tokens encrypted at rest with AES-256-GCM. Audit log is metadata — review your audit mode |
| File share key leak                | Read state files directly out of Azure Storage                          | Tokens still encrypted. Consider Storage encryption-at-rest with a customer-managed key              |

## Threat model — local (stdio)

| Actor                      | Capability                                                                 | Mitigation                                                              |
|----------------------------|----------------------------------------------------------------------------|-------------------------------------------------------------------------|
| Local user                 | Read `~/.clio-mcp/tokens.enc` and the audit log                            | Files `chmod 600`; encryption needs the key, which lives in env / shell |
| Local malware              | Read env vars + token file                                                 | OS-keychain integration on roadmap; for now, treat env vars as secrets  |
| Local user with the key    | Decrypt token file → impersonate the user against Clio                     | Inherent to OAuth — same as having the user's password                  |
| Process snooping the stdio | Read MCP protocol traffic (which may include Clio content)                 | stdio is between the client and this process; no cross-process exposure |

## Key Vault, managed identity, least privilege

- **No secrets on disk.** Clio client id/secret and the encryption key are Key
  Vault secrets, referenced by the Container App and injected as in-memory env
  vars at runtime via a **user-assigned managed identity** (Key Vault Secrets
  User + ACR pull). The identity has only those two roles.
- **OAuth mode keeps the secret surface minimal** — three Key Vault secrets and
  no shared bearer token. The static-mode secrets (`clio-http-auth-tokens`,
  `clio-refresh-token`) are wired by the Bicep **only** when the mode isn't
  `oauth`.
- **Clio scope** is the firm's lever for least privilege at the Clio side: grant
  the Developer Application only the scopes the MCP needs (matters, contacts,
  activities, users, notes, tasks, bills, calendar, documents). Narrowing scopes
  narrows what any session can do.

## Encryption & audit

- **Per-session encryption.** Sessions and bridged Clio tokens are stored as
  encrypted records (AES-256-GCM, authenticated encryption) keyed by
  `CLIO_ENCRYPTION_KEY`. Tampered ciphertext fails decryption rather than
  silently using a partial value.
- **Append-only audit log.** Every tool call records ISO timestamp, tool name,
  outcome, duration, Clio user id, matter id (when applicable), result count,
  transport, and a per-caller fingerprint. `metadata` mode (default) omits
  argument payloads; `full` mode records them with known-secret redaction. This
  is the firm's record of what the AI asked Clio for.

## What we do NOT do (yet)

- **No private endpoint by default.** The Container App is public — gate it with
  the OAuth layer, optional custom domain, Front Door / API Management as needed.
- **No mTLS.** Pair with API Management if you need mutual TLS.
- **No automated key rotation.** Rotate `clio-encryption-key` in Key Vault and
  restart the revision (existing sessions will need to reconnect); in static mode
  rotate `clio-http-auth-tokens` the same way.
- **No content scanning.** Whatever the agent asks for, the agent gets (within
  the tool surface and the user's Clio scope). Tasks that require attorney review
  should be flagged by the agent, not by this server.

## Recommendations for firms deploying this

1. **Prefer OAuth mode.** Each attorney connects their own Clio account, so
   access maps to the firm's existing Clio user permissions and offboarding a
   user is a Clio-side action, not a shared-secret rotation.
2. **Pair with Claude Enterprise or the API with ZDR.** This server secures the
   boundary between Claude and Clio. It does not change Claude's own handling of
   conversations.
3. **Use `metadata` audit mode by default** — captures "what did the AI ask Clio
   for?" without writing argument payloads (which may contain client content) to
   a log file.
4. **Keep `CLIO_ALLOW_DESTRUCTIVE=false`** unless you have a reason — a DELETE on
   the wrong matter or contact id is hard to recover from.
5. **Review and retain the audit log.** Export it on a schedule per the firm's
   retention policy; the server does not rotate it.
6. **In static mode, treat the bearer token like a password.** Rotate when a user
   leaves and after any client-machine compromise.

## Reporting issues

Security issues: please email the maintainer privately rather than opening a
public GitHub issue. Include a reproduction and the affected version.
