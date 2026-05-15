import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { readFile, writeFile, chmod, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";

import type { Config } from "../config.js";
import { log } from "../util/logger.js";

/**
 * Encrypted token store.
 *
 * Format on disk (binary): [12-byte IV][16-byte auth tag][N-byte ciphertext]
 * Algorithm: AES-256-GCM
 *
 * The encryption key is the 32-byte secret in CLIO_ENCRYPTION_KEY (or a Key
 * Vault secret on Azure). Lose the key → tokens are unrecoverable and a fresh
 * OAuth dance is required; nothing more dramatic than that.
 */

export interface TokenSet {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
  token_type: string;
  user_id?: number;
}

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

export class TokenStorage {
  constructor(private readonly cfg: Config) {}

  private key(): Buffer {
    return Buffer.from(this.cfg.encryptionKeyHex, "hex");
  }

  async load(): Promise<TokenSet | null> {
    if (!existsSync(this.cfg.tokensPath)) return null;
    try {
      const blob = await readFile(this.cfg.tokensPath);
      if (blob.length < IV_LEN + TAG_LEN + 1) {
        log.warn("token file too small to be valid; ignoring", { path: this.cfg.tokensPath });
        return null;
      }
      const iv = blob.subarray(0, IV_LEN);
      const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
      const data = blob.subarray(IV_LEN + TAG_LEN);
      const decipher = createDecipheriv(ALGO, this.key(), iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(data), decipher.final()]);
      return JSON.parse(plain.toString("utf8")) as TokenSet;
    } catch (err) {
      log.warn("failed to decrypt token file — likely a key mismatch", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async save(tokens: TokenSet): Promise<void> {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, this.key(), iv);
    const data = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(tokens), "utf8")),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    const blob = Buffer.concat([iv, tag, data]);
    await writeFile(this.cfg.tokensPath, blob, { mode: 0o600 });
    await chmod(this.cfg.tokensPath, 0o600);
  }

  async clear(): Promise<void> {
    if (existsSync(this.cfg.tokensPath)) {
      await unlink(this.cfg.tokensPath);
    }
  }
}
