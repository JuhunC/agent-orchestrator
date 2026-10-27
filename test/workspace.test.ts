import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import type { ModelRequest } from "./fake-model.ts";
import { startHarness } from "./harness.ts";

const h = await startHarness({
  "agents/coder/agent.md": "---\nhandle: aorch-coder\ndescription: coder\ngithub:\n  push: false\n  pull_request: false\n  finalize: false\n---\nYou are coder.\n",
});
after(() => h.stop());
const { model, run, root, remotes } = h;
const { workspaceDir } = await import("../src/runtime/workspace.ts");

const bare = join(remotes, "acme", "widgets.git");
// Let the test remote serve filtered (blob-less) clones, as GitHub does; file:// remotes ignore
// --filter otherwise, which is why a blob-less workspace never showed up in tests before.
run(root, "--git-dir", bare, "config", "uploadpack.allowFilter", "true");

/** Pushes a commit to the remote's main branch, like someone else would on GitHub. */
function pushToMain(file: string, content: string, message: string) {
  const work = mkdtempSync(join(root, "push-"));
  run(root, "clone", "-q", bare, work);
  writeFileSync(join(work, file), content);
  run(work, "add", ".");
  run(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message);
  run(work, "push", "-q", "origin", "HEAD:main");
}
pushToMain("HISTORY.md", "first version\n", "History v1");
pushToMain("HISTORY.md", "second version\n", "History v2");

type Step = { tool: string; input: Record<string, unknown> } | { text: string };
const bash = (command: string): Step => ({ tool: "Bash", input: { command, description: "run" } });
const fetchStep: Step = { tool: "mcp__github__fetch_from_github", input: {} };

let pushedLate = false;
model.script = (request: ModelRequest) => {
  const steps: Step[] = request.prompt.includes("FETCH_ME")
    ? [bash("git show HEAD~1:HISTORY.md"), fetchStep, bash("git log -1 --format=%s origin/main"), { tool: "mcp__github__fetch_from_github", input: { branch: "no-such-branch" } }, { text: "Fetched." }]
    : [bash("git show HEAD~1:HISTORY.md && git log -p --format=%s -- HISTORY.md | grep -c version"), { text: "Read the history." }];
  // Someone pushes to GitHub while the agent works, before it fetches.
  if (request.prompt.includes("FETCH_ME") && request.step === 1 && !pushedLate) {
    pushedLate = true;
    pushToMain("LATE.md", "late\n", "Late change on GitHub");
  }
  const step = steps[Math.min(request.step, steps.length - 1)]!;
  return "tool" in step ? [{ type: "tool_use", id: "", name: step.tool, input: step.input }] : [{ type: "text", text: step.text }];
};

const results = (marker: string) => JSON.stringify(model.agentRequests().filter((request) => request.prompt.includes(marker)).at(-1)!.body.messages);
const config = (dir: string, key: string) => {
  try {
    return run(dir, "config", "--get", key);
  } catch {
    return "";
  }
};
const missingObjects = (dir: string) => run(dir, "rev-list", "--objects", "--all", "--missing=print").split("\n").filter((line) => line.startsWith("?")).length;

test("a blob-less workspace from an older version becomes a full clone, and new ones are full", async () => {
  // What older versions made: git clone --filter=blob:none --no-checkout.
  const old = workspaceDir({ owner: "acme", repo: "widgets", agent: "coder", threadKind: "issue", threadNumber: 1 });
  mkdirSync(dirname(old), { recursive: true });
  run(root, "clone", "-q", "--filter=blob:none", "--no-checkout", `file://${bare}`, old);
  assert.equal(config(old, "remote.origin.promisor"), "true");
  assert.ok(missingObjects(old) > 0, "the old workspace really is missing objects");

  const task = await h.waitForTask((await h.mentionOnNewIssue(1, "aorch-coder", "READ_HISTORY")).id);
  assert.equal(task.status, "succeeded", task.error ?? "");
  assert.equal(config(old, "remote.origin.promisor"), "");
  assert.equal(config(old, "remote.origin.partialclonefilter"), "");
  assert.equal(missingObjects(old), 0);
  assert.match(results("READ_HISTORY"), /first version/, "the agent read an old version of a file with no GitHub access");

  const fresh = await h.waitForTask((await h.mentionOnNewIssue(2, "aorch-coder", "READ_HISTORY again")).id);
  assert.equal(fresh.status, "succeeded", fresh.error ?? "");
  const dir = workspaceDir({ owner: "acme", repo: "widgets", agent: "coder", threadKind: "issue", threadNumber: 2 });
  assert.equal(config(dir, "remote.origin.promisor"), "");
  assert.equal(missingObjects(dir), 0);
});

test("fetch_from_github brings in commits pushed while the agent works", async () => {
  const task = await h.waitForTask((await h.mentionOnNewIssue(3, "aorch-coder", "FETCH_ME")).id);
  assert.equal(task.status, "succeeded", task.error ?? "");
  const seen = results("FETCH_ME");
  assert.match(seen, /Fetched from GitHub:\\n- origin\/main: [0-9a-f]{10} → [0-9a-f]{10}/);
  assert.match(seen, /Late change on GitHub/, "the agent sees the new commit on origin/main");
  assert.match(seen, /There's no branch \\"no-such-branch\\" on GitHub/);
  const system = JSON.stringify(model.agentRequests().find((request) => request.prompt.includes("FETCH_ME"))!.body.system);
  assert.match(system, /Your shell has no GitHub credentials/);
});
