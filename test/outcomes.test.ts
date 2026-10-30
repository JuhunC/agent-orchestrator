import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { ModelRequest } from "./fake-model.ts";
import { startHarness } from "./harness.ts";

const h = await startHarness({ "agents/coder/agent.md": "---\nhandle: aorch-coder\ndescription: coder\nlive: false\n---\nYou are coder.\n" });
after(() => h.stop());
const { app, fake, model } = h;
model.script = (request: ModelRequest) => {
  const steps = [
    { type: "tool_use" as const, id: "", name: "Bash", input: { command: `echo ${request.prompt.includes("first") ? "a" : "b"} > file.txt`, description: "write" } },
    { type: "tool_use" as const, id: "", name: "mcp__github__commit_and_push", input: { message: "Change" } },
    { type: "tool_use" as const, id: "", name: "mcp__github__open_pull_request", input: { title: "Change", body: "A change" } },
    { type: "text" as const, text: "Done." },
  ];
  return [steps[Math.min(request.step, steps.length - 1)]!];
};
const closed = (number: number, merged: boolean) =>
  h.sendWebhook("pull_request", {
    action: "closed",
    sender: { login: "alice", type: "User" },
    pull_request: { number, title: "Change", html_url: `${fake.url}/acme/widgets/pull/${number}`, node_id: `PR_${number}`, merged, merged_at: merged ? new Date().toISOString() : null, closed_at: new Date().toISOString(), base: { ref: "main" }, head: { ref: "x" } },
  });

test("outcomes: tasks that succeeded, pull requests merged or closed, cost per merged pull request", async () => {
  const first = await h.waitForTask((await h.mentionOnNewIssue(1, "aorch-coder", "first change")).id);
  const second = await h.waitForTask((await h.mentionOnNewIssue(2, "aorch-coder", "second change")).id);
  assert.ok(first.prNumber && second.prNumber, `both opened pull requests: ${first.error ?? ""} ${second.error ?? ""}`);
  let report = (await app.inject({ method: "GET", url: "/api/outcomes?days=7" })).json();
  assert.deepEqual(report.agents[0].pulls, { opened: 2, merged: 0, closed: 0, open: 2 });
  assert.equal(report.agents[0].mergeRate, null, "nothing decided yet");

  await closed(first.prNumber!, true);
  await closed(second.prNumber!, false);
  report = (await app.inject({ method: "GET", url: "/api/outcomes?days=7" })).json();
  const coder = report.agents[0];
  assert.equal(coder.agent, "coder");
  assert.deepEqual(coder.tasks, { succeeded: 2, failed: 0, cancelled: 0 });
  assert.equal(coder.successRate, 1);
  assert.deepEqual(coder.pulls, { opened: 2, merged: 1, closed: 1, open: 0 });
  assert.equal(coder.mergeRate, 0.5);
  assert.ok(coder.costUsd > 0);
  assert.ok(Math.abs(coder.costPerMergedPull - coder.costUsd) < 1e-9, "all its spend, over one merged pull request");
  assert.ok(coder.avgTaskMinutes >= 0);
  assert.deepEqual(report.totals.pulls, coder.pulls);
});
