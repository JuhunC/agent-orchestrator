import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { ModelRequest } from "./fake-model.ts";
import { startHarness } from "./harness.ts";

const h = await startHarness(
  { "agents/coder/agent.md": "---\nhandle: aorch-coder\ndescription: coder\nlive: false\ngithub:\n  push: false\n  pull_request: false\n  finalize: false\n---\nYou are coder.\n" },
  { RESTART_RESUMES: "1" },
);
after(() => h.stop());
const { db, model, scheduler } = h;
model.script = (request: ModelRequest) => {
  if (request.prompt.includes("You were interrupted")) return [{ type: "text", text: "Resumed and done." }];
  return request.step === 0 ? [{ type: "tool_use", id: "", name: "Bash", input: { command: "echo started > notes.txt && sleep 20", description: "long step" } }] : [{ type: "text", text: "Done." }];
};
const until = async (check: () => boolean) => {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(check());
};

test("a task running when the orchestrator restarts resumes its session; past RESTART_RESUMES it fails", async () => {
  const queued = await h.mentionOnNewIssue(1, "aorch-coder", "LONG job");
  await until(() => Boolean(db.getTask(queued.id)!.sessionId) && model.agentRequests().length > 0);
  const sessionId = db.getTask(queued.id)!.sessionId;

  // A deploy: shutdown stops it and queues it again.
  await scheduler.shutdown(0);
  let task = db.getTask(queued.id)!;
  assert.equal(task.status, "queued");
  assert.equal(task.restarts, 1);
  assert.equal(task.sessionId, sessionId, "the session id was saved as soon as it was known");

  // Back up: it resumes the same conversation and finishes.
  await scheduler.start();
  task = await h.waitForTask(queued.id);
  assert.equal(task.status, "succeeded", task.error ?? "");
  assert.equal(task.resultText, "Resumed and done.");
  const resumed = model.agentRequests().find((request) => request.prompt.includes("You were interrupted"))!;
  assert.match(JSON.stringify(resumed.body.messages), /LONG job/, "with the earlier conversation");

  // A crash (the task is left "running"): recovered once more would exceed RESTART_RESUMES=1, so it fails.
  db.updateTask(queued.id, { status: "running" });
  await scheduler.start();
  assert.equal(db.getTask(queued.id)!.status, "failed");
  assert.match(db.getTask(queued.id)!.error ?? "", /Interrupted because the orchestrator restarted/);
});
