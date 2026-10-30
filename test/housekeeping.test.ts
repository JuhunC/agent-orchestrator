import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { ModelRequest } from "./fake-model.ts";
import { startHarness } from "./harness.ts";

const h = await startHarness({
  "agents/coder/agent.md": "---\nhandle: aorch-coder\ndescription: coder\nlive: false\n---\nYou are coder.\n",
  "boards/flow.yaml": "project: acme/1\narchive:\n  columns: [Done]\n  after_days: 3\ncolumns:\n  Ready: {}\n  Done: {}\n",
});
after(() => h.stop());
const { db, fake, model } = h;
model.script = (request: ModelRequest) => {
  const steps = [
    { type: "tool_use" as const, id: "", name: "Bash", input: { command: "echo x > x.txt", description: "write" } },
    { type: "tool_use" as const, id: "", name: "mcp__github__commit_and_push", input: { message: "Add x" } },
    { type: "tool_use" as const, id: "", name: "mcp__github__open_pull_request", input: { title: "x", body: "x" } },
    { type: "text" as const, text: "Done." },
  ];
  return [steps[Math.min(request.step, steps.length - 1)]!];
};
const { deleteFinishedBranches } = await import("../src/runner/outcomes.ts");
const { archiveStaleCards, pollInterval } = await import("../src/boards/engine.ts");
const { getBoard } = await import("../src/boards/loader.ts");
const closePull = (number: number, head: string) =>
  h.sendWebhook("pull_request", { action: "closed", sender: { login: "alice", type: "User" }, pull_request: { number, merged: true, merged_at: new Date().toISOString(), title: "x", html_url: "x", node_id: `PR_${number}`, base: { ref: "main" }, head: { ref: head } } });

test("an agent's branch is deleted a day after its pull request is merged, unless open work still targets it", async () => {
  const task = await h.waitForTask((await h.mentionOnNewIssue(1, "aorch-coder", "change")).id);
  assert.ok(task.prNumber && fake.branchSha("agent/coder/issue-1"), task.error ?? "");
  fake.issues.get(task.prNumber)!.state = "closed";
  await closePull(task.prNumber, "agent/coder/issue-1");
  assert.equal(await deleteFinishedBranches(Date.now(), 1), 0, "not before a day has passed");
  assert.equal(await deleteFinishedBranches(Date.now() + 2 * 86_400_000, 1), 1);
  assert.equal(fake.branchSha("agent/coder/issue-1"), "", "gone from GitHub");

  // A parent issue's branch that an open pull request still targets is kept.
  h.run(h.root, "--git-dir", `${h.remotes}/acme/widgets.git`, "branch", "ao/issue-5", "main");
  db.recordPullOpened("acme", "widgets", 50, "coder", "ao/issue-5");
  db.setPullState("acme", "widgets", 50, "merged", new Date(Date.now() - 3 * 86_400_000).toISOString());
  fake.issues.set(51, { number: 51, title: "sub", body: "", user: { login: "x" }, comments: [], pull: { head: "ao/issue-6", base: "ao/issue-5" } });
  assert.equal(await deleteFinishedBranches(Date.now(), 1), 0);
  assert.ok(fake.branchSha("ao/issue-5"), "kept while #51 targets it");
});

test("cards that sat in an archive column long enough are archived; org projects are polled every 10 minutes", async () => {
  fake.addIssue({ number: 7, title: "Done one", body: "x", user: { login: "alice" } });
  const item = fake.addItem(7);
  fake.items.get(item)!.status = "Done";
  const board = getBoard("flow")!;
  const { syncBoard } = await import("../src/boards/engine.ts");
  await syncBoard(board); // the board learns where the card is
  assert.equal(await archiveStaleCards(board, Date.now() + 1 * 86_400_000), 0, "too soon");
  assert.equal(await archiveStaleCards(board, Date.now() + 4 * 86_400_000), 1);
  assert.ok(!fake.items.has(item), "archived on GitHub");
  assert.ok(!db.listBoardItems("flow").some((row) => row.itemId === item));
  assert.equal(pollInterval(board), 600, "an organization project, which sends webhooks");
});
