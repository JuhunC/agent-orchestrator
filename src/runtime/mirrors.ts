import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../config.ts";
import { errorMessage, log } from "../log.ts";
import { repoRemoteUrl } from "../github/app.ts";
import { git } from "../runner/git.ts";
import { makeSharedDir } from "./isolation.ts";

/**
 * One bare copy of each repository (DATA_DIR/mirrors/<owner>/<repo>.git) that agents' checkouts
 * borrow history from (git alternates), so a checkout holds little more than its files and a new
 * one only downloads what the copy doesn't have. The copy is never pruned or garbage-collected:
 * checkouts may rely on any object it ever had.
 */

const FRESH_MS = 60_000;
const lastFetch = new Map<string, number>();
const locks = new Map<string, Promise<unknown>>();

export function mirrorPath(owner: string, repo: string): string {
  return join(config.dataDir, "mirrors", owner.toLowerCase(), `${repo.toLowerCase()}.git`);
}

/** One git operation per copy at a time. */
function locked<T>(key: string, run: () => Promise<T>): Promise<T> {
  const next = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(run);
  locks.set(key, next);
  return next;
}

/**
 * Brings the repository's shared copy up to date (at most once a minute) and returns its path,
 * or null when shared history is off or the copy can't be made (checkouts are then full clones).
 */
export async function updateMirror(owner: string, repo: string, token: string): Promise<string | null> {
  if (!config.gitSharedObjects) return null;
  const path = mirrorPath(owner, repo);
  try {
    return await locked(path, async () => {
      if (!existsSync(join(path, "HEAD"))) {
        makeSharedDir(dirname(path));
        await git(dirname(path), ["clone", "--bare", "--quiet", repoRemoteUrl(owner, repo), path], { token });
        // Never drop objects: checkouts that borrow from this copy may need any of them.
        for (const [key, value] of [["gc.auto", "0"], ["gc.pruneExpire", "never"], ["fetch.prune", "false"], ["core.logAllRefUpdates", "false"]]) await git(path, ["config", key, value]);
        lastFetch.set(path, Date.now());
      } else if (Date.now() - (lastFetch.get(path) ?? 0) > FRESH_MS) {
        await git(path, ["fetch", "--quiet", "--no-tags", "origin", "+refs/heads/*:refs/heads/*"], { token });
        lastFetch.set(path, Date.now());
      }
      return path;
    });
  } catch (error) {
    log.warn("Couldn't update the repository's shared copy; using a full clone", { repo: `${owner}/${repo}`, error: errorMessage(error) });
    return null;
  }
}
