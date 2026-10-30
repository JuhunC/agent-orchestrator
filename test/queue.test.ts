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
const { queueOrder } = await import("../src/runner/queue-order.ts");

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
