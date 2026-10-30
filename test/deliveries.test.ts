import assert from "node:assert/strict";
import { after, test } from "node:test";
import { startHarness } from "./harness.ts";

const h = await startHarness({
  "agents/coder/agent.md": "---\nhandle: aorch-coder\ndescription: coder\ngithub:\n  push: false\n  pull_request: false\n  finalize: false\n---\nYou are coder.\n",
});
after(() => h.stop());
const { db, fake, model } = h;
model.script = () => [{ type: "text", text: "Done." }];

const comment = (number: number) => ({
  action: "created",
  sender: { login: "alice", type: "User" },
  issue: { number, title: `Issue ${number}`, html_url: `${fake.url}/acme/widgets/issues/${number}` },
  comment: { body: "@aorch-coder please look", html_url: `${fake.url}/c/${number}`, node_id: `IC_${number}` },
});
const tasksOn = (number: number) => db.listTasks({ limit: 100 }).filter((task) => task.threadNumber === number);

test("a redelivered webhook doesn't start the agent again", async () => {
  fake.addIssue({ number: 1, title: "Issue 1", body: "x", user: { login: "alice" } });
  const first = await h.sendWebhook("issue_comment", comment(1), "guid-1");
  assert.equal(first.decision, "triggered", first.detail);
  await h.waitForTask(tasksOn(1)[0]!.id);
  const again = await h.sendWebhook("issue_comment", comment(1), "guid-1");
  assert.equal(again.decision, "ignored");
  assert.equal(again.detail, "Already handled: GitHub sent this delivery again");
  assert.equal(tasksOn(1).length, 1);
});

test("a redelivery of one that failed or was ignored is handled again", async () => {
  fake.addIssue({ number: 2, title: "Issue 2", body: "x", user: { login: "alice" } });
  fake.permissions.set("bob", "read");
  const low = await h.sendWebhook("issue_comment", { ...comment(2), sender: { login: "bob", type: "User" } }, "guid-2");
  assert.equal(low.decision, "rejected");
  fake.permissions.set("bob", "write"); // an admin gave bob access, then pressed Redeliver
  const retried = await h.sendWebhook("issue_comment", { ...comment(2), sender: { login: "bob", type: "User" } }, "guid-2");
  assert.equal(retried.decision, "triggered", retried.detail);
  await h.waitForTask(tasksOn(2)[0]!.id);
});
