import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, test } from "node:test";
import type { ModelRequest } from "./fake-model.ts";
import { startHarness } from "./harness.ts";

const h = await startHarness({ "agents/coder/agent.md": "---\nhandle: aorch-coder\ndescription: coder\n---\nYou are coder.\n" });
after(() => h.stop());
const { app, db, fake, model } = h;
model.script = (request: ModelRequest) => {
  const steps = [
    { type: "tool_use" as const, id: "", name: "Bash", input: { command: "echo changed > file.txt", description: "write" } },
    { type: "tool_use" as const, id: "", name: "mcp__github__commit_and_push", input: { message: "Change" } },
    { type: "tool_use" as const, id: "", name: "mcp__github__post_comment", input: { body: "Working on it" } },
    { type: "text" as const, text: request.prompt.includes("SECOND") ? "Second." : "Done." },
  ];
  return [steps[Math.min(request.step, steps.length - 1)]!];
};
const { workspaceDir } = await import("../src/runtime/workspace.ts");

test("a dry run replays a task with nothing changed on GitHub", async () => {
  const original = await h.waitForTask((await h.mentionOnNewIssue(1, "aorch-coder", "make a change")).id);
  assert.equal(original.status, "succeeded", original.error ?? "");
  const before = { comments: fake.issues.get(1)!.comments.length, pulls: [...fake.issues.values()].filter((issue) => issue.pull).length, branch: fake.branchSha("agent/coder/issue-1"), writes: fake.requests.filter((request) => request.method !== "GET").length };

  const replay = (await app.inject({ method: "POST", url: `/api/tasks/${original.id}/replay` })).json();
  assert.equal(replay.dryRun, true);
  assert.equal(replay.retryOf, original.id);
  const done = await h.waitForTask(replay.id);
  assert.equal(done.status, "succeeded", done.error ?? "");
  assert.equal(done.resultText, "Done.");

  assert.equal(fake.issues.get(1)!.comments.length, before.comments, "no progress, agent or result comment");
  assert.equal(fake.branchSha("agent/coder/issue-1"), before.branch, "nothing pushed");
  const writes = fake.requests.filter((request) => request.method !== "GET").slice(before.writes);
  assert.deepEqual(writes.filter((request) => !/access_tokens|graphql/.test(request.path)), [], "no GitHub writes");
  const events = ((await app.inject({ method: "GET", url: `/api/tasks/${done.id}` })).json().events as { message: string }[]).map((event) => event.message);
  assert.ok(events.some((message) => /^Dry run of task #\d+ with coder's current profile: nothing is changed on GitHub$/.test(message)));
  assert.ok(events.some((message) => message.startsWith("Dry run: would commit and push (message: \"Change\")")));
  assert.ok(events.some((message) => message.startsWith('Dry run: would post comment (body: "Working on it")')));
  assert.ok(existsSync(workspaceDir({ ...done, dryRun: true })), "its own checkout");
  assert.notEqual(workspaceDir({ ...done, dryRun: true }), workspaceDir({ ...done, dryRun: false }));

  // The real thread's memory and live session are untouched: the next real run doesn't see the dry run.
  const next = await h.waitForTask((await h.commentMention(1, "@aorch-coder SECOND change")).id);
  assert.equal(next.status, "succeeded", next.error ?? "");
  assert.doesNotMatch(next.prompt ?? "", new RegExp(`Run ${done.id} `));
  assert.equal(db.getTask(done.id)!.dryRun, true);
  const outcomes = (await app.inject({ method: "GET", url: "/api/outcomes?days=7" })).json();
  assert.equal(outcomes.agents[0].tasks.succeeded, 2, "dry runs don't count as outcomes");
});
