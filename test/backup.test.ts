import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { startHarness } from "./harness.ts";

const h = await startHarness({ "agents/coder/agent.md": "---\nhandle: aorch-coder\ndescription: coder\n---\nYou are coder.\n" }, { BACKUP_KEEP: "2" });
after(() => h.stop());
const { app, db } = h;

test("backups hold a consistent copy of the database and the key files, the newest few kept", async () => {
  db.setSetting("backup-test", "before");
  const first = await app.inject({ method: "POST", url: "/api/backups" });
  assert.equal(first.statusCode, 200, first.body);
  const listed = (await app.inject({ method: "GET", url: "/api/backups" })).json();
  assert.equal(listed.keep, 2);
  assert.equal(listed.backups.length, 1);
  assert.ok(listed.backups[0].files.includes("orchestrator.db"));
  assert.ok(listed.backups[0].files.includes("admin-token"), "the key files that exist");
  assert.equal(listed.backups[0].path, undefined, "the server's paths stay on the server");

  const copy = new DatabaseSync(join(listed.dir, listed.backups[0].name, "orchestrator.db"));
  assert.equal((copy.prepare("SELECT value FROM settings WHERE key = 'backup-test'").get() as { value: string }).value, "before");
  copy.close();

  for (let i = 0; i < 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1100)); // names are per second
    assert.equal((await app.inject({ method: "POST", url: "/api/backups" })).statusCode, 200);
  }
  const kept = (await app.inject({ method: "GET", url: "/api/backups" })).json().backups as { name: string }[];
  assert.equal(kept.length, 2, "BACKUP_KEEP=2");
  assert.ok(!kept.some((backup) => backup.name === listed.backups[0].name), "the oldest went");
  assert.ok(existsSync(join(listed.dir, kept[0]!.name, "orchestrator.db")));
});

test("old tasks lose their prompts and step logs after the retention period; the tasks stay", async () => {
  const make = (finishedAt: string) => {
    const task = db.createTask({ agent: "coder", installationId: 77, owner: "acme", repo: "widgets", threadKind: "issue", threadNumber: 9, threadTitle: "", threadUrl: "", triggerKind: "mention", requestedBy: "alice", requestText: "hi", requestUrl: "" });
    db.updateTask(task.id, { status: "succeeded", finishedAt, prompt: "a long prompt", resultText: "Done.", costUsd: 1.5 });
    db.addEvent(task.id, "tool", "Ran tests");
    return task.id;
  };
  const old = make(new Date(Date.now() - 100 * 86_400_000).toISOString());
  const recent = make(new Date().toISOString());
  const { pruneOldDetail } = await import("../src/runtime/backup.ts");
  assert.deepEqual(pruneOldDetail(Date.now(), 90), { tasks: 1, events: 1 });
  assert.equal(db.getTask(old)!.prompt, null);
  assert.equal(db.getTask(old)!.resultText, "Done.", "the reply stays");
  assert.equal(db.getTask(old)!.costUsd, 1.5, "and the cost");
  assert.equal(db.listEvents(old, 0).length, 0);
  assert.equal(db.getTask(recent)!.prompt, "a long prompt");
  assert.equal(db.listEvents(recent, 0).length, 1);

  // The time-range queries (spending, usage, outcomes) use the index.
  const plan = db.db.prepare("EXPLAIN QUERY PLAN SELECT COALESCE(SUM(cost_usd), 0) FROM tasks WHERE COALESCE(finished_at, started_at, created_at) >= ?").all("2026-01-01") as { detail: string }[];
  assert.match(plan.map((row) => row.detail).join(" "), /tasks_ended/);
  const sized = (await app.inject({ method: "GET", url: "/api/backups" })).json();
  assert.ok(sized.database.kb > 0);
  assert.equal(sized.detailRetentionDays, 90);
});
