import assert from "node:assert/strict";
import { after, test } from "node:test";
import { startHarness } from "./harness.ts";

const h = await startHarness(
  { "agents/coder/agent.md": "---\nhandle: aorch-coder\ndescription: coder\nlive: false\ngithub:\n  push: false\n  pull_request: false\n  finalize: false\n---\nYou are coder.\n" },
  { MAX_CONCURRENT_TASKS: "1" },
);
after(() => h.stop());
const { app, db, fake, model } = h;
model.script = () => [{ type: "text", text: "Done." }];
const { queueOrder, priorityFromLabels } = await import("../src/runner/queue-order.ts");
const { config } = await import("../src/config.ts");
const overview = async () => ((await app.inject({ method: "GET", url: "/api/overview" })).json() as { queued: { id: number }[] }).queued.map((task) => task.id);
const page = async (id: number) => (await app.inject({ method: "GET", url: `/api/tasks/${id}` })).json() as { task: { priority: string }; events: { message: string }[]; queue: { ahead: number; why: string } | null };
const setPriority = (id: number, priority: string) => app.inject({ method: "POST", url: `/api/tasks/${id}/priority`, payload: { priority } });
const pause = (paused: boolean) => app.inject({ method: "PUT", url: "/api/settings", payload: { paused } });

test("queue order: people first, then agent-started work, then board stages; long waits go first", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  const tasks = [
    { id: 1, triggerKind: "board" as const, createdAt: at(5) },
    { id: 2, triggerKind: "agent" as const, createdAt: at(4) },
    { id: 3, triggerKind: "mention" as const, createdAt: at(3) },
    { id: 4, triggerKind: "board" as const, createdAt: at(45) },
    { id: 5, triggerKind: "manual" as const, createdAt: at(1) },
  ];
  assert.deepEqual(queueOrder(tasks, now).map((task) => task.id), [4, 3, 5, 2, 1]);
});

test("with one slot, a person's mention starts before board work queued earlier", async () => {
  await app.inject({ method: "PUT", url: "/api/settings", payload: { paused: true } });
  const make = (number: number, triggerKind: "board" | "agent" | "mention") => {
    fake.addIssue({ number, title: `Issue ${number}`, body: "x", user: { login: "alice" } });
    return db.createTask({
      agent: "coder", installationId: 77, owner: "acme", repo: "widgets", threadKind: "issue", threadNumber: number, threadTitle: "", threadUrl: "",
      triggerKind, requestedBy: "alice", requestText: "hi", requestUrl: "",
    });
  };
  const board = make(1, "board");
  const agent = make(2, "agent");
  const mention = make(3, "mention");
  const overview = (await app.inject({ method: "GET", url: "/api/overview" })).json();
  assert.deepEqual(overview.queued.map((task: { id: number }) => task.id), [mention.id, agent.id, board.id], "the Dashboard shows the order they'll start in");
  await app.inject({ method: "PUT", url: "/api/settings", payload: { paused: false } });
  const done = await Promise.all([board, agent, mention].map((task) => h.waitForTask(task.id)));
  const started = done.map((task) => Date.parse(task.startedAt!));
  assert.ok(started[2]! < started[1]! && started[1]! < started[0]!, `mention, then agent, then board: ${JSON.stringify(done.map((task) => [task.id, task.startedAt]))}`);
});

test("priority: high goes first and low last; a low task goes ahead after twice the aging time", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  const tasks = [
    { id: 1, triggerKind: "mention" as const, createdAt: at(5), priority: "low" as const },
    { id: 2, triggerKind: "board" as const, createdAt: at(4), priority: "normal" as const },
    { id: 3, triggerKind: "board" as const, createdAt: at(3), priority: "high" as const },
    { id: 4, triggerKind: "mention" as const, createdAt: at(2), priority: "normal" as const },
    { id: 5, triggerKind: "mention" as const, createdAt: at(45), priority: "low" as const },
    { id: 6, triggerKind: "mention" as const, createdAt: at(70), priority: "low" as const },
  ];
  assert.deepEqual(queueOrder(tasks, now).map((task) => task.id), [3, 6, 4, 2, 1, 5]);

  assert.equal(priorityFromLabels([{ name: "bug" }, { name: "Urgent" }]), "high");
  assert.equal(priorityFromLabels(["priority:low"]), "low");
  assert.equal(priorityFromLabels([{ name: "priority:low" }, { name: "P0" }]), "high", "high wins when both are set");
  assert.equal(priorityFromLabels([{ name: "bug" }]), "normal");
  assert.equal(priorityFromLabels(undefined), "normal");
});

test("fairness: among equals, whoever has the least running and waiting goes next", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  const task = (id: number, requestedBy: string, extra: { repo?: string; priority?: "high" } = {}) => ({
    id, triggerKind: "mention" as const, createdAt: new Date(now - 60_000).toISOString(), owner: "acme", repo: "widgets", requestedBy, ...extra,
  });
  const tasks = [task(1, "alice"), task(2, "alice"), task(3, "alice"), task(4, "bob"), task(5, "carol"), task(6, "Bob")];
  const order = (running: { owner: string; repo: string; requestedBy: string }[] = []) => queueOrder(tasks, now, running).map((entry) => entry.id);
  assert.deepEqual(order(), [1, 4, 5, 2, 6, 3], "one each, then the second of each, then alice's third");
  assert.deepEqual(order([{ owner: "acme", repo: "widgets", requestedBy: "alice" }]), [4, 5, 1, 6, 2, 3], "alice already has one running, so the others go first");
  assert.deepEqual(order([{ owner: "acme", repo: "gadgets", requestedBy: "alice" }]), [1, 4, 5, 2, 6, 3], "what she has running in another repository doesn't count here");
  const served = [{ owner: "acme", repo: "widgets", requestedBy: "Alice", startedAt: new Date(now - 30_000).toISOString() }];
  assert.deepEqual(queueOrder(tasks, now, [], served).map((entry) => entry.id), [4, 5, 1, 6, 2, 3], "nothing of hers runs now, but she had the last turn: with one slot people still alternate");
  assert.deepEqual(queueOrder([...tasks, task(7, "alice", { priority: "high" })], now).map((entry) => entry.id), [7, 1, 4, 5, 2, 6, 3], "an urgent task doesn't wait its turn");
  config.queueFairness = false;
  try {
    assert.deepEqual(order([{ owner: "acme", repo: "widgets", requestedBy: "alice" }]), [1, 2, 3, 4, 5, 6], "QUEUE_FAIRNESS=off: oldest first");
  } finally {
    config.queueFairness = true;
  }
});

test("an urgent label puts a task first; relabelling and the admin UI move tasks that are still waiting", async () => {
  await pause(true);
  const issue = (number: number, labels: string[] = []) => ({ number, title: `Issue ${number}`, html_url: `${fake.url}/acme/widgets/issues/${number}`, node_id: `I_${number}`, labels: labels.map((name) => ({ name })) });
  const alice = { login: "alice", type: "User" };
  const plain = await h.mentionOnNewIssue(20, "aorch-coder", "first in");
  assert.equal(plain.priority, "normal");

  fake.addIssue({ number: 21, title: "Issue 21", body: "@aorch-coder production is down", user: { login: "alice" }, labels: ["Urgent"] });
  const opened = await h.sendWebhook("issues", { action: "opened", sender: alice, issue: { ...issue(21, ["Urgent"]), body: "@aorch-coder production is down" } });
  assert.equal(opened.decision, "triggered", opened.detail);
  const urgent = db.listTasks({ limit: 1 })[0]!;
  assert.equal(urgent.priority, "high", "the label made it urgent");
  const third = await h.mentionOnNewIssue(22, "aorch-coder", "third in");
  assert.deepEqual(await overview(), [urgent.id, plain.id, third.id]);

  // The task page says where a task stands and why.
  assert.deepEqual((await page(urgent.id)).queue?.ahead, 0);
  assert.match((await page(urgent.id)).queue!.why, /high priority/);
  const second = await page(plain.id);
  assert.equal(second.queue?.ahead, 1);
  assert.match(second.queue!.why, /People's own requests start before/);

  // A priority label added later moves what's waiting; taking it off moves it back.
  await h.sendWebhook("issues", { action: "labeled", sender: alice, label: { name: "priority:low" }, issue: issue(20, ["priority:low"]) });
  assert.equal(db.getTask(plain.id)!.priority, "low");
  assert.deepEqual(await overview(), [urgent.id, third.id, plain.id]);
  assert.ok((await page(plain.id)).events.some((event) => event.message === "Priority is now low: @alice added the label priority:low"));
  assert.match((await page(plain.id)).queue!.why, /low priority/);
  await h.sendWebhook("issues", { action: "unlabeled", sender: alice, label: { name: "priority:low" }, issue: issue(20) });
  assert.equal(db.getTask(plain.id)!.priority, "normal");
  assert.deepEqual(await overview(), [urgent.id, plain.id, third.id]);

  // The admin UI sets it too.
  assert.equal((await setPriority(third.id, "urgent")).statusCode, 400);
  assert.equal((await setPriority(999_999, "high")).statusCode, 404);
  const finished = db.listTasks({ status: "succeeded", limit: 1 })[0]!;
  assert.equal((await setPriority(finished.id, "high")).statusCode, 409, "only a waiting task can be moved");
  const moved = await setPriority(third.id, "high");
  assert.equal(moved.statusCode, 200, moved.body);
  assert.equal(moved.json().priority, "high");
  assert.deepEqual(await overview(), [urgent.id, third.id, plain.id]);
  assert.ok((await page(third.id)).events.some((event) => event.message === "Priority set to high by @dev in the admin UI"));
  // Another label doesn't undo what was set by hand.
  await h.sendWebhook("issues", { action: "labeled", sender: alice, label: { name: "bug" }, issue: issue(22, ["bug"]) });
  assert.equal(db.getTask(third.id)!.priority, "high");

  // A further request folded into a waiting task raises it when the thread is urgent by then.
  const again = await h.sendWebhook("issue_comment", {
    action: "created", sender: alice, issue: issue(20, ["p0"]),
    comment: { body: "@aorch-coder this can't wait any more", html_url: `${fake.url}/c/again`, node_id: "IC" },
  });
  assert.match(again.detail, new RegExp(`added to task #${plain.id}`));
  assert.equal(db.getTask(plain.id)!.priority, "high");
  assert.equal((await setPriority(plain.id, "low")).statusCode, 200);

  // A run from the admin UI takes a priority.
  fake.addIssue({ number: 23, title: "Issue 23", body: "x", user: { login: "alice" } });
  const run = await app.inject({ method: "POST", url: "/api/tasks", payload: { agent: "coder", repo: "acme/widgets", number: 23, kind: "issue", instruction: "have a look", priority: "high" } });
  assert.equal(run.statusCode, 200, run.body);
  const manual = db.listTasks({ limit: 1 })[0]!;
  assert.equal(manual.priority, "high");
  // Someone else asked for it (the admin) who hasn't had a turn yet, so it goes before alice's.
  assert.deepEqual(await overview(), [manual.id, urgent.id, third.id, plain.id]);

  await pause(false);
  const done = await Promise.all([manual, urgent, third, plain].map((task) => h.waitForTask(task.id)));
  const started = done.map((task) => Date.parse(task.startedAt!));
  assert.deepEqual([...started].sort((a, b) => a - b), started, `they started in that order: ${JSON.stringify(done.map((task) => [task.id, task.startedAt]))}`);
  assert.equal((await page(urgent.id)).queue, null, "a finished task has no place in the queue");
});

test("MAX_RUNNING_PER_REPO: one repository doesn't take every slot", async () => {
  const guards = (await app.inject({ method: "GET", url: "/api/guards" })).json().global as { setting: string; value: string }[];
  assert.ok(guards.some((row) => row.setting === "MAX_RUNNING_PER_REPO"), "listed under Settings → Loop guards");
  await app.inject({ method: "PUT", url: "/api/settings", payload: { maxConcurrent: 3 } });
  model.script = async () => {
    await new Promise((r) => setTimeout(r, 1500));
    return [{ type: "text", text: "Done." }];
  };
  const overlap = async (first: number) => {
    await pause(true);
    const tasks = [await h.mentionOnNewIssue(first, "aorch-coder", "one"), await h.mentionOnNewIssue(first + 1, "aorch-coder", "two")];
    await pause(false);
    const [one, two] = await Promise.all(tasks.map((task) => h.waitForTask(task.id)));
    return Date.parse(two!.startedAt!) < Date.parse(one!.finishedAt!);
  };
  try {
    assert.equal(await overlap(30), true, "with three slots, two tasks in a repository run side by side");
    config.maxRunningPerRepo = 1;
    assert.equal(await overlap(40), false, "with a limit of one per repository, the second waits for the first");
  } finally {
    config.maxRunningPerRepo = 0;
    model.script = () => [{ type: "text", text: "Done." }];
    await app.inject({ method: "PUT", url: "/api/settings", payload: { maxConcurrent: 1 } });
  }
});
