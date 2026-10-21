import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { ModelRequest } from "./fake-model.ts";
import { startHarness } from "./harness.ts";

const h = await startHarness({
  "agents/worker/agent.md": "---\nhandle: aorch-worker\ndescription: worker\n---\nYou are worker.\n",
});
after(() => h.stop());
const { db, fake, model } = h;
fake.permissions.set("bob", "write");
fake.permissions.set("carol", "read");

const sleep = (seconds: number) => [{ type: "tool_use" as const, id: "", name: "Bash", input: { command: `sleep ${seconds}`, description: "work" } }];
const say = (text: string) => [{ type: "text" as const, text }];
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let gate: Promise<void> = Promise.resolve();

/** Everything the model has been sent in this request, as text. */
const seen = (request: ModelRequest) => JSON.stringify(request.body.messages);
const toolCalls = (request: ModelRequest) => (seen(request).match(/"type":"tool_use"/g) ?? []).length;

model.script = async (request: ModelRequest) => {
  const all = seen(request);
  const calls = toolCalls(request);
  if (all.includes("MID_TASK")) {
    if (calls === 0) return sleep(3);
    return say(all.includes("please use tabs") && all.includes("added the label") ? `Saw it: ${all.includes("treat it as information") ? "flagged carol" : "no flag"}` : "Saw nothing");
  }
  if (all.includes("AT_THE_END")) {
    if (all.includes("New activity on GitHub")) return say(all.includes("also bump the version") ? "Handled the late comment" : "Odd news");
    // Holds the final answer back until the test has commented, so the Stop hook has news.
    await gate;
    return say("First pass done");
  }
  if (all.includes("MENTIONED")) {
    if (calls === 0) return sleep(3);
    return say(all.includes("also update the docs") ? "Updated the docs too" : "Missed the mention");
  }
  return say("Done.");
};

const comment = (number: number, login: string, body: string) =>
  h.sendWebhook("issue_comment", {
    action: "created",
    sender: { login, type: "User" },
    issue: { number, title: `Issue ${number}`, html_url: `${fake.url}/acme/widgets/issues/${number}` },
    comment: { body, html_url: `${fake.url}/c/${number}-${Math.random()}`, node_id: "IC", user: { login, type: "User" } },
  });

async function untilRunning(id: number) {
  await h.waitForTask(id, ["running"]);
  // Give Claude Code a moment to start the first tool call.
  for (let i = 0; i < 200 && !model.agentRequests().some((request) => toolCalls(request) === 0 && seen(request).includes(`#${db.getTask(id)!.threadNumber}`)); i++) await pause(50);
}

test("people's comments and actions reach the agent mid-task, flagged when they can't start agents", async () => {
  const task = await h.mentionOnNewIssue(501, "aorch-worker", "MID_TASK");
  await untilRunning(task.id);
  const first = await comment(501, "bob", "please use tabs");
  assert.equal(first.decision, "forwarded", first.detail);
  assert.match(first.detail, /Passed to worker/);
  const labelled = await h.sendWebhook("issues", {
    action: "labeled",
    sender: { login: "carol", type: "User" },
    label: { name: "style" },
    issue: { number: 501, title: "Issue 501", html_url: `${fake.url}/acme/widgets/issues/501` },
  });
  assert.equal(labelled.decision, "forwarded", labelled.detail);
  // A bot's comment isn't forwarded.
  const bot = await h.sendWebhook("issue_comment", {
    action: "created",
    sender: { login: "someone[bot]", type: "Bot" },
    issue: { number: 501, title: "Issue 501", html_url: "x" },
    comment: { body: "beep", html_url: "x", node_id: "IC", user: { login: "someone[bot]", type: "Bot" } },
  });
  assert.equal(bot.decision, "ignored");

  const done = await h.waitForTask(task.id);
  assert.equal(done.status, "succeeded", done.error ?? "");
  assert.equal(done.resultText, "Saw it: flagged carol");
  const events = db.listEvents(task.id, 0).filter((event) => event.kind === "github").map((event) => event.message);
  assert.ok(events.some((message) => message.startsWith("@bob commented: please use tabs")), events.join("\n"));
  assert.ok(events.some((message) => message.startsWith("@carol added the label `style`")), events.join("\n"));
  assert.ok(events.some((message) => /^Passed 2 updates from GitHub/.test(message)), events.join("\n"));
});

test("news that arrives as the agent is finishing keeps it going", async () => {
  let open!: () => void;
  gate = new Promise((resolve) => (open = resolve));
  const task = await h.mentionOnNewIssue(502, "aorch-worker", "AT_THE_END");
  await h.waitForTask(task.id, ["running"]);
  for (let i = 0; i < 200 && !model.agentRequests().some((request) => seen(request).includes("AT_THE_END")); i++) await pause(50);
  const delivery = await comment(502, "bob", "also bump the version");
  assert.equal(delivery.decision, "forwarded", delivery.detail);
  open();
  const done = await h.waitForTask(task.id);
  assert.equal(done.status, "succeeded", done.error ?? "");
  assert.equal(done.resultText, "Handled the late comment");
});

test("mentioning an agent that's already on the thread tells it instead of queueing another run", async () => {
  const task = await h.mentionOnNewIssue(503, "aorch-worker", "MENTIONED");
  await untilRunning(task.id);
  const before = db.listTasks({ limit: 100 }).length;
  const delivery = await comment(503, "bob", "@aorch-worker also update the docs");
  assert.equal(delivery.decision, "forwarded", delivery.detail);
  assert.equal(db.listTasks({ limit: 100 }).length, before, "no new task");
  const done = await h.waitForTask(task.id);
  assert.equal(done.resultText, "Updated the docs too");
});

test("a mention the agent never saw becomes a follow-up task; activity on its PR reaches it", async () => {
  const { deliver, settleInbox, activityFor } = await import("../src/runner/inbox.ts");
  fake.addIssue({ number: 504, title: "Issue 504", body: "x", user: { login: "bob" } });
  const task = db.createTask({
    agent: "worker", installationId: 77, owner: "acme", repo: "widgets", threadKind: "issue", threadNumber: 504, threadTitle: "Issue 504", threadUrl: "",
    triggerKind: "mention", requestedBy: "bob", requestText: "x", requestUrl: "",
  });
  // Pretend it's running and has opened PR #600.
  const running = db.updateTask(task.id, { status: "running", prNumber: 600 });
  const review = activityFor("pull_request_review", {
    action: "submitted",
    repository: { full_name: "acme/widgets" },
    sender: { login: "bob", type: "User" },
    review: { state: "changes_requested", body: "rename it", html_url: "r" },
    pull_request: { number: 600 },
  })!;
  assert.equal(review.summary, "requested changes");
  assert.deepEqual(db.runningTasksForThread(review.ref).map((found) => found.id), [task.id]);
  const push = activityFor("pull_request", { action: "synchronize", after: "abcdef1234", repository: { full_name: "acme/widgets" }, sender: { login: "bob" }, pull_request: { number: 600, head: { ref: "agent/worker/x" } } })!;
  assert.match(push.summary, /pushed to `agent\/worker\/x` \(now abcdef1\)/);

  deliver(running, { ...review, ref: { owner: "acme", repo: "widgets", kind: "issue", number: 504 }, summary: "commented", body: "@aorch-worker one more thing" }, { trusted: true, mention: true });
  db.updateTask(task.id, { status: "succeeded" });
  const follow = settleInbox(db.getTask(task.id)!, true);
  assert.ok(follow);
  assert.equal(follow.threadNumber, 504);
  assert.match(follow.requestText, /one more thing/);
  h.scheduler.kick();
  assert.equal((await h.waitForTask(follow.id)).status, "succeeded");
});
