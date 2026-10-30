import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { ModelRequest } from "./fake-model.ts";
import { startHarness } from "./harness.ts";

const readOnly = "github:\n  push: false\n  pull_request: false\n  finalize: false\n";
const h = await startHarness(
  {
    "agents/busy/agent.md": `---\nhandle: aorch-busy\ndescription: busy\nlive: false\n${readOnly}---\nYou are busy.\n`,
    "agents/calm/agent.md": `---\nhandle: aorch-calm\ndescription: calm\nlive: false\n${readOnly}---\nYou are calm.\n`,
  },
  { MAX_CONCURRENT_TASKS: "4", MODEL_ERROR_RETRIES: "0" },
);
after(() => h.stop());
const { app, db, model, scheduler } = h;
let refusals = 1;
model.script = (request: ModelRequest) => {
  if (request.prompt.includes("BUSY") && refusals > 0) {
    refusals--;
    return { status: 429, error: { type: "rate_limit_error", message: "Number of request tokens has exceeded your per-minute rate limit" } };
  }
  return [{ type: "text", text: "Done." }];
};

test("a rate limit backs off only the task that hit it, and fewer tasks run for a while", async () => {
  const busy = await h.mentionOnNewIssue(1, "aorch-busy", "BUSY work");
  const backedOff = await h.waitForTask(busy.id, ["queued"], (task) => Boolean(task?.retryAt));
  const waitMs = Date.parse(backedOff.retryAt!) - Date.now();
  assert.ok(waitMs > 15_000 && waitMs < 45_000, `about 30 s, with jitter: ${waitMs} ms`);
  assert.equal((await app.inject({ method: "GET", url: "/api/model" })).json().limit, null, "no pause for everyone");
  assert.equal(scheduler.effectiveConcurrent(), 2, "half of 4");
  assert.equal(scheduler.effectiveConcurrent(Date.now() + 5 * 60_000), 4, "back to the setting after a few minutes");

  // Another agent carries on meanwhile.
  const calm = await h.waitForTask((await h.mentionOnNewIssue(2, "aorch-calm", "calm work")).id);
  assert.equal(calm.status, "succeeded", calm.error ?? "");
  assert.equal(db.getTask(busy.id)!.status, "queued");
  const events = ((await app.inject({ method: "GET", url: `/api/tasks/${busy.id}` })).json().events as { message: string }[]).map((event) => event.message);
  assert.ok(events.some((message) => /rate limiting requests\. This task retries at \d\d:\d\d:\d\d UTC; others carry on/.test(message)));
});
