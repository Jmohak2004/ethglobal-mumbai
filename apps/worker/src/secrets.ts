// AES-256-GCM for secrets stored in Postgres (per-agent 0G keys). The key comes from AGENT_KEY_ENCRYPTION_KEY.
// Format: "v1.<iv>.<tag>.<ciphertext>", each part base64url. A fresh 12-byte IV is drawn for every value.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";

/** Parses a 32-byte hex key (with or without 0x). Throws on any other length. */
export function parseEncryptionKey(hex: string): Buffer {
  const clean = hex.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) throw new Error("encryption key must be 32 bytes of hex");
  return Buffer.from(clean, "hex");
}

export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

/** Throws when the key is wrong or the payload was altered (GCM authentication fails). */
export function decryptSecret(payload: string, key: Buffer): string {
  const [version, ivPart, tagPart, dataPart, ...rest] = payload.split(".");
  if (version !== VERSION || !ivPart || !tagPart || !dataPart || rest.length > 0) {
    throw new Error("unrecognised encrypted secret format");
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataPart, "base64url")), decipher.final()]).toString("utf8");
}
