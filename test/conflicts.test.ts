import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { ModelRequest } from "./fake-model.ts";
import { startHarness } from "./harness.ts";

const agent = (name: string, github = "") => `---\nhandle: aorch-${name}\ndescription: ${name}\nlive: false\n${github}---\nYou are ${name}.\n`;
const h = await startHarness({
  "agents/coder/agent.md": agent("coder"),
  "agents/fixer/agent.md": agent("fixer"),
  "agents/reader/agent.md": agent("reader", "github:\n  push: false\n  pull_request: false\n  finalize: false\n"),
});
after(() => h.stop());
const { app, db, fake, model } = h;
const { config } = await import("../src/config.ts");
const { checkConflictsInto } = await import("../src/runner/outcomes.ts");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
model.script = async (request: ModelRequest) => {
  if (request.prompt.includes("conflicts with")) return [{ type: "text", text: "Merged the base in and resolved the conflict." }];
  const name = request.prompt.match(/WRITE (\w+)/)?.[1];
  if (name) {
    const steps = [
      { type: "tool_use" as const, id: "", name: "Bash", input: { command: `echo ${name} > ${name}.txt`, description: "write" } },
      { type: "tool_use" as const, id: "", name: "mcp__github__commit_and_push", input: { message: `Add ${name}` } },
      { type: "tool_use" as const, id: "", name: "mcp__github__open_pull_request", input: { title: name, body: name } },
      { type: "text" as const, text: "Done." },
    ];
    return [steps[Math.min(request.step, steps.length - 1)]!];
  }
  await sleep(1500);
  return [{ type: "text", text: "Looked at it." }];
};

const start = (agentName: string, number: number, kind: "issue" | "pull" = "issue") =>
  db.createTask({ agent: agentName, installationId: 77, owner: "acme", repo: "widgets", threadKind: kind, threadNumber: number, threadTitle: "", threadUrl: "", triggerKind: "mention", requestedBy: "alice", requestText: "SLOW look at this", requestUrl: "" });
const page = async (id: number) =>
  (await app.inject({ method: "GET", url: `/api/tasks/${id}` })).json() as { events: { message: string }[]; queue: { ahead: number; behind: { id: number; agent: string } | null } | null };
const overview = async () => (await app.inject({ method: "GET", url: "/api/overview" })).json() as { queued: { id: number }[]; behind: Record<string, { id: number; agent: string }> };
/** Did `second` start only after `first` had finished? */
const after_ = (first: { finishedAt: string | null }, second: { startedAt: string | null }) => Date.parse(second.startedAt!) >= Date.parse(first.finishedAt!);

test("agents that push take turns on a thread; one that only reads runs alongside", async () => {
  await app.inject({ method: "PUT", url: "/api/settings", payload: { maxConcurrent: 3 } });
  const guards = (await app.inject({ method: "GET", url: "/api/guards" })).json() as { global: { setting: string; value: string }[] };
  assert.equal(guards.global.find((row) => row.setting === "ONE_WRITER_PER_THREAD")?.value, "on");
  assert.equal(guards.global.find((row) => row.setting === "CONFLICT_CHECK_SECONDS")?.value, "60 s");

  fake.addIssue({ number: 1, title: "Issue 1", body: "x", user: { login: "alice" } });
  const coder = start("coder", 1);
  const fixer = start("fixer", 1);
  const reader = start("reader", 1);
  h.scheduler.kick();

  // The second writer waits, and the admin UI says for whom.
  const seen = await overview();
  assert.deepEqual(seen.queued.map((task) => task.id), [fixer.id], "coder and the reader started; fixer waits");
  assert.deepEqual(seen.behind[fixer.id], { id: coder.id, agent: "coder" });
  const waiting = await page(fixer.id);
  assert.deepEqual(waiting.queue?.behind, { id: coder.id, agent: "coder" });
  assert.ok(waiting.events.some((event) => event.message.startsWith(`Waiting for coder (task #${coder.id}) to finish on this thread`)), JSON.stringify(waiting.events));

  const [first, second, read] = [await h.waitForTask(coder.id), await h.waitForTask(fixer.id), await h.waitForTask(reader.id)];
  for (const task of [first, second, read]) assert.equal(task.status, "succeeded", task.error ?? "");
  assert.ok(after_(first, second), "fixer started when coder had finished");
  assert.ok(Date.parse(read.startedAt!) < Date.parse(first.finishedAt!), "the reader ran alongside coder");
  assert.equal((await page(fixer.id)).events.filter((event) => event.message.startsWith("Waiting for coder")).length, 1, "said once");
});

let pull = 0;
test("an issue and its pull request are one piece of work: a writer on either waits for a writer on the other", async () => {
  const opened = await h.waitForTask((await h.mentionOnNewIssue(2, "aorch-coder", "WRITE two")).id);
  assert.ok(opened.prNumber, opened.error ?? "opened a pull request");
  pull = opened.prNumber!;

  const onIssue = start("coder", 2);
  h.scheduler.kick();
  const onPull = start("fixer", pull, "pull");
  h.scheduler.kick();
  const waiting = await page(onPull.id);
  assert.deepEqual(waiting.queue?.behind, { id: onIssue.id, agent: "coder" });
  assert.ok(waiting.events.some((event) => event.message.startsWith(`Waiting for coder (task #${onIssue.id}) to finish on issue #2`)), JSON.stringify(waiting.events));
  const [first, second] = [await h.waitForTask(onIssue.id), await h.waitForTask(onPull.id)];
  assert.equal(second.status, "succeeded", second.error ?? "");
  assert.ok(after_(first, second), "the pull request's agent started when the issue's had finished");
});

test("ONE_WRITER_PER_THREAD=off: writers on one thread run side by side", async () => {
  config.oneWriterPerThread = false;
  try {
    // (Pull requests take the next free number: keep clear of them.)
    fake.addIssue({ number: 30, title: "Issue 30", body: "x", user: { login: "alice" } });
    const coder = start("coder", 30);
    const fixer = start("fixer", 30);
    h.scheduler.kick();
    assert.deepEqual((await overview()).queued, [], "both started");
    const [first, second] = [await h.waitForTask(coder.id), await h.waitForTask(fixer.id)];
    assert.ok(Date.parse(second.startedAt!) < Date.parse(first.finishedAt!), "side by side");
  } finally {
    config.oneWriterPerThread = true;
  }
});

test("after a merge, agents' pull requests into the same branch are checked, and one that conflicts gets its agent to merge the base in", async () => {
  const other = await h.waitForTask((await h.mentionOnNewIssue(40, "aorch-coder", "WRITE four")).id);
  assert.ok(other.prNumber, other.error ?? "opened a pull request");
  const dirty = fake.issues.get(other.prNumber!)!.pull!;
  dirty.mergeableState = "dirty";
  const maintenance = () => db.listTasks({ limit: 20 }).filter((task) => task.triggerKind === "maintenance");

  // Someone's own pull request is merged into main: no need to wait for the hourly check.
  config.conflictCheckSeconds = 1;
  try {
    await h.sendWebhook("pull_request", { action: "closed", sender: { login: "alice", type: "User" }, pull_request: { number: 50, merged: true, merged_at: new Date().toISOString(), title: "x", html_url: "x", node_id: "PR_50", base: { ref: "main" }, head: { ref: "feature" } } });
    for (let i = 0; i < 100 && !maintenance().length; i++) await sleep(50);
  } finally {
    config.conflictCheckSeconds = 60;
  }
  const [fix] = maintenance();
  assert.ok(fix, "the conflicting pull request's agent was started");
  assert.equal(fix.agent, "coder");
  assert.equal(`${fix.threadKind}#${fix.threadNumber}`, `pull#${other.prNumber}`);
  assert.match(fix.requestText, /conflicts with `main`\. Merge the base into this branch/);
  assert.equal(maintenance().length, 1, "the pull request that still merges was left alone");
  assert.equal((await h.waitForTask(fix.id)).status, "succeeded");

  // The same conflict isn't raised again that day, and a merge into another branch doesn't concern it.
  assert.equal(await checkConflictsInto("acme", "widgets", "main"), 0);
  assert.equal(await checkConflictsInto("acme", "widgets", "release"), 0);

  // The branch changed since (the conflict was dealt with) and it conflicts again: a new conflict,
  // raised again, but not within half an hour.
  const real = fake.branchSha;
  fake.branchSha = (branch) => (branch === dirty.head ? "feedface" : real(branch));
  try {
    assert.equal(await checkConflictsInto("acme", "widgets", "main"), 0, "not within half an hour");
    const key = `conflict_nudged:acme/widgets#${other.prNumber}`;
    const last = JSON.parse(db.getSetting(key)!) as { at: number; count: number };
    db.setSetting(key, JSON.stringify({ ...last, at: Date.now() - 31 * 60_000 }));
    assert.equal(await checkConflictsInto("acme", "widgets", "main"), 1);
    assert.equal((JSON.parse(db.getSetting(key)!) as { count: number }).count, 2);
    const again = maintenance().find((task) => task.id !== fix.id)!;
    assert.equal(again.threadNumber, other.prNumber);
    await h.waitForTask(again.id);
  } finally {
    fake.branchSha = real;
  }

  // GitHub hasn't worked out yet whether a pull request still merges: asked once more.
  const unknown = fake.issues.get(pull)!.pull!;
  unknown.mergeableState = "unknown";
  setTimeout(() => (unknown.mergeableState = "dirty"), 100);
  assert.equal(await checkConflictsInto("acme", "widgets", "main", undefined, 600), 1);
  const third = maintenance().find((task) => task.threadNumber === pull)!;
  assert.equal(third.agent, "coder");
  await h.waitForTask(third.id);
});
