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
