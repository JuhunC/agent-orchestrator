import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { ModelRequest } from "./fake-model.ts";
import { startHarness } from "./harness.ts";

const agent = (name: string) => `---\nhandle: aorch-${name}\ndescription: ${name}\nlive: false\ngithub:\n  push: false\n  pull_request: false\n  finalize: false\n---\nYou are ${name}.\n`;
const h = await startHarness(
  {
    "agents/helper/agent.md": agent("helper"),
    "agents/second/agent.md": agent("second"),
    "boards/flow.yaml": `project: acme/1
needs_human: Needs human
poll_seconds: 0
columns:
  Backlog: { agent: helper, role: ROLE_WORK, moves_to: [Done] }
  Done: {}
`,
  },
  { METRICS_TOKEN: "scrape" },
);
after(() => h.stop());
const { app, db, fake, model } = h;
const { config } = await import("../src/config.ts");
const { checkWaits } = await import("../src/runner/waits.ts");

const text = (value: string) => [{ type: "text" as const, text: value }];
const call = (name: string, input: Record<string, unknown>) => [{ type: "tool_use" as const, id: "", name: `mcp__github__${name}`, input }];
/** What the tools answered in this session so far. */
const toolResults = (request: ModelRequest) =>
  JSON.stringify((request.body.messages as { content: unknown }[]).flatMap((message) => (Array.isArray(message.content) ? message.content.filter((block: { type: string }) => block.type === "tool_result") : [])));
const answers: string[] = [];

model.script = (request: ModelRequest) => {
  const p = request.prompt;
  const steps = (...turns: ReturnType<typeof call>[]) => turns[request.step] ?? (answers.push(toolResults(request)), text("Here's where it stands."));
  const back = p.includes("You paused this task until");
  const issue = Number(p.match(/WAIT_FOR_ISSUE_(\d+)/)?.[1] ?? 0);
  const review = Number(p.match(/WAIT_FOR_REVIEW_(\d+)/)?.[1] ?? 0);
  if (back && p.includes("WAIT_TWICE")) return steps(call("wait_for", { until: "issues_closed", issues: [issue], note: "Still needs that issue." }));
  if (back) return text("Carried on after the pause and finished.");
  if (p.includes("PLAIN_ANSWER")) return text("All done.");
  if (p.includes("WAIT_SUBS")) return steps(call("wait_for", { until: "sub_issues_done", note: "I'll put the parts together." }));
  if (p.includes("WAIT_A_MOMENT")) return steps(call("wait_for", { until: "time", hours: 0.0005, note: "Let the build settle." }));
  if (review) return steps(call("wait_for", { until: "pull_reviewed", pull: review, note: "I'll answer the review." }));
  if (issue) return steps(call("wait_for", { until: "issues_closed", issues: [issue], note: `I need #${issue} first.` }));
  return text("All done.");
};

const overview = async () => (await app.inject({ method: "GET", url: "/api/overview" })).json() as { queued: { id: number }[]; waiting: { id: number }[]; running: { id: number }[] };
const listed = async (status: string) => ((await app.inject({ method: "GET", url: `/api/tasks?status=${status}` })).json() as { id: number }[]).map((row) => row.id);
const events = async (id: number) => ((await app.inject({ method: "GET", url: `/api/tasks/${id}` })).json() as { events: { message: string }[] }).events.map((event) => event.message);
const lastComment = (issue: number) => fake.issues.get(issue)!.comments.at(-1)?.body ?? "";
const open = (number: number, extra: Record<string, unknown> = {}) => fake.addIssue({ number, title: `Other ${number}`, body: "x", user: { login: "alice" }, ...extra });

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`never happened: ${what}`);
}

/** Waits until the task's agent has paused it and the thread has been told. */
async function paused(id: number) {
  const task = await h.waitForTask(id, ["queued"], (candidate) => candidate?.waitReason === "wake");
  await until(() => /paused this task ⏳/.test(lastComment(task.threadNumber)), "the paused comment");
  return task;
}

const closedWebhook = (number: number) =>
  h.sendWebhook("issues", { action: "closed", sender: { login: "alice", type: "User" }, issue: { number, title: `Other ${number}`, state: "closed", html_url: `${fake.url}/acme/widgets/issues/${number}` } });

test("an agent pauses its task until its sub-issues are closed, holds no slot, and carries on in the same session", async () => {
  open(11, { parent: 10 });
  open(12, { parent: 10 });
  const task = await paused((await h.mentionOnNewIssue(10, "aorch-helper", "WAIT_SUBS please")).id);
  assert.equal(task.waits, 1);
  assert.equal(task.waitFor?.until, "sub_issues_done");
  assert.ok(task.retryAt && Date.parse(task.retryAt) > Date.now() + 3_600_000, "the deadline is the longest pause");
  assert.match(answers.at(-1)!, /This task will be paused until this issue's sub-issues are closed \(2 of 2 sub-issues are still open \(#11, #12\)\), and at the latest at/);
  assert.match(lastComment(10), /\*\*helper\*\* paused this task ⏳ — it carries on when \*\*this issue's sub-issues are closed\*\*, or at the latest /);
  assert.match(lastComment(10), /\*\*Why:\*\* I'll put the parts together\.[\s\S]*Here's where it stands\.[\s\S]*Mention it here to wake it sooner/);

  // It's listed as paused, not as queued or running.
  const page = await overview();
  assert.deepEqual(page.waiting.map((row) => row.id), [task.id]);
  assert.deepEqual([page.queued, page.running], [[], []]);
  assert.deepEqual(await listed("waiting"), [task.id]);
  assert.deepEqual(await listed("queued"), []);
  const metrics = (await app.inject({ method: "GET", url: "/metrics", headers: { authorization: "Bearer scrape" } })).body;
  assert.match(metrics, /^ao_tasks_paused 1$/m);
  assert.match(metrics, /^ao_tasks_queued 0$/m);
  const guards = (await app.inject({ method: "GET", url: "/api/guards" })).body;
  assert.match(guards, /Longest pause/);
  assert.match(guards, /Pauses per task/);

  // The agent is free for other work, and another agent on the thread is told about the pause.
  const elsewhere = await h.waitForTask((await h.mentionOnNewIssue(13, "aorch-helper", "PLAIN_ANSWER a quick one")).id);
  assert.equal(elsewhere.status, "succeeded", elsewhere.error ?? "");
  const other = await h.waitForTask((await h.commentMention(10, "@aorch-second PLAIN_ANSWER what's going on here?")).id);
  assert.match(other.prompt ?? "", new RegExp(`### helper — paused until other work is done \\(I'll put the parts together\\.\\) on issue #10 \\(task ${task.id}\\)`));

  // One sub-issue closing isn't enough; the second one wakes it.
  fake.issues.get(11)!.state = "closed";
  assert.equal(await checkWaits(), 0);
  assert.equal(db.getTask(task.id)!.waitReason, "wake");
  fake.issues.get(12)!.state = "closed";
  await closedWebhook(12);
  const done = await h.waitForTask(task.id);
  assert.equal(done.status, "succeeded", done.error ?? "");
  assert.equal(done.waitFor, null);
  assert.equal(done.waits, 1);
  assert.match(done.prompt ?? "", /You paused this task until this issue's sub-issues are closed\. It has been resumed because all 2 sub-issues are closed \(#11, #12\)\. Your work so far is in the working copy and in this session\./);
  assert.doesNotMatch(done.prompt ?? "", /paused this task ⏳/, "its own paused comment is no news to it");
  assert.match(done.prompt ?? "", /### second — run \d+/, "it's told what another agent did here meanwhile");
  assert.match(lastComment(10), /\*\*helper\*\* finished ✅[\s\S]*Carried on after the pause and finished\./);
  assert.ok((await events(task.id)).includes("Woken: all 2 sub-issues are closed (#11, #12)"));
  assert.deepEqual((await overview()).waiting, []);
});

test("nothing to wait for: the agent is told to carry on, and the task isn't paused", async () => {
  const task = await h.waitForTask((await h.mentionOnNewIssue(20, "aorch-helper", "WAIT_SUBS please")).id);
  assert.equal(task.status, "succeeded", task.error ?? "");
  assert.equal(task.waits, 0);
  assert.match(answers.at(-1)!, /No need to wait: this issue has no sub-issues any more\. Carry on now\./);
  assert.match(lastComment(20), /\*\*helper\*\* finished ✅/);
});

test("a pause for a time ends by itself, and any pause ends at the longest wait", async () => {
  const timed = await h.mentionOnNewIssue(30, "aorch-helper", "WAIT_A_MOMENT please");
  await paused(timed.id);
  assert.match(lastComment(30), /paused this task ⏳ — it carries on at \*\*\d{4}-\d\d-\d\d \d\d:\d\d UTC\*\*\./);
  const first = await h.waitForTask(timed.id);
  assert.equal(first.status, "succeeded", first.error ?? "");
  assert.match(first.prompt ?? "", /It has been resumed because the time you asked for has passed\./);

  const longest = config.waitMaxHours;
  config.waitMaxHours = 0.0005;
  try {
    open(32);
    const waiting = await h.mentionOnNewIssue(31, "aorch-helper", "WAIT_FOR_ISSUE_32 please");
    const second = await h.waitForTask(waiting.id);
    assert.equal(second.status, "succeeded", second.error ?? "");
    assert.match(second.prompt ?? "", /You paused this task until #32 is closed\. It has been resumed because the longest time to wait is over \([^)]+\), though 1 of 1 issue is still open \(#32\)\./);
  } finally {
    config.waitMaxHours = longest;
  }
});

test("writing to the agent wakes it, and it reads what was written once", async () => {
  open(41);
  const task = await paused((await h.mentionOnNewIssue(40, "aorch-helper", "WAIT_FOR_ISSUE_41 please")).id);
  const comment = (id: number, login: string, body: string) => ({ id, body, user: { login, type: "User" }, created_at: new Date().toISOString(), html_url: `${fake.url}/c/${id}`, edits: 0 });
  const said = "@aorch-helper NEWS_WORD #41 won't happen, go on without it";
  fake.issues.get(40)!.comments.push(comment(9001, "bob", "OTHER_NOTE the design changed"), comment(9002, "alice", said));
  const delivery = await h.sendWebhook("issue_comment", {
    action: "created",
    sender: { login: "alice", type: "User" },
    issue: { number: 40, title: "Issue 40", html_url: `${fake.url}/acme/widgets/issues/40` },
    comment: { body: said, html_url: `${fake.url}/c/9002`, node_id: "IC" },
  });
  assert.equal(delivery.decision, "forwarded", delivery.detail);
  assert.match(delivery.detail, new RegExp(`Woke helper \\(task #${task.id}\\), which had paused`));

  const done = await h.waitForTask(task.id);
  assert.equal(done.status, "succeeded", done.error ?? "");
  const prompt = done.prompt ?? "";
  assert.match(prompt, /You paused this task until #41 is closed\. It has been resumed because @alice wrote to you on the thread\./);
  assert.match(prompt, /## What came in while you were paused[\s\S]*@alice wrote to you[\s\S]*> @aorch-helper NEWS_WORD/);
  assert.equal(prompt.split("NEWS_WORD").length - 1, 1, "the mention isn't repeated among the thread's new comments");
  assert.match(prompt, /## New on the thread since you paused \(oldest first\)[\s\S]*OTHER_NOTE the design changed/);
  assert.equal(db.listTasks({ limit: 500 }).filter((row) => row.threadNumber === 40).length, 1, "no second task for the mention");
});

test("a review wakes a task that waits for one", async () => {
  fake.addIssue({ number: 51, title: "A change", body: "x", user: { login: "alice" }, pull: { head: "feature", base: "main" } });
  const task = await paused((await h.mentionOnNewIssue(50, "aorch-helper", "WAIT_FOR_REVIEW_51 please")).id);
  assert.match(answers.at(-1)!, /paused until pull request #51 is reviewed \(nobody has reviewed pull request #51 since you paused\)/);
  fake.reviews.push({ number: 51, event: "REQUEST_CHANGES", body: "Rename it", login: "bob", submittedAt: new Date().toISOString() });
  await h.sendWebhook("pull_request_review", {
    action: "submitted",
    sender: { login: "bob", type: "User" },
    pull_request: { number: 51, title: "A change", html_url: `${fake.url}/acme/widgets/pull/51` },
    review: { state: "changes_requested", body: "Rename it", html_url: `${fake.url}/acme/widgets/pull/51#r1` },
  });
  const done = await h.waitForTask(task.id);
  assert.equal(done.status, "succeeded", done.error ?? "");
  assert.match(done.prompt ?? "", /It has been resumed because @bob reviewed pull request #51 and asked for changes\./);
});

test("a person wakes a paused task from the admin UI; a task can only pause so often", async () => {
  const most = config.taskMaxWaits;
  config.taskMaxWaits = 1;
  try {
    open(61);
    const task = await paused((await h.mentionOnNewIssue(60, "aorch-helper", "WAIT_TWICE WAIT_FOR_ISSUE_61 please")).id);
    assert.equal((await app.inject({ method: "POST", url: `/api/tasks/${task.id}/run-now` })).statusCode, 200);
    const done = await h.waitForTask(task.id);
    assert.equal(done.status, "succeeded", done.error ?? "");
    assert.equal(done.waits, 1);
    assert.match(done.prompt ?? "", /It has been resumed because @dev resumed it from the admin UI\./);
    assert.match(answers.at(-1)!, /This task has already been paused 1 time, the most allowed\. Finish now/);
    assert.equal((await app.inject({ method: "POST", url: `/api/tasks/${task.id}/run-now` })).statusCode, 409);
  } finally {
    config.taskMaxWaits = most;
  }
});

test("cancelling a paused task tells the thread it won't carry on", async () => {
  open(71);
  const task = await paused((await h.mentionOnNewIssue(70, "aorch-helper", "WAIT_FOR_ISSUE_71 please")).id);
  assert.equal((await app.inject({ method: "POST", url: `/api/tasks/${task.id}/cancel` })).statusCode, 200);
  assert.equal(db.getTask(task.id)!.status, "cancelled");
  await until(() => /paused task was cancelled/.test(lastComment(70)), "the cancelled comment");
  assert.match(lastComment(70), /\*\*helper\*\*'s paused task was cancelled ⏹️ and won't carry on\.[\s\S]*Cancelled from the admin UI while it was paused/);
  assert.deepEqual((await overview()).waiting, []);
});

test("a card stays in its column while its agent is paused; moving it away cancels the pause", async () => {
  open(81);
  fake.addIssue({ number: 80, title: "A card", body: "WAIT_FOR_ISSUE_81 before you build this", user: { login: "alice" } });
  const item = fake.addItem(80);
  const moves = async (column: string) => {
    const card = fake.items.get(item)!;
    card.status = column;
    card.history.push(column);
    return h.sendWebhook("projects_v2_item", {
      action: "edited",
      sender: { login: "alice", type: "User" },
      organization: { login: "acme" },
      projects_v2_item: { node_id: item, project_node_id: fake.project.id, content_type: "Issue" },
      changes: { field_value: { field_node_id: "F_status", field_type: "single_select" } },
    });
  };
  await moves("Backlog");
  await until(() => db.listTasks({ limit: 1 })[0]?.threadNumber === 80, "the column's agent starting");
  const task = await paused(db.listTasks({ limit: 1 })[0]!.id);
  await h.scheduler.idle();
  assert.equal(fake.items.get(item)!.status, "Backlog", "the card isn't parked for a person");
  assert.ok(!fake.issues.get(80)!.comments.some((comment) => /didn't all finish|couldn't finish/.test(comment.body)));

  await moves("Done");
  await until(() => db.getTask(task.id)!.status === "cancelled", "the paused task being cancelled");
  assert.match(db.getTask(task.id)!.error ?? "", /The card was moved to "Done"/);
  await until(() => /paused task was cancelled/.test(lastComment(80)), "the cancelled comment");
});
