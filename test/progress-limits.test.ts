import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { ModelRequest } from "./fake-model.ts";
import { startHarness } from "./harness.ts";

const h = await startHarness(
  { "agents/coder/agent.md": "---\nhandle: aorch-coder\ndescription: coder\nlive: false\ngithub:\n  push: false\n  pull_request: false\n  finalize: false\n---\nYou are coder.\n" },
  { PROGRESS_UPDATE_SECONDS: "5", PROGRESS_EDITS_PER_HOUR: "1" },
);
after(() => h.stop());
const { app, fake, model } = h;
const bash = (command: string) => ({ type: "tool_use" as const, id: "", name: "Bash", input: { command, description: command } });
model.script = (request: ModelRequest) => {
  const steps = request.prompt.includes("SLOW") ? [bash("sleep 6"), bash("echo one"), bash("sleep 6"), bash("echo two"), { type: "text" as const, text: "Done slowly." }] : [{ type: "text" as const, text: "Done." }];
  return [steps[Math.min(request.step, steps.length - 1)]!];
};
const edits = (commentId: string) => fake.requests.filter((request) => request.method === "PATCH" && request.path === `/repos/acme/widgets/issues/comments/${commentId}`);

test("progress edits stay within the hourly budget; the comment is still completed", async () => {
  const task = await h.waitForTask((await h.mentionOnNewIssue(1, "aorch-coder", "SLOW work")).id);
  assert.equal(task.status, "succeeded", task.error ?? "");
  // ~12 s of work with an update every 5 s would be 2–3 edits plus the last; the budget allows 1 plus the last.
  assert.equal(edits(task.progressCommentId!).length, 2);
  assert.match(fake.issues.get(1)!.comments[0]!.body, /finished in/);
});

test("when GitHub says to slow down, the write waits and retries, and it's recorded once", async () => {
  fake.secondaryLimit = 1; // the next comment (the progress comment) is refused once
  const task = await h.waitForTask((await h.mentionOnNewIssue(2, "aorch-coder", "quick")).id);
  assert.equal(task.status, "succeeded", task.error ?? "");
  assert.ok(task.progressCommentId, "the comment went through on the retry");
  const incidents = (await app.inject({ method: "GET", url: "/api/incidents?kind=github_rate_limit" })).json() as { message: string }[];
  assert.equal(incidents.length, 1);
  assert.match(incidents[0]!.message, /^GitHub is rate-limiting the orchestrator \(secondary rate limit \(writing too fast\)\)/);
});
