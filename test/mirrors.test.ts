import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ModelRequest } from "./fake-model.ts";
import { startHarness } from "./harness.ts";

const h = await startHarness({ "agents/coder/agent.md": "---\nhandle: aorch-coder\ndescription: coder\nlive: false\ngithub:\n  pull_request: false\n---\nYou are coder.\n" });
after(() => h.stop());
const { fake, model } = h;
model.script = (request: ModelRequest) => {
  const name = request.prompt.match(/WRITE (\w+)/)?.[1] ?? "x";
  const steps = [
    { type: "tool_use" as const, id: "", name: "Bash", input: { command: `echo ${name} > ${name}.txt`, description: "write" } },
    { type: "tool_use" as const, id: "", name: "mcp__github__commit_and_push", input: { message: `Add ${name}` } },
    { type: "text" as const, text: "Done." },
  ];
  return [steps[Math.min(request.step, steps.length - 1)]!];
};
const { workspaceDir } = await import("../src/runtime/workspace.ts");
const { mirrorPath } = await import("../src/runtime/mirrors.ts");
const { cleanUpWorkspaces } = await import("../src/runtime/cleanup.ts");
const dir = (number: number) => workspaceDir({ owner: "acme", repo: "widgets", agent: "coder", threadKind: "issue", threadNumber: number });

test("checkouts borrow history from one shared copy per repository, and pushes still work", async () => {
  for (const [number, name] of [[1, "one"], [2, "two"]] as const) {
    const task = await h.waitForTask((await h.mentionOnNewIssue(number, "aorch-coder", `WRITE ${name}`)).id);
    assert.equal(task.status, "succeeded", task.error ?? "");
    assert.equal(h.showRemote(`agent/coder/issue-${number}:${name}.txt`), name);
    const alternates = readFileSync(join(dir(number), ".git", "objects", "info", "alternates"), "utf8").trim();
    assert.equal(realpathSync(alternates), realpathSync(join(mirrorPath("acme", "widgets"), "objects")));
  }
  const mirror = mirrorPath("acme", "widgets");
  assert.ok(existsSync(join(mirror, "HEAD")) && !existsSync(join(mirror, ".git")), "a bare copy");
  assert.equal(h.run(mirror, "config", "gc.auto"), "0", "never garbage-collected");
  assert.match(h.run(dir(1), "log", "--oneline", "-3"), /init/, "the checkout sees the whole history");
});

test("a closed issue's checkout goes after two days; an open one stays", async () => {
  fake.issues.get(1)!.state = "closed";
  const report = await cleanUpWorkspaces({ days: 14, closedDays: 2, now: Date.now() + 3 * 86_400_000 });
  assert.deepEqual(report.removed.map((entry) => entry.path), ["acme/widgets/coder/issue-1"]);
  assert.ok(!existsSync(dir(1)));
  assert.ok(existsSync(dir(2)));
  const again = await h.waitForTask((await h.commentMention(2, "@aorch-coder WRITE three")).id);
  assert.equal(again.status, "succeeded", again.error ?? "");
  assert.equal(h.showRemote("agent/coder/issue-2:three.txt"), "three");
});
