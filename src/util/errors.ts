export class ClioError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "ClioError";
  }
}

export class AuthError extends Error {
  constructor(message: string, public readonly hint?: string) {
    super(message);
    this.name = "AuthError";
  }
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/**
 * Map an internal error into a string message safe to return to the MCP client.
 * Includes actionable guidance where possible.
 */
export function describeError(err: unknown): string {
  if (err instanceof ClioError) {
    const parts: string[] = [`Clio API error ${err.status}: ${err.message}`];
    if (err.hint) parts.push(`Hint: ${err.hint}`);
    if (err.body && typeof err.body === "object") {
      try {
        parts.push(`Response: ${JSON.stringify(err.body)}`);
      } catch {
        // ignore
      }
    }
    return parts.join("\n");
  }
  if (err instanceof AuthError) {
    return `Authentication error: ${err.message}${err.hint ? `\nHint: ${err.hint}` : ""}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
