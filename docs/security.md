# Security posture

Threat model + design notes for the security-conscious reviewer.

## What this server is and isn't

- **Is:** a programmable, audited boundary between an AI agent and Clio v4.
  Holds OAuth credentials for a single firm. Issues requests on the firm's
  behalf with proper auth and pagination handling.
- **Isn't:** a multi-tenant SaaS, a Clio mirror, a data warehouse. It does
  not cache, snapshot, or store Clio content beyond what's necessary to
  return tool results. Only the access + refresh tokens are persisted
  (encrypted).

## Threat model — local (stdio)

| Actor                      | Capability                                                                 | Mitigation                                                              |
|----------------------------|----------------------------------------------------------------------------|-------------------------------------------------------------------------|
| Local user                 | Read `~/.clio-mcp/tokens.enc` and the audit log                            | Files `chmod 600`; encryption needs the key, which lives in env / shell |
| Local malware              | Read env vars + token file                                                 | OS-keychain integration on roadmap; for now, treat env vars as secrets  |
| Local user with the key    | Decrypt token file → impersonate the user against Clio                     | Inherent to OAuth — same as having the user's password                  |
| Process snooping the stdio | Read MCP protocol traffic (which may include Clio content)                 | stdio is between Claude Desktop and this process; no cross-process exposure |

## Threat model — Azure (HTTPS)

| Actor                           | Capability                                                                  | Mitigation                                                                              |
|---------------------------------|-----------------------------------------------------------------------------|------------------------------------------------------------------------------------------|
| Internet attacker, no token     | POST `/mcp`                                                                 | 401 Unauthorized; tokens compared with timingSafeEqual on SHA-256 digest                 |
| Internet attacker, valid token  | Full agent access to Clio                                                    | Rotate the bearer token; restrict who has it; bind to a specific caller                  |
| Internet attacker, GET /mcp     | Probe                                                                       | 405 Method Not Allowed (server is stateless POST-only)                                   |
| Azure RBAC compromise           | Read Key Vault secrets                                                       | Enable Key Vault firewall / private endpoint (not in default Bicep — extend if needed)   |
| Container compromise            | Read encryption key, refresh token from env                                  | Key Vault references mount as in-memory env vars; not on the file system                 |
| Container compromise            | Read `/state/tokens.enc`, `/state/audit.log`                                 | Encrypted at rest with AES-256-GCM (tokens). Audit log is metadata — review your mode    |
| File share key leak             | Read state files directly out of Azure Storage                              | Tokens still encrypted. Audit log is plaintext metadata — consider Storage encryption-at-rest with customer-managed key |

## What we do NOT do (yet)

- **No private endpoint by default.** The Container App is public — gate it
  with bearer tokens, optional custom domain, Front Door / API Management as
  needed.
- **No mTLS.** Bearer-token only. Pair with API Management if you need mutual TLS.
- **No automated key rotation.** Rotate `clio-encryption-key` by running
  `clio_logout` and re-authing; rotate `clio-http-auth-tokens` by editing
  Key Vault and restarting the revision.
- **No tenant isolation.** One server holds one firm's credentials. Don't
  share one deployment across firms.
- **No content scanning.** Whatever the agent asks for, the agent gets (within
  the tool surface). Tasks that require attorney review should be flagged by
  the agent, not by this server.

## Recommendations for firms deploying this

1. **Pair with Claude Enterprise or the API with ZDR.** This server secures
   the boundary between Claude and Clio. It does not change Claude's own
   handling of conversations.
2. **Use `metadata` audit mode by default** — captures everything you need to
   answer "what did the AI ask Clio for?" without writing argument payloads
   (which may contain client content) to a log file.
3. **Keep `CLIO_ALLOW_DESTRUCTIVE=false`** unless you have a reason — DELETE
   on a matter or contact with the wrong id is hard to recover from.
4. **Treat the bearer token like a password.** Rotate when an analyst leaves;
   rotate after any client-machine compromise.
5. **Review the audit log.** This is the firm's record of what the AI did. It
   should be exported on a schedule and retained per the firm's retention policy.

## Reporting issues

Security issues: please email the maintainer privately rather than opening a
public GitHub issue. Include a reproduction and the affected version.
