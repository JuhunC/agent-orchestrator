import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { startHarness } from "./harness.ts";

const h = await startHarness({
  "agents/coder/agent.md": "---\nhandle: aorch-coder\ndescription: coder\nlive: false\ngithub:\n  push: false\n  pull_request: false\n  finalize: false\n---\nYou are coder.\n",
});
after(() => h.stop());
const { app, model } = h;
model.script = () => [{ type: "text", text: "Done." }];
const { cleanUpWorkspaces } = await import("../src/runtime/cleanup.ts");
const { workspaceDir } = await import("../src/runtime/workspace.ts");
const dir = (number: number) => workspaceDir({ owner: "acme", repo: "widgets", agent: "coder", threadKind: "issue", threadNumber: number });

test("unused checkouts are removed after the retention period, unless they hold unpublished work", async () => {
  for (const number of [1, 2]) await h.waitForTask((await h.mentionOnNewIssue(number, "aorch-coder", "hi")).id);
  assert.ok(existsSync(dir(1)) && existsSync(dir(2)));
  writeFileSync(join(dir(2), "notes.txt"), "not committed\n");

  const soon = await cleanUpWorkspaces({ days: 14 });
  assert.equal(soon.removed.length, 0, "used today: kept");
  assert.equal(soon.remaining, 2);

  const later = await cleanUpWorkspaces({ days: 14, now: Date.now() + 15 * 86_400_000 });
  assert.deepEqual(later.removed.map((entry) => entry.path), ["acme/widgets/coder/issue-1"]);
  assert.equal(later.removed[0]!.idleDays, 15);
  assert.deepEqual(later.kept, [{ path: "acme/widgets/coder/issue-2", reason: "it has uncommitted changes" }]);
  assert.ok(!existsSync(dir(1)));
  assert.ok(existsSync(dir(2)));
  assert.equal(later.remaining, 1);

  const shown = (await app.inject({ method: "GET", url: "/api/settings" })).json().workspaces;
  assert.equal(shown.retentionDays, 14);
  assert.equal(shown.lastCleanup.removed.length, 1);

  // The next task on the cleaned-up thread clones it again.
  const again = await h.waitForTask((await h.commentMention(1, "@aorch-coder again")).id);
  assert.equal(again.status, "succeeded", again.error ?? "");
  assert.ok(existsSync(dir(1)));
});
