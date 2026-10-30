import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { ModelRequest } from "./fake-model.ts";
import { startHarness } from "./harness.ts";

const h = await startHarness({ "agents/coder/agent.md": "---\nhandle: aorch-coder\ndescription: coder\nlive: false\n---\nYou are coder.\n" }, { MAX_OPEN_AGENT_PRS_PER_REPO: "1" });
after(() => h.stop());
const { app, db, fake, model } = h;
model.script = (request: ModelRequest) => {
  if (request.prompt.includes("conflicts with")) return [{ type: "text", text: "Merged main in and resolved the conflict." }];
  const name = request.prompt.match(/WRITE (\w+)/)?.[1] ?? "x";
  const steps = [
    { type: "tool_use" as const, id: "", name: "Bash", input: { command: `echo ${name} > ${name}.txt`, description: "write" } },
    { type: "tool_use" as const, id: "", name: "mcp__github__commit_and_push", input: { message: `Add ${name}` } },
    { type: "tool_use" as const, id: "", name: "mcp__github__open_pull_request", input: { title: name, body: name } },
    { type: "text" as const, text: "Done." },
  ];
  return [steps[Math.min(request.step, steps.length - 1)]!];
};
const { checkOpenPulls } = await import("../src/runner/outcomes.ts");
const boardTask = (number: number) => {
  fake.addIssue({ number, title: `Issue ${number}`, body: "x", user: { login: "alice" } });
  return db.createTask({ agent: "coder", installationId: 77, owner: "acme", repo: "widgets", threadKind: "issue", threadNumber: number, threadTitle: "", threadUrl: "", triggerKind: "board", requestedBy: "project board", requestText: "WRITE two", requestUrl: "" });
};

test("with too many open agent pull requests, board work that would open another waits; people's requests don't", async () => {
  const first = await h.waitForTask((await h.mentionOnNewIssue(1, "aorch-coder", "WRITE one")).id);
  assert.ok(first.prNumber, first.error ?? "opened a pull request");

  const held = boardTask(2);
  h.scheduler.kick();
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(db.getTask(held.id)!.status, "queued", "the repository already has 1 open agent pull request");
  const incidents = (await app.inject({ method: "GET", url: "/api/incidents" })).json() as { message: string }[];
  assert.ok(incidents.some((incident) => /has 1 open agent pull requests \(MAX_OPEN_AGENT_PRS_PER_REPO is 1\)/.test(incident.message)));

  // A person's own request still runs (here: the same agent mentioned on a new issue).
  const asked = await h.waitForTask((await h.mentionOnNewIssue(3, "aorch-coder", "WRITE three")).id);
  assert.equal(asked.status, "succeeded", asked.error ?? "");

  // Merging the pull requests lets the held work start.
  for (const number of [first.prNumber!, asked.prNumber!]) {
    fake.issues.get(number)!.state = "closed";
    await h.sendWebhook("pull_request", { action: "closed", sender: { login: "alice", type: "User" }, pull_request: { number, merged: true, merged_at: new Date().toISOString(), title: "x", html_url: "x", node_id: `PR_${number}`, base: { ref: "main" }, head: { ref: "x" } } });
  }
  const done = await h.waitForTask(held.id);
  assert.equal(done.status, "succeeded", done.error ?? "");
});

test("an agent's pull request that conflicts with its base gets that agent to merge the base in, once a day", async () => {
  const pr = db.listTasks({ limit: 10 }).find((task) => task.threadNumber === 2)!.prNumber!; // still open
  fake.issues.get(pr)!.pull!.mergeableState = "dirty";
  await checkOpenPulls(new Date(Date.now() + 60_000));
  const fix = db.listTasks({ limit: 1 })[0]!;
  assert.equal(fix.triggerKind, "maintenance");
  assert.equal(fix.threadKind, "pull");
  assert.equal(fix.threadNumber, pr);
  assert.match(fix.requestText, /conflicts with `main`\. Merge the base into this branch/);
  const finished = await h.waitForTask(fix.id);
  assert.equal(finished.status, "succeeded", finished.error ?? "");
  await checkOpenPulls(new Date(Date.now() + 60_000));
  assert.equal(db.listTasks({ limit: 1 })[0]!.id, fix.id, "not again the same day");
});
