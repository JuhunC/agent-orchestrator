import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import { log } from "../log.ts";

/** Reads a secret from the environment, or generates one once and keeps it in the data dir. */
function persistentSecret(envValue: string, file: string, onCreate?: (value: string) => void): string {
  if (envValue) return envValue;
  const path = join(config.dataDir, file);
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const value = randomBytes(24).toString("base64url");
  writeFileSync(path, value + "\n", { mode: 0o600 });
  onCreate?.(value);
  return value;
}

export const sessionSecret = persistentSecret(config.sessionSecret, "session-secret");

export const adminToken = persistentSecret(config.adminToken, "admin-token", (value) => {
  log.info("Generated an admin token for the first sign-in. It is stored in DATA_DIR/admin-token.", { adminToken: value });
});

/** Key for secrets the orchestrator keeps in its database (agents' GitHub tokens). */
let dataKeyBytes: Buffer | null = null;
const dataKey = () => (dataKeyBytes ??= createHash("sha256").update(persistentSecret("", "data-key")).digest());

/** Encrypts a secret for storage (AES-256-GCM with DATA_DIR/data-key). */
export function seal(text: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKey(), iv);
  const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

/** Decrypts what seal() made; throws if it was made with another data-key. */
export function unseal(sealed: string): string {
  const [version, iv, tag, data] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || !data) throw new Error("Unknown secret format");
  const decipher = createDecipheriv("aes-256-gcm", dataKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}
