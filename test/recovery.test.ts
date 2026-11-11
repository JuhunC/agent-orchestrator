import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { ModelRequest } from "./fake-model.ts";
import { startHarness } from "./harness.ts";

const readOnly = "github:\n  push: false\n  pull_request: false\n  finalize: false\n";
const agent = (handle: string, extra = "") => `---\nhandle: ${handle}\ndescription: ${handle}\nlive: false\n${extra}${readOnly}---\nYou are ${handle}.\n`;
const h = await startHarness(
  {
    "agents/steady/agent.md": agent("aorch-steady"),
    // 6 seconds to work, so 6 more to wrap up.
    "agents/hasty/agent.md": agent("aorch-hasty", "timeout_minutes: 0.1\n"),
    "boards/flow.yaml": `project: acme/1
needs_human: Needs human
poll_seconds: 0
columns:
  Backlog: { agent: steady, role: ROLE_WORK, moves_to: [Done] }
  Ready: { agent: steady, role: ROLE_WORK, on_start: In progress, moves_to: [Done] }
  In progress: {}
  Done: {}
`,
  },
  // Nothing for 9 seconds counts as a hang; a start that failed is tried again after 3.
  { TASK_STALL_MINUTES: "0.15", MODEL_ERROR_RETRY_DELAY_SECONDS: "1" },
);
after(() => h.stop());
const { app, db, fake, model } = h;

const text = (value: string) => [{ type: "text" as const, text: value }];
const crash = [{ type: "tool_use" as const, id: "", name: "Bash", input: { command: "kill -9 $PPID", description: "crash" } }];
const never = () => new Promise<void>((resolve) => setTimeout(resolve, 60_000).unref());
/** Anything said so far in the session, not only the latest prompt. */
const said = (request: ModelRequest, marker: string) => JSON.stringify(request.body.messages).includes(marker);

model.script = async (request: ModelRequest) => {
  const p = request.prompt;
  if (p.includes("You ran out of time")) return text("Out of time: what's done is described above.");
  if (p.includes("nothing happened for")) return text("Carried on after the hang.");
  if (p.includes("stopped with an error")) return said(request, "CRASH_ALWAYS") ? crash : text("Finished after the error.");
  if (p.includes("SLOW_WORK") || p.includes("HANGS_HERE")) {
    await never();
    return text("too late");
  }
  if (p.includes("CRASH_")) return crash;
  if (p.includes("REFUSED_REQUEST")) return { status: 400, error: { type: "invalid_request_error", message: "prompt is not allowed here" } };
  return text("OK");
};
const events = async (id: number) => ((await app.inject({ method: "GET", url: `/api/tasks/${id}` })).json().events as { message: string }[]).map((event) => event.message);
const promptsOf = (marker: string) => model.agentRequests().filter((request) => said(request, marker)).map((request) => request.prompt);

test("a task that runs out of time gets a short extra turn to wrap up", async () => {
  const task = await h.waitForTask((await h.mentionOnNewIssue(1, "aorch-hasty", "SLOW_WORK please")).id);
  assert.equal(task.status, "succeeded", task.error ?? "");
  assert.equal(task.resultText, "Out of time: what's done is described above.");
  assert.equal(task.recoveries, 1);
  const log = await events(task.id);
  assert.ok(log.some((message) => /^Timed out after 6 seconds/.test(message)), log.join("\n"));
  assert.ok(log.some((message) => /^Continuing the task because it ran out of time/.test(message)), log.join("\n"));
  assert.match(promptsOf("SLOW_WORK").at(-1)!, /You ran out of time.*6 seconds more to wrap up/s);
  assert.match(task.prompt ?? "", /SLOW_WORK/, "the task keeps its first prompt, not the wrap-up one");
});

test("an agent that goes silent is stopped and carries on in the same session", async () => {
  const task = await h.waitForTask((await h.mentionOnNewIssue(2, "aorch-steady", "HANGS_HERE please")).id);
  assert.equal(task.status, "succeeded", task.error ?? "");
  assert.equal(task.resultText, "Carried on after the hang.");
  assert.equal(task.recoveries, 1);
  const log = await events(task.id);
  assert.ok(log.some((message) => /^Nothing happened for 9 seconds: stopped the turn/.test(message)), log.join("\n"));
  assert.ok(log.some((message) => /^Continuing the task because it went silent/.test(message)), log.join("\n"));
});

test("an error is shown to the agent, which gets one more go; a second one fails the task", async () => {
  const once = await h.waitForTask((await h.mentionOnNewIssue(3, "aorch-steady", "CRASH_ONCE please")).id);
  assert.equal(once.status, "succeeded", once.error ?? "");
  assert.equal(once.resultText, "Finished after the error.");
  assert.equal(once.recoveries, 1);
  assert.match(promptsOf("CRASH_ONCE").at(-1)!, /Your last turn stopped with an error/);

  const always = await h.waitForTask((await h.mentionOnNewIssue(4, "aorch-steady", "CRASH_ALWAYS please")).id);
  assert.equal(always.status, "failed");
  assert.equal(always.recoveries, 1);
  assert.match(always.error ?? "", /It had already been continued once \(it stopped with an error\)\.$/);
  assert.match(fake.issues.get(4)!.comments.at(-1)!.body, /couldn't finish ❌/);
});

test("what can't get better isn't tried again: a refused request, and with TASK_FAILURE_RETRIES=0 nothing is", async () => {
  const refused = await h.waitForTask((await h.mentionOnNewIssue(5, "aorch-steady", "REFUSED_REQUEST please")).id);
  assert.equal(refused.status, "failed");
  assert.equal(refused.recoveries, 0);
  assert.ok(!(await events(refused.id)).some((message) => /^Continuing the task/.test(message)), "no second go");

  const { config } = await import("../src/config.ts");
  config.taskFailureRetries = 0;
  try {
    const task = await h.waitForTask((await h.mentionOnNewIssue(6, "aorch-steady", "CRASH_ONCE again")).id);
    assert.equal(task.status, "failed");
    assert.equal(task.recoveries, 0);
    assert.doesNotMatch(task.error ?? "", /already been continued/);
  } finally {
    config.taskFailureRetries = 1;
  }
});

test("a start that failed for a passing reason is tried again a little later", async () => {
  const { temporarySetupError } = await import("../src/runner/run-task.ts");
  assert.ok(temporarySetupError("Bad Gateway"));
  assert.ok(temporarySetupError("fatal: unable to access 'https://github.com/acme/widgets.git/': Could not resolve host: github.com"));
  assert.ok(temporarySetupError("connect ECONNREFUSED 127.0.0.1:443"));
  assert.ok(!temporarySetupError('Agent "coder" no longer exists'));
  assert.ok(!temporarySetupError("The coder profile has errors: unknown key"));

  // GitHub answers 502 to the first look at the issue, through Octokit's own three retries.
  h.scheduler.setPaused(true);
  const queued = await h.mentionOnNewIssue(7, "aorch-steady", "after the outage");
  fake.badGateway = 4;
  h.scheduler.setPaused(false);
  for (let i = 0; i < 600 && !(db.getTask(queued.id)!.status === "queued" && db.getTask(queued.id)!.waitReason === "setup"); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  const waiting = db.getTask(queued.id)!;
  assert.equal(waiting.waitReason, "setup", `${waiting.status}: ${waiting.error ?? ""}`);
  assert.ok(waiting.retryAt, "it knows when to try again");
  assert.ok((await events(queued.id)).some((message) => /^Couldn't get started \(.*Bad Gateway.*\)\. Trying again at/.test(message)));
  const task = await h.waitForTask(queued.id);
  assert.equal(task.status, "succeeded", task.error ?? "");
  assert.equal(task.waitReason, null);
});

/** A person drags the card into `column` on GitHub. */
async function humanMoves(itemId: string, column: string) {
  const item = fake.items.get(itemId)!;
  item.status = column;
  item.history.push(column);
  return h.sendWebhook("projects_v2_item", {
    action: "edited",
    sender: { login: "alice", type: "User" },
    organization: { login: "acme" },
    projects_v2_item: { node_id: itemId, project_node_id: fake.project.id, content_type: "Issue" },
    changes: { field_value: { field_node_id: "F_status", field_type: "single_select" } },
  });
}
async function settled(itemId: string) {
  for (let i = 0; i < 900; i++) {
    const tasks = db.listTasks({ limit: 50 }).filter((task) => task.boardItemId === itemId);
    if (tasks.length && tasks.every((task) => !["queued", "running"].includes(task.status))) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await h.scheduler.idle();
}

test("a card whose agent failed moves to needs-human instead of staying where it looks worked on", async () => {
  fake.addIssue({ number: 8, title: "Breaks", body: "CRASH_ALWAYS on this card", user: { login: "alice" } });
  const plain = fake.addItem(8);
  await humanMoves(plain, "Backlog");
  await settled(plain);
  assert.equal(fake.items.get(plain)!.status, "Needs human", fake.items.get(plain)!.history.join(" → "));
  assert.match(fake.issues.get(8)!.comments.at(-1)!.body, /\*\*steady\*\* couldn't finish its work in \*\*Backlog\*\*, so the card moved to \*\*Needs human\*\*/);

  // The agent moved the card to In progress when it started (on_start); it's found there too.
  fake.addIssue({ number: 9, title: "Breaks later", body: "CRASH_ALWAYS on this card too", user: { login: "alice" } });
  const started = fake.addItem(9);
  await humanMoves(started, "Ready");
  await settled(started);
  assert.deepEqual(fake.items.get(started)!.history.slice(-3), ["Ready", "In progress", "Needs human"]);
  const outcomes = (await app.inject({ method: "GET", url: "/api/outcomes?days=1" })).json();
  assert.ok(JSON.stringify(outcomes).includes("needsHuman"), "the outcomes report counts cards sent to a person");
});

test("the limits are listed with the other guards", async () => {
  const guards = (await app.inject({ method: "GET", url: "/api/guards" })).json().global as { setting: string; value: string }[];
  assert.equal(guards.find((guard) => guard.setting === "TASK_FAILURE_RETRIES")?.value, "1");
  assert.equal(guards.find((guard) => guard.setting === "TASK_STALL_MINUTES")?.value, "0.15 min");
});
