import { randomBytes } from "node:crypto";
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
