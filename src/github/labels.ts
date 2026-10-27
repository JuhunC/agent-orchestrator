import type { GitHubClient } from "./app.ts";

/** Labels known to exist, so each is looked up at most every ten minutes. */
const known = new Map<string, { name: string; at: number }>();

const PALETTE = ["0e8a16", "1d76db", "5319e7", "b60205", "d93f0b", "fbca04", "0052cc", "006b75", "c2e0c6", "bfd4f2", "d4c5f9", "f9d0c4"];

/** The same colour every time for the same name. */
export function labelColor(name: string): string {
  let hash = 0;
  for (const char of name.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length]!;
}

function status(error: unknown): number {
  return Number((error as { status?: unknown })?.status ?? 0);
}

/**
 * Makes sure each label exists in the repository, creating the missing ones, so adding them to an
 * issue works. Returns the names as the repository spells them (labels match case-insensitively).
 */
export async function ensureLabels(gh: GitHubClient, owner: string, repo: string, labels: string[], onCreated?: (name: string) => void): Promise<string[]> {
  const names: string[] = [];
  for (const raw of labels) {
    const name = raw.trim();
    if (!name) continue;
    const key = `${owner}/${repo}#${name}`.toLowerCase();
    const cached = known.get(key);
    if (cached && Date.now() - cached.at < 10 * 60_000) {
      names.push(cached.name);
      continue;
    }
    let spelled = name;
    try {
      spelled = (await gh.rest.issues.getLabel({ owner, repo, name })).data.name;
    } catch (error) {
      if (status(error) !== 404) throw error;
      try {
        await gh.rest.issues.createLabel({ owner, repo, name, color: labelColor(name), description: "Created by agent-orchestrator" });
        onCreated?.(name);
      } catch (createError) {
        // 422: someone created it a moment ago, which is just as good.
        if (status(createError) !== 422) throw createError;
      }
    }
    known.set(key, { name: spelled, at: Date.now() });
    names.push(spelled);
  }
  return [...new Set(names)];
}
