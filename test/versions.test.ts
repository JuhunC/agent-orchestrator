import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { startHarness } from "./harness.ts";

const agentMd = (prompt: string) => `---\nhandle: aorch-coder\ndescription: coder\nlive: false\ngithub:\n  push: false\n  pull_request: false\n  finalize: false\n---\n${prompt}\n`;
const h = await startHarness({ "agents/coder/agent.md": agentMd("You are coder.") });
after(() => h.stop());
const { app, model } = h;
model.script = () => [{ type: "text", text: "Done." }];

test("each task records its profile version, and outcomes are shown per version", async () => {
  const first = await h.waitForTask((await h.mentionOnNewIssue(1, "aorch-coder", "one")).id);
  const again = await h.waitForTask((await h.mentionOnNewIssue(2, "aorch-coder", "two")).id);
  assert.match(first.profileVersion ?? "", /^[0-9a-f]{10}$/);
  assert.equal(again.profileVersion, first.profileVersion, "same profile, same version");

  writeFileSync(join(h.profilesDir, "agents/coder/agent.md"), agentMd("You are coder. Always run the tests before you push."));
  const changed = await h.waitForTask((await h.mentionOnNewIssue(3, "aorch-coder", "three")).id);
  assert.notEqual(changed.profileVersion, first.profileVersion, "a prompt change is a new version");

  const report = (await app.inject({ method: "GET", url: "/api/outcomes?days=7&agent=coder" })).json();
  assert.deepEqual(
    report.versions.map((row: { version: string; tasks: { succeeded: number } }) => [row.version, row.tasks.succeeded]),
    [
      [changed.profileVersion, 1],
      [first.profileVersion, 2],
    ],
    "newest first",
  );
  assert.equal(report.versions[0].successRate, 1);
  assert.equal((await app.inject({ method: "GET", url: "/api/outcomes?days=7" })).json().versions, undefined, "only for one agent");
});
