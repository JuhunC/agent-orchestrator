import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ModelRequest } from "./fake-model.ts";
import { startHarness } from "./harness.ts";

const agent = (handle: string, github = "") => `---\nhandle: ${handle}\ndescription: x\nlive: false\ngithub:\n  push: false\n  pull_request: false\n  finalize: false\n${github}---\nYou are ${handle}.\n`;
const h = await startHarness({
  "agents/quiet/agent.md": agent("aorch-quiet"),
  "agents/chatty/agent.md": agent("aorch-chatty", "  live_activity: true\n"),
  "agents/hush/agent.md": agent("aorch-hush", "  live_activity: false\n"),
  "agents/bare/agent.md": "---\nhandle: aorch-bare\ndescription: x\n---\nYou are bare.\n",
});
after(() => h.stop());
const { app, db, fake, model } = h;
model.script = (request: ModelRequest) => {
  if (request.prompt.includes("SLOW") && request.step === 0) return [{ type: "tool_use", id: "", name: "Bash", input: { command: "sleep 30", description: "wait" } }];
  return [{ type: "text", text: "All done." }];
};
const bodies = (number: number) => fake.issues.get(number)!.comments.map((comment) => comment.body);
type AgentView = { name: string; liveActivity: boolean; github: { liveActivity: boolean | null } };
const agents = async () => (await app.inject({ url: "/api/agents" })).json() as { agents: AgentView[]; liveActivityDefault: boolean };
const view = async (name: string) => (await agents()).agents.find((candidate) => candidate.name === name)!;

test("by default an agent only posts its result, with no live activity comment", async () => {
  assert.equal((await app.inject({ url: "/api/settings" })).json().liveActivity, false);
  const task = await h.waitForTask((await h.mentionOnNewIssue(1, "aorch-quiet")).id);
  assert.equal(task.status, "succeeded", task.error ?? "");
  assert.equal(task.progressCommentId, null);
  assert.equal(bodies(1).length, 1, bodies(1).join("\n---\n"));
  assert.match(bodies(1)[0]!, /@alice \*\*quiet\*\* finished ✅/);
  assert.doesNotMatch(bodies(1)[0]!, /agent-orchestrator:progress/);
});

test("an agent with github.live_activity: true keeps a live comment, then posts its result", async () => {
  const task = await h.waitForTask((await h.mentionOnNewIssue(2, "aorch-chatty")).id);
  assert.ok(task.progressCommentId);
  assert.equal(bodies(2).length, 2);
  assert.match(bodies(2)[0]!, /agent-orchestrator:progress[\s\S]*✅ finished/);
});

test("Settings (PUT /api/settings) turns it on for agents that don't set it; github.live_activity: false still wins", async () => {
  assert.equal((await app.inject({ method: "PUT", url: "/api/settings", payload: { liveActivity: "yes" } })).statusCode, 400);
  const put = await app.inject({ method: "PUT", url: "/api/settings", payload: { liveActivity: true } });
  assert.equal(put.json().liveActivity, true);
  assert.equal((await agents()).liveActivityDefault, true);
  const quiet = await view("quiet");
  const hush = await view("hush");
  assert.deepEqual([quiet.liveActivity, quiet.github.liveActivity], [true, null]);
  assert.deepEqual([hush.liveActivity, hush.github.liveActivity], [false, false]);

  const on = await h.waitForTask((await h.mentionOnNewIssue(3, "aorch-quiet")).id);
  assert.ok(on.progressCommentId, "the default now posts live activity");
  assert.equal(bodies(3).length, 2);
  const off = await h.waitForTask((await h.mentionOnNewIssue(4, "aorch-hush")).id);
  assert.equal(off.progressCommentId, null);
  assert.equal(bodies(4).length, 1);
  await app.inject({ method: "PUT", url: "/api/settings", payload: { liveActivity: false } });
});

test("a cancelled agent without live activity still tells the thread", async () => {
  const queued = await h.mentionOnNewIssue(5, "aorch-quiet", "SLOW");
  for (let i = 0; i < 200 && !db.listEvents(queued.id).some((event) => event.message.startsWith("Ran `sleep 30`")); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await app.inject({ method: "POST", url: `/api/tasks/${queued.id}/cancel` })).statusCode, 200);
  assert.equal((await h.waitForTask(queued.id)).status, "cancelled");
  assert.equal(bodies(5).length, 1);
  assert.match(bodies(5)[0]!, /@alice \*\*quiet\*\* couldn't finish ❌/);
});

test("PATCH /api/agents/:name sets and clears github.live_activity, leaving the rest of agent.md alone", async () => {
  const patch = (name: string, payload: Record<string, unknown>) => app.inject({ method: "PATCH", url: `/api/agents/${name}`, payload });
  const file = (name: string) => readFileSync(join(h.profilesDir, `agents/${name}/agent.md`), "utf8");
  assert.equal((await patch("quiet", { model: "claude-sonnet-5-5" })).statusCode, 200);
  assert.equal((await patch("quiet", { liveActivity: true })).statusCode, 200);
  assert.match(file("quiet"), /^model: claude-sonnet-5-5$/m, "model untouched");
  assert.match(file("quiet"), /^github:\n {2}push: false\n {2}pull_request: false\n {2}finalize: false\n {2}live_activity: true$/m);
  assert.equal((await view("quiet")).liveActivity, true);

  assert.equal((await patch("quiet", { liveActivity: "on" })).statusCode, 400);
  assert.equal((await patch("nobody", { liveActivity: true })).statusCode, 404);
  assert.equal((await patch("quiet", { liveActivity: null })).statusCode, 200);
  assert.doesNotMatch(file("quiet"), /live_activity/);
  assert.match(file("quiet"), /^ {2}finalize: false$/m);
  assert.equal((await view("quiet")).github.liveActivity, null);

  // An agent.md without a github: section gets one, and loses it again when cleared.
  assert.equal((await patch("bare", { liveActivity: false })).statusCode, 200);
  assert.match(file("bare"), /^github:\n {2}live_activity: false$/m);
  assert.equal((await patch("bare", { liveActivity: null })).statusCode, 200);
  assert.doesNotMatch(file("bare"), /github/);
  assert.equal((await view("bare")).liveActivity, false);
});

test("github.live_activity must be true or false", async () => {
  await app.inject({ method: "PUT", url: "/api/profiles/file", payload: { path: "agents/bare/agent.md", content: "---\nhandle: aorch-bare\ndescription: x\ngithub:\n  live_activity: sometimes\n---\nYou are bare.\n" } });
  const bare = (await agents()).agents.find((candidate) => candidate.name === "bare") as AgentView & { errors: string[] };
  assert.ok(bare.errors.some((error) => /github\.live_activity must be true or false/.test(error)), bare.errors.join("; "));
});
