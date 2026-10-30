import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ModelRequest } from "./fake-model.ts";
import { startHarness } from "./harness.ts";

const h = await startHarness({
  "agents/scribe/agent.md": "---\nhandle: aorch-scribe\ndescription: scribe\n---\nYou are scribe.\n",
  "agents/reader/agent.md": "---\nhandle: aorch-reader\ndescription: reader\ngithub:\n  wiki: read\n---\nYou are reader.\n",
  "agents/nowiki/agent.md": "---\nhandle: aorch-nowiki\ndescription: nowiki\ngithub:\n  wiki: false\n---\nYou are nowiki.\n",
});
after(() => h.stop());
const { model, root, remotes, run } = h;

// The wiki's own git repository, as GitHub keeps it next to the code: acme/widgets.wiki.git, branch master.
const seed = join(root, "wiki-seed");
mkdirSync(seed, { recursive: true });
run(seed, "init", "-q", "-b", "master");
writeFileSync(join(seed, "Home.md"), "# Widgets wiki\n\nWelcome.\n");
mkdirSync(join(seed, "guides"));
writeFileSync(join(seed, "guides", "Getting-started.md"), "Install it.\n");
run(seed, "add", ".");
run(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
const wikiGit = join(remotes, "acme", "widgets.wiki.git");
run(root, "clone", "-q", "--bare", seed, wikiGit);
const wiki = (...args: string[]) => run(root, "--git-dir", wikiGit, ...args);

const call = (name: string, input: Record<string, unknown>) => [{ type: "tool_use" as const, id: "", name: `mcp__github__${name}`, input }];
const steps: Record<string, ReturnType<typeof call>[]> = {
  WRITE_DOCS: [
    call("list_wiki_pages", {}),
    call("read_wiki_page", { page: "home" }),
    call("write_wiki_page", { page: "Release notes", content: "## 1.0\n\n- First release", message: "Add release notes" }),
    call("write_wiki_page", { page: "Home", content: "# Widgets wiki\n\nSee [[Release notes]].\n" }),
    call("read_wiki_page", { page: "Getting started" }),
    call("delete_wiki_page", { page: "Getting-started.md" }),
    call("read_wiki_page", { page: "Nope", repository: "acme/other" }),
  ],
  READ_ONLY: [call("read_wiki_page", { page: "Release-notes" })],
};
const tools = (request: ModelRequest) => (request.body.tools as { name: string }[]).map((entry) => entry.name);

model.script = (request: ModelRequest) => {
  const all = JSON.stringify(request.body.messages);
  const done = (all.match(/"type":"tool_use"/g) ?? []).length;
  const key = Object.keys(steps).find((name) => all.includes(name));
  if (key && done < steps[key]!.length) return steps[key]![done]!;
  return [{ type: "text", text: "Done." }];
};

/** The tool results the agent saw, in order. */
function results(marker: string): string[] {
  const last = model.agentRequests().filter((request) => JSON.stringify(request.body.messages).includes(marker)).at(-1)!;
  return (last.body.messages as { content: unknown }[])
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block: any) => block.type === "tool_result")
    .map((block: any) => (Array.isArray(block.content) ? block.content.map((part: any) => part.text).join("") : String(block.content)));
}

test("an agent reads, writes and deletes wiki pages, published as the app", async () => {
  const task = await h.mentionOnNewIssue(701, "aorch-scribe", "WRITE_DOCS");
  const done = await h.waitForTask(task.id);
  assert.equal(done.status, "succeeded", done.error ?? "");
  const seen = results("WRITE_DOCS");
  assert.match(seen[0]!, /- Home \(Home\.md, \d+ bytes\) .*\/acme\/widgets\/wiki\/Home/);
  assert.match(seen[0]!, /- Getting started \(guides\/Getting-started\.md/);
  assert.match(seen[1]!, /Welcome\./);
  assert.match(seen[2]!, /Created "Release notes" in the acme\/widgets wiki: .*\/wiki\/Release-notes/);
  assert.match(seen[3]!, /Updated "Home"/);
  assert.match(seen[4]!, /Install it\./);
  assert.match(seen[5]!, /Deleted "Getting started"/);
  assert.match(seen[6]!, /acme\/other has no wiki yet/);

  assert.equal(wiki("show", "master:Release-notes.md"), "## 1.0\n\n- First release");
  assert.match(wiki("show", "master:Home.md"), /\[\[Release notes\]\]/);
  assert.throws(() => wiki("show", "master:guides/Getting-started.md"));
  const log = wiki("log", "--format=%an|%s", "master").split("\n");
  assert.equal(log.length, 4);
  assert.ok(log.every((line) => line.startsWith("test-orchestrator[bot]|") || line === "t|init"), log.join("\n"));
  assert.ok(log.includes("test-orchestrator[bot]|Add release notes"));
  assert.ok(log.some((line) => /scribe: Home \(#701\)/.test(line)));
});

test("wiki: read gives only the reading tools; wiki: false gives none", async () => {
  const task = await h.mentionOnNewIssue(702, "aorch-reader", "READ_ONLY");
  assert.equal((await h.waitForTask(task.id)).status, "succeeded");
  const request = model.agentRequests().find((entry) => JSON.stringify(entry.body.messages).includes("READ_ONLY"))!;
  assert.ok(tools(request).includes("mcp__github__read_wiki_page"));
  assert.ok(!tools(request).includes("mcp__github__write_wiki_page"));
  assert.match(results("READ_ONLY")[0]!, /First release/);

  const other = await h.mentionOnNewIssue(703, "aorch-nowiki", "NO_WIKI");
  assert.equal((await h.waitForTask(other.id)).status, "succeeded");
  const none = model.agentRequests().find((entry) => JSON.stringify(entry.body.messages).includes("NO_WIKI"))!;
  assert.ok(!tools(none).some((name) => name.includes("wiki")));
});

test("a page someone else changed meanwhile is written on top of their version", async () => {
  const { writeWikiPage } = await import("../src/github/wiki.ts");
  // Someone edits the wiki on GitHub after the orchestrator's last sync.
  const other = join(root, "wiki-other");
  run(root, "clone", "-q", wikiGit, other);
  writeFileSync(join(other, "Team.md"), "People.\n");
  run(other, "add", ".");
  run(other, "-c", "user.name=alice", "-c", "user.email=a@a", "commit", "-q", "-m", "Team page");
  run(other, "push", "-q", "origin", "master");
  const result = await writeWikiPage({ agent: "writer", installationId: 77 }, "acme", "widgets", "FAQ", "Questions.", "Add FAQ");
  assert.ok(result.created && result.changed);
  assert.equal(wiki("show", "master:Team.md"), "People.");
  assert.equal(wiki("show", "master:FAQ.md"), "Questions.");
  const again = await writeWikiPage({ agent: "writer", installationId: 77 }, "acme", "widgets", "faq", "Questions.\n", "No-op");
  assert.equal(again.changed, false);
});
