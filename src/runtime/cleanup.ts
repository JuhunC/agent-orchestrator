import { execFile } from "node:child_process";
import { existsSync, readdirSync, rmdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { bus } from "../bus.ts";
import { config } from "../config.ts";
import { getSetting, setSetting, tasksForThread } from "../db.ts";
import { errorMessage, log } from "../log.ts";
import { git } from "../runner/git.ts";
import type { ThreadKind } from "../types.ts";
import { sessions, sessionKey } from "./manager.ts";

/**
 * Removes agents' checkouts nobody has used for WORKSPACE_RETENTION_DAYS. Each is a full clone, one
 * per agent and thread, so a busy server fills its disk otherwise. A checkout with work that isn't
 * on GitHub (uncommitted files, unpushed commits) is kept; so is one with a queued or running task
 * or an open session. The next task on the thread clones it again.
 */

export interface CleanupReport {
  at: string;
  retentionDays: number;
  removed: { path: string; idleDays: number; kb: number }[];
  kept: { path: string; reason: string }[];
  freedKb: number;
  /** Checkouts left, and their size, after the cleanup. */
  remaining: number;
  remainingKb: number | null;
}

const run = promisify(execFile);
const DAY = 86_400_000;
const KINDS: ThreadKind[] = ["issue", "pull", "discussion"];

async function sizeKb(path: string): Promise<number | null> {
  try {
    const { stdout } = await run("du", ["-sk", path], { timeout: 120_000 });
    return Number(stdout.split(/\s+/)[0]) || 0;
  } catch {
    return null;
  }
}

/** What in the checkout isn't on GitHub yet, or null when everything is. */
async function unpublished(dir: string): Promise<string | null> {
  if (!existsSync(join(dir, ".git"))) return null;
  try {
    if ((await git(dir, ["status", "--porcelain"])).trim()) return "it has uncommitted changes";
    const ahead = Number(await git(dir, ["rev-list", "--count", "HEAD", "--not", "--remotes"]));
    if (ahead > 0) return `it has ${ahead} commit${ahead === 1 ? "" : "s"} that aren't on GitHub`;
    return null;
  } catch (error) {
    return `git couldn't check it (${errorMessage(error)})`;
  }
}

/** The workspaces folder's checkouts: workspaces/<owner>/<repo>/<agent>/<kind>-<number>. */
function checkouts(root: string): { path: string; owner: string; repo: string; agent: string; kind: ThreadKind; number: number }[] {
  const found: ReturnType<typeof checkouts> = [];
  const dirs = (path: string) => (existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : []);
  for (const owner of dirs(root))
    for (const repo of dirs(join(root, owner)))
      for (const agent of dirs(join(root, owner, repo)))
        for (const thread of dirs(join(root, owner, repo, agent))) {
          const match = thread.match(/^(issue|pull|discussion)-(\d+)$/);
          if (match && KINDS.includes(match[1] as ThreadKind)) found.push({ path: join(root, owner, repo, agent, thread), owner, repo, agent, kind: match[1] as ThreadKind, number: Number(match[2]) });
        }
  return found;
}

/** Removes empty folders above a removed checkout, up to the workspaces folder. */
function prune(path: string, root: string): void {
  let current = dirname(path);
  while (current.startsWith(root) && current !== root) {
    try {
      if (readdirSync(current).length) return;
      rmdirSync(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}

let running: Promise<CleanupReport> | null = null;

export function cleanUpWorkspaces(options: { now?: number; days?: number } = {}): Promise<CleanupReport> {
  running ??= clean(options).finally(() => (running = null));
  return running;
}

async function clean({ now = Date.now(), days = config.workspaceRetentionDays }: { now?: number; days?: number }): Promise<CleanupReport> {
  const root = join(config.dataDir, "workspaces");
  const report: CleanupReport = { at: new Date(now).toISOString(), retentionDays: days, removed: [], kept: [], freedKb: 0, remaining: 0, remainingKb: null };
  const open = new Set(sessions.list().map((session) => session.key));
  const all = days > 0 ? checkouts(root) : [];
  for (const checkout of all) {
    const tasks = tasksForThread({ owner: checkout.owner, repo: checkout.repo, kind: checkout.kind, number: checkout.number }).filter((task) => task.agent === checkout.agent);
    if (tasks.some((task) => task.status === "queued" || task.status === "running") || open.has(sessionKey({ ...checkout, threadKind: checkout.kind, threadNumber: checkout.number }))) continue;
    const last = Math.max(0, ...tasks.map((task) => Date.parse(task.finishedAt ?? task.startedAt ?? task.createdAt)));
    const used = last || statSync(checkout.path).mtimeMs;
    const idleDays = Math.floor((now - used) / DAY);
    if (now - used < days * DAY) continue;
    const reason = await unpublished(checkout.path);
    const where = checkout.path.slice(root.length + 1);
    if (reason) {
      report.kept.push({ path: where, reason });
      continue;
    }
    const kb = (await sizeKb(checkout.path)) ?? 0;
    try {
      rmSync(checkout.path, { recursive: true, force: true });
      prune(checkout.path, root);
      report.removed.push({ path: where, idleDays, kb });
      report.freedKb += kb;
    } catch (error) {
      report.kept.push({ path: where, reason: `couldn't remove it: ${errorMessage(error)}` });
    }
  }
  report.remaining = checkouts(root).length;
  report.remainingKb = existsSync(root) ? await sizeKb(root) : 0;
  setSetting("workspace_cleanup", JSON.stringify(report));
  if (report.removed.length || report.kept.length) {
    log.info("Cleaned up workspaces", { removed: report.removed.length, freedMb: Math.round(report.freedKb / 1024), kept: report.kept.length, remaining: report.remaining });
  }
  bus.publish({ type: "settings" });
  return report;
}

export function lastCleanup(): CleanupReport | null {
  const raw = getSetting("workspace_cleanup");
  try {
    return raw ? (JSON.parse(raw) as CleanupReport) : null;
  } catch {
    return null;
  }
}

/** Cleans up a minute after start, then every hour. */
export function startWorkspaceCleanup(): void {
  if (config.workspaceRetentionDays <= 0) return;
  const tick = () => void cleanUpWorkspaces().catch((error) => log.warn("Workspace cleanup failed", { error: errorMessage(error) }));
  setTimeout(tick, 60_000).unref();
  setInterval(tick, 60 * 60_000).unref();
}
