import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { config } from "../config.ts";
import { git, GitError } from "../runner/git.ts";
import { commitIdentityFor, gitTokenFor } from "./accounts.ts";
import { repoRemoteUrl } from "./app.ts";

/**
 * GitHub wikis have no REST API: each is a git repository (<repo>.wiki.git). The orchestrator
 * keeps a checkout per wiki under DATA_DIR/wikis and reads and writes pages there with the
 * installation token, so agents never see the token.
 */

/** File types GitHub renders as wiki pages. */
const MARKUP = new Set([".md", ".markdown", ".mdown", ".mkdn", ".mediawiki", ".wiki", ".textile", ".rdoc", ".org", ".creole", ".rst", ".asciidoc", ".adoc", ".asc", ".pod"]);
const MAX_READ = 200_000;

export interface WikiPage {
  /** What GitHub shows as the title: the file name without extension, dashes as spaces. */
  title: string;
  file: string;
  bytes: number;
  url: string;
}

export class WikiError extends Error {}

const locks = new Map<string, Promise<unknown>>();

/** One operation at a time per wiki checkout. */
function locked<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  locks.set(key, next);
  void next.finally(() => locks.get(key) === next && locks.delete(key)).catch(() => undefined);
  return next;
}

export function wikiUrl(owner: string, repo: string, page?: string): string {
  return `${config.github.url}/${owner}/${repo}/wiki${page ? `/${encodeURIComponent(page)}` : ""}`;
}

/** "Release notes" → "Release-notes", as GitHub names wiki files. */
export function pageSlug(name: string): string {
  const base = name.trim().replace(/\.(md|markdown)$/i, "");
  const slug = base.replace(/\s+/g, "-").replace(/[\\/:*?"<>|#%]/g, "-");
  if (!slug || slug.startsWith(".")) throw new WikiError(`"${name}" isn't a usable page name`);
  return slug;
}

const titleOf = (file: string) => file.split("/").pop()!.replace(/\.[^.]+$/, "").replace(/-/g, " ");

function walk(dir: string, root = dir): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(path, root));
    else if (MARKUP.has(extname(entry.name).toLowerCase())) files.push(relative(root, path).split("\\").join("/"));
  }
  return files.sort((a, b) => a.localeCompare(b));
}

interface Checkout {
  dir: string;
  branch: string;
  token: string;
}

/** Clones the wiki, or brings the checkout up to date with GitHub. */
/** Whose credentials wiki git commands use: the agent's GitHub account, or the App installation. */
type Who = { agent: string; installationId: number };

async function sync(who: Who, owner: string, repo: string): Promise<Checkout> {
  const dir = join(config.dataDir, "wikis", owner.toLowerCase(), repo.toLowerCase());
  const token = await gitTokenFor(who);
  if (!existsSync(join(dir, ".git"))) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dirname(dir), { recursive: true });
    try {
      await git(dirname(dir), ["clone", "--quiet", repoRemoteUrl(owner, `${repo}.wiki`), dir], { token });
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      const text = error instanceof GitError ? error.stderr : String(error);
      if (/not found|does not exist|repository .* not|could not read/i.test(text)) {
        throw new WikiError(
          `${owner}/${repo} has no wiki yet. GitHub only creates a wiki's repository once its first page is saved: ` +
            `turn on Wikis in the repository settings, create the first page at ${wikiUrl(owner, repo)}, then try again.`,
        );
      }
      throw error;
    }
  }
  await git(dir, ["fetch", "--quiet", "--prune", "origin"], { token });
  const remoteHead = await git(dir, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).catch(() => "origin/master");
  const branch = remoteHead.replace(/^origin\//, "");
  await git(dir, ["checkout", "--quiet", "-B", branch, `origin/${branch}`]);
  await git(dir, ["reset", "--quiet", "--hard", `origin/${branch}`]);
  await git(dir, ["clean", "-fdq"]);
  return { dir, branch, token };
}

/** The existing file for a page name, matched the way GitHub does (case-insensitive, any folder). */
function findPage(dir: string, name: string): string | null {
  const wanted = pageSlug(name).toLowerCase();
  return walk(dir).find((file) => file.split("/").pop()!.replace(/\.[^.]+$/, "").toLowerCase() === wanted) ?? null;
}

export function listWikiPages(who: Who, owner: string, repo: string): Promise<WikiPage[]> {
  return locked(`${owner}/${repo}`.toLowerCase(), async () => {
    const { dir } = await sync(who, owner, repo);
    return walk(dir).map((file) => ({
      title: titleOf(file),
      file,
      bytes: statSync(join(dir, file)).size,
      url: wikiUrl(owner, repo, file.split("/").pop()!.replace(/\.[^.]+$/, "")),
    }));
  });
}

export function readWikiPage(who: Who, owner: string, repo: string, name: string): Promise<{ page: WikiPage; content: string; truncated: boolean }> {
  return locked(`${owner}/${repo}`.toLowerCase(), async () => {
    const { dir } = await sync(who, owner, repo);
    const file = findPage(dir, name);
    if (!file) throw new WikiError(`No page called "${name}" in the ${owner}/${repo} wiki. Use list_wiki_pages to see what's there.`);
    const content = readFileSync(join(dir, file), "utf8");
    const slug = file.split("/").pop()!.replace(/\.[^.]+$/, "");
    return {
      page: { title: titleOf(file), file, bytes: Buffer.byteLength(content), url: wikiUrl(owner, repo, slug) },
      content: content.length > MAX_READ ? content.slice(0, MAX_READ) : content,
      truncated: content.length > MAX_READ,
    };
  });
}

export interface WikiWrite {
  page: WikiPage;
  created: boolean;
  deleted: boolean;
  changed: boolean;
  sha: string | null;
}

/**
 * Creates, replaces or deletes a page (content null deletes) and pushes it. If someone else
 * changed the wiki meanwhile, it starts again from their version once.
 */
export function writeWikiPage(
  who: Who,
  owner: string,
  repo: string,
  name: string,
  content: string | null,
  message: string,
): Promise<WikiWrite> {
  return locked(`${owner}/${repo}`.toLowerCase(), async () => {
    const identity = await commitIdentityFor(who);
    for (let attempt = 1; ; attempt++) {
      const { dir, branch, token } = await sync(who, owner, repo);
      const existing = findPage(dir, name);
      if (content === null && !existing) throw new WikiError(`No page called "${name}" in the ${owner}/${repo} wiki.`);
      const file = existing ?? `${pageSlug(name)}.md`;
      const slug = file.split("/").pop()!.replace(/\.[^.]+$/, "");
      const page: WikiPage = { title: titleOf(file), file, bytes: content === null ? 0 : Buffer.byteLength(content), url: wikiUrl(owner, repo, slug) };
      if (content === null) unlinkSync(join(dir, file));
      else writeFileSync(join(dir, file), content.endsWith("\n") ? content : `${content}\n`);
      await git(dir, ["add", "-A"]);
      if (!(await git(dir, ["status", "--porcelain"]))) return { page, created: false, deleted: false, changed: false, sha: null };
      await git(dir, ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`, "commit", "--quiet", "-m", message]);
      try {
        await git(dir, ["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`], { token });
      } catch (error) {
        const rejected = error instanceof GitError && /rejected|non-fast-forward|fetch first/i.test(error.stderr);
        if (rejected && attempt < 2) continue;
        throw error;
      }
      return { page, created: !existing, deleted: content === null, changed: true, sha: await git(dir, ["rev-parse", "HEAD"]) };
    }
  });
}
