import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { bus } from "../bus.ts";
import { config } from "../config.ts";
import { db } from "../db.ts";
import { errorMessage, log } from "../log.ts";
import { recordIncident } from "../runner/incidents.ts";

/**
 * Snapshots of what can't be rebuilt: the database (tasks, history, settings, agents' encrypted
 * GitHub tokens) and the key files (the GitHub App's credentials, data-key, which decrypts those
 * tokens, the session secret and admin token). Workspaces, sessions and wikis are clones and
 * caches, so they're left out; the profiles folder is its own git repository. A snapshot is
 * taken daily, the last BACKUP_KEEP are kept, and Settings can take one now.
 */

const KEY_FILES = ["github-app.json", "data-key", "session-secret", "admin-token"];

export interface BackupInfo {
  name: string;
  path: string;
  at: string;
  kb: number;
  files: string[];
}

export function backupDir(): string {
  return config.backupDir || join(config.dataDir, "backups");
}

function sizeKb(dir: string): number {
  return Math.round(readdirSync(dir).reduce((sum, file) => sum + statSync(join(dir, file)).size, 0) / 1024);
}

export function listBackups(): BackupInfo[] {
  const root = backupDir();
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => /^\d{4}-\d\d-\d\dT\d{6}Z$/.test(name) && existsSync(join(root, name, "orchestrator.db")))
    .sort()
    .reverse()
    .map((name) => {
      const path = join(root, name);
      return { name, path, at: `${name.slice(0, 13)}:${name.slice(13, 15)}:${name.slice(15, 17)}Z`, kb: sizeKb(path), files: readdirSync(path).sort() };
    });
}

/** Takes a snapshot now and removes the oldest beyond BACKUP_KEEP. */
export function backUp(): BackupInfo {
  const root = backupDir();
  const name = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace(/^(\d{4})(\d\d)(\d\d)/, "$1-$2-$3");
  const target = join(root, name);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  try {
    // A consistent copy of the database while it's in use.
    db.prepare("VACUUM INTO ?").run(join(target, "orchestrator.db"));
    for (const file of KEY_FILES) if (existsSync(join(config.dataDir, file))) copyFileSync(join(config.dataDir, file), join(target, file));
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    recordIncident("backup", "warning", `The backup failed: ${errorMessage(error)}`);
    throw error;
  }
  for (const old of listBackups().slice(Math.max(1, config.backupKeep))) rmSync(old.path, { recursive: true, force: true });
  const info = listBackups().find((backup) => backup.name === name)!;
  log.info("Backed up the database and keys", { path: info.path, kb: info.kb });
  bus.publish({ type: "settings" });
  return info;
}

/** A snapshot a minute after start if the last is over a day old, then daily. */
export function startBackups(): void {
  if (config.backupKeep <= 0) return;
  const tick = () => {
    const last = listBackups()[0];
    if (last && Date.now() - Date.parse(last.at) < 23 * 60 * 60_000) return;
    try {
      backUp();
    } catch (error) {
      log.warn("Backup failed", { error: errorMessage(error) });
    }
  };
  setTimeout(tick, 60_000).unref();
  setInterval(tick, 60 * 60_000).unref();
}
