import assert from "node:assert/strict";
import { after, test } from "node:test";
import { startHarness } from "./harness.ts";

const readOnly = "github:\n  push: false\n  pull_request: false\n  finalize: false\n";
const h = await startHarness({
  "agents/coder/agent.md": `---\nhandle: aorch-coder\ndescription: coder\n${readOnly}---\nYou are coder.\n`,
  "agents/oneoff/agent.md": `---\nhandle: aorch-oneoff\ndescription: oneoff\nlive: false\n${readOnly}---\nYou are oneoff.\n`,
});
after(() => h.stop());
const { app, model } = h;

// Every task makes two model calls; the fake model answers each with 100 input and 20 output tokens.
model.script = (request) => (request.step === 0 ? [{ type: "tool_use", id: "", name: "Bash", input: { command: "echo hi", description: "say hi" } }] : [{ type: "text", text: "Done." }]);

test("each task records its own cost and tokens, not the session's running total", async () => {
  // A live session (one process for both tasks) and a resumed one (a new process per task).
  for (const [handle, issue] of [["aorch-coder", 1], ["aorch-oneoff", 2]] as const) {
    const first = await h.waitForTask((await h.mentionOnNewIssue(issue, handle)).id);
    const second = await h.waitForTask((await h.commentMention(issue, `@${handle} once more`)).id);
    for (const task of [first, second]) {
      assert.equal(task.status, "succeeded", task.error ?? "");
      assert.equal(task.usage?.inputTokens, 200, `${task.agent} task ${task.id}`);
      assert.equal(task.usage?.outputTokens, 40, `${task.agent} task ${task.id}`);
      assert.deepEqual(Object.keys(task.usage?.models ?? {}), ["claude-opus-5-5"]);
    }
    assert.equal(second.costUsd, first.costUsd, `${handle}: the second task's cost doesn't include the first's`);
  }
});

test("the usage report adds up per agent, day and model", async () => {
  const report = (await app.inject({ method: "GET", url: "/api/usage?days=7" })).json();
  assert.equal(report.days, 7);
  assert.equal(report.daily.length, 7);
  assert.equal(report.totals.tasks, 4);
  assert.equal(report.totals.inputTokens, 800);
  assert.equal(report.totals.outputTokens, 160);
  assert.deepEqual(report.agents.map((row: { agent: string; tasks: number; inputTokens: number }) => [row.agent, row.tasks, row.inputTokens]).sort(), [["coder", 2, 400], ["oneoff", 2, 400]]);
  const today = report.daily.at(-1);
  assert.equal(today.day, new Date().toISOString().slice(0, 10));
  assert.equal(today.tokens, 960);
  assert.ok(Math.abs(today.costUsd - report.totals.costUsd) < 1e-9);
  assert.deepEqual(report.models.map((row: { model: string; inputTokens: number }) => [row.model, row.inputTokens]), [["claude-opus-5-5", 800]]);
  assert.equal(report.topTasks.length, 4);

  const one = (await app.inject({ method: "GET", url: "/api/usage?days=30&agent=oneoff" })).json();
  assert.equal(one.days, 30);
  assert.deepEqual(one.agents.map((row: { agent: string }) => row.agent), ["oneoff"]);
  assert.equal(one.totals.inputTokens, 400);
  assert.ok(one.topTasks.every((task: { agent: string }) => task.agent === "oneoff"));
});
