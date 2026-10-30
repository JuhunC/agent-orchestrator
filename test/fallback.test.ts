import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { ModelRequest } from "./fake-model.ts";
import { startHarness } from "./harness.ts";

const readOnly = "github:\n  push: false\n  pull_request: false\n  finalize: false\n";
const h = await startHarness({
  "agents/coder/agent.md": `---\nhandle: aorch-coder\ndescription: coder\nlive: false\nfallback_model: claude-sonnet-5-5\n${readOnly}---\nYou are coder.\n`,
  "agents/plain/agent.md": `---\nhandle: aorch-plain\ndescription: plain\nlive: false\n${readOnly}---\nYou are plain.\n`,
});
after(() => h.stop());
const { app, db, model } = h;
const models: string[] = [];
// The main model is out of usage; the fallback answers.
model.script = (request: ModelRequest) => {
  models.push(request.body.model);
  return request.body.model === "claude-opus-5-5"
    ? { status: 429, error: { type: "rate_limit_error", message: "You've hit your usage limit · resets in 30 minutes" } }
    : [{ type: "text", text: "Done on the fallback model." }];
};
const events = async (id: number) => ((await app.inject({ method: "GET", url: `/api/tasks/${id}` })).json().events as { message: string }[]).map((event) => event.message);

test("at a usage limit, an agent with a fallback model carries on with it; others wait", async () => {
  const first = await h.waitForTask((await h.mentionOnNewIssue(1, "aorch-coder", "do it")).id);
  assert.equal(first.status, "succeeded", first.error ?? "");
  assert.equal(first.resultText, "Done on the fallback model.");
  assert.ok(models.includes("claude-sonnet-5-5"), `the fallback was used: ${models.join(", ")}`);
  const limit = (await app.inject({ method: "GET", url: "/api/model" })).json().limit;
  assert.ok(limit, "the usage limit is recorded for everyone else");

  // While the limit holds: an agent without a fallback waits, one with a fallback starts on it.
  const waiting = await h.mentionOnNewIssue(2, "aorch-plain", "do it");
  const second = await h.waitForTask((await h.mentionOnNewIssue(3, "aorch-coder", "again")).id);
  assert.equal(second.status, "succeeded", second.error ?? "");
  assert.ok((await events(second.id)).some((message) => /The usage limit is in force, so this runs on the fallback model claude-sonnet-5-5/.test(message)));
  assert.equal(db.getTask(waiting.id)!.status, "queued", "plain has no fallback, so it waits for the limit");
});
