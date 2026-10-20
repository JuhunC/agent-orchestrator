import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { resolve } from "node:path";
import { after, test } from "node:test";
import type { ModelRequest } from "./fake-model.ts";
import { startHarness } from "./harness.ts";

const docsServer = resolve("test/fixtures/docs-mcp.mjs");
chmodSync(docsServer, 0o755);

const h = await startHarness(
  {
    "agents/coder/agent.md": `---
handle: aorch-coder
description: Builds things
skills: [shipping-changes]
mcp: [docs]
subagents: [test-writer]
max_turns: 30
---
You are the test coder. Always be careful.
`,
    "agents/coder/skills/house-style/SKILL.md": `---
name: house-style
description: The team's house style
---
Use tabs.
`,
    "agents/reviewer/agent.md": `---
handle: aorch-reviewer
description: Reviews
tools:
  deny: [Edit, Write]
github:
  push: false
  pull_request: false
  finalize: false
---
You review code.
`,
    "agents/limited/agent.md": `---
handle: aorch-limited
description: Hits usage limits
env:
  CLAUDE_CODE_MAX_RETRIES: "0"
---
You are limited.
`,
    "library/skills/shipping-changes/SKILL.md": `---
name: shipping-changes
description: How to ship changes with the github tools
---
Push with commit_and_push.
`,
    "library/roles/test-writer.md": `---
description: Writes tests
tools: [Read, Write, Bash]
---
You write tests.
`,
    "library/mcp.json": JSON.stringify({ mcpServers: { docs: { command: process.execPath, args: [docsServer], env: { DOCS_TOKEN: "${DOCS_TOKEN}" }, alwaysLoad: true } } }),
  },
  { DOCS_TOKEN: "docs-secret-value" },
);
after(() => h.stop());
const { db, app, fake, model, waitForTask } = h;

type Step = { tool: string; input: Record<string, unknown> } | { text: string };
/** Plays `steps` in order for each task prompt that matches `match`. */
function play(steps: Step[], match = (_: ModelRequest) => true) {
  const previous = model.script;
  model.script = (request) => {
    if (!match(request)) return previous(request);
    const step = steps[Math.min(request.step, steps.length - 1)]!;
    return "tool" in step ? [{ type: "tool_use", id: "", name: step.tool, input: step.input }] : [{ type: "text", text: step.text }];
  };
}
const requestsFor = (needle: string) => model.agentRequests().filter((request) => request.prompt.includes(needle));
const bash = (command: string) => ({ tool: "Bash", input: { command, description: "run" } });

test("an agent runs the full cycle: edits, uses MCP, commits, pushes and opens a PR", async () => {
  play(
    [
      bash('echo "hello" > HELLO.md && env | sort'),
      { tool: "mcp__docs__lookup", input: { topic: "style" } },
      { tool: "mcp__github__commit_and_push", input: { message: "Add HELLO.md" } },
      { tool: "mcp__github__open_pull_request", input: { title: "Add a greeting", body: "Adds HELLO.md." } },
      { text: "Added HELLO.md and opened a pull request." },
    ],
    (request) => request.prompt.includes("please add a greeting"),
  );
  const task = await waitForTask((await h.mentionOnNewIssue(1, "aorch-coder", "please add a greeting")).id);
  assert.equal(task.status, "succeeded", task.error ?? "");
  assert.equal(task.resultText, "Added HELLO.md and opened a pull request.");
  assert.equal(task.branch, "agent/coder/issue-1");
  assert.equal(task.prNumber, 2);
  assert.equal(task.live, true);
  assert.ok(task.sessionId);

  assert.equal(h.showRemote("agent/coder/issue-1:HELLO.md"), "hello");
  const pr = fake.issues.get(2)!;
  assert.equal(pr.pull?.head, "agent/coder/issue-1");
  assert.match(pr.body, /Adds HELLO\.md\.\n\nCloses #1/);

  const requests = requestsFor("please add a greeting");
  const body = JSON.stringify(requests[0]!.body);
  assert.match(body, /You are the test coder\. Always be careful\./, "role prompt is in the system prompt");
  assert.match(body, /shipping-changes/, "library skill is offered");
  assert.match(body, /house-style/, "the agent's own skill is offered");
  assert.match(body, /test-writer/, "subagent is offered");
  assert.match(body, /mcp__github__commit_and_push/);
  const toolResults = JSON.stringify(requests.at(-1)!.body.messages);
  assert.match(toolResults, /Docs for style: use tabs, not spaces\. \(token=docs-secret-value\)/, "MCP server ran with expanded env");
  assert.match(toolResults, /Pushed 1 commit\(s\) to agent\/coder\/issue-1/);
  assert.match(toolResults, /Opened pull request #2/);
  assert.match(toolResults, /ANTHROPIC_BASE_URL=/, "the agent sees the model settings");
  const everything = JSON.stringify(model.requests.map((request) => request.body));
  assert.doesNotMatch(everything, /ghs_faketoken|whsec|BEGIN PRIVATE KEY/, "no GitHub credentials reach the agent or the model");

  const comments = fake.issues.get(1)!.comments;
  assert.match(comments[0]!.body, /✅ finished/);
  assert.match(comments[0]!.body, /Committing and pushing/);
  assert.match(comments.at(-1)!.body, /@alice \*\*coder\*\* finished ✅ · #2/);
});

test("a follow-up continues the same live session with only what's new", async () => {
  play(
    [bash("echo again >> HELLO.md"), { tool: "mcp__github__commit_and_push", input: { message: "Say hello twice" } }, { text: "Updated the PR." }],
    (request) => request.prompt.includes("one more line"),
  );
  const first = db.listTasks({ agent: "coder" })[0]!;
  const task = await waitForTask((await h.commentMention(1, "@aorch-coder one more line please")).id);
  assert.equal(task.status, "succeeded", task.error ?? "");
  assert.equal(task.sessionId, first.sessionId, "same Claude session");
  assert.match(task.prompt!, /has a new request for you/);
  assert.doesNotMatch(task.prompt!, /## Your previous work here/);
  const history = JSON.stringify(requestsFor("one more line")[0]!.body.messages);
  assert.match(history, /Added HELLO\.md and opened a pull request\./, "the session remembers the first task");
  assert.equal(h.showRemote("agent/coder/issue-1:HELLO.md"), "hello\nagain");
  assert.equal([...fake.issues.values()].filter((issue) => issue.pull).length, 1, "no second PR");
  assert.equal(h.sessions.list().length, 1);
});

test("work an agent forgot to publish is pushed and opened as a PR for it", async () => {
  play([bash("echo forgotten > NOTES.md"), { text: "Wrote NOTES.md." }], (request) => request.prompt.includes("write notes"));
  const task = await waitForTask((await h.mentionOnNewIssue(10, "aorch-coder", "write notes")).id);
  assert.equal(task.status, "succeeded", task.error ?? "");
  assert.equal(h.showRemote("agent/coder/issue-10:NOTES.md"), "forgotten");
  assert.ok(task.prNumber, "PR opened by the safety net");
  assert.ok(db.listEvents(task.id).some((event) => event.message === "Publishing changes the agent left unpushed"));
});

test("a read-only agent doesn't get push tools or edit tools", async () => {
  play([{ text: "Looks good to me." }], (request) => request.prompt.includes("review this"));
  const task = await waitForTask((await h.mentionOnNewIssue(11, "aorch-reviewer", "review this")).id);
  assert.equal(task.status, "succeeded", task.error ?? "");
  const tools = requestsFor("review this")[0]!.body.tools.map((tool: { name: string }) => tool.name);
  assert.ok(tools.includes("mcp__github__post_comment"));
  assert.ok(!tools.includes("mcp__github__commit_and_push"));
  assert.ok(!tools.includes("mcp__github__open_pull_request"));
  assert.ok(!tools.includes("Edit") && !tools.includes("Write"));
});

test("a usage limit from the model service pauses the task until it resets", async () => {
  model.script = ((previous) => (request: ModelRequest) =>
    request.prompt.includes("hit the limit")
      ? { status: 429, error: { type: "rate_limit_error", message: "You've hit your usage limit · resets in 3 minutes" } }
      : previous(request))(model.script);
  const queued = await h.mentionOnNewIssue(12, "aorch-limited", "hit the limit");
  const paused = await waitForTask(queued.id, ["queued"], (task) => Boolean(task?.retryAt));
  assert.equal(paused.attempts, 1);
  const wait = Date.parse(paused.retryAt!) - Date.now();
  assert.ok(wait > 2 * 60_000 && wait < 6 * 60_000, `waits about 3 minutes, got ${wait}ms`);
  await h.scheduler.idle();
  assert.match(fake.issues.get(12)!.comments[0]!.body, /paused until its usage limit resets/);
  const limit = (await app.inject({ method: "GET", url: "/api/model" })).json().limit;
  assert.match(limit.reason, /usage limit/);

  // Lift it from the admin UI; the next attempt succeeds.
  play([{ text: "Done after the limit." }], (request) => request.prompt.includes("hit the limit") || request.prompt.includes("interrupted by a usage limit"));
  assert.equal((await app.inject({ method: "POST", url: `/api/tasks/${queued.id}/run-now` })).statusCode, 200);
  const done = await waitForTask(queued.id);
  assert.equal(done.status, "succeeded", done.error ?? "");
  assert.equal(fake.issues.get(12)!.comments.length, 2, "same progress comment, then the result");
});

test("a model error fails the task and is reported on GitHub", async () => {
  model.script = ((previous) => (request: ModelRequest) =>
    request.prompt.includes("PLEASE_FAIL") ? { status: 400, error: { type: "invalid_request_error", message: "prompt is not allowed here" } } : previous(request))(model.script);
  const task = await waitForTask((await h.mentionOnNewIssue(13, "aorch-limited", "PLEASE_FAIL")).id);
  assert.equal(task.status, "failed");
  assert.match(fake.issues.get(13)!.comments.at(-1)!.body, /couldn't finish ❌/);
});

test("a running agent can be stopped from the admin API", async () => {
  play([bash("sleep 30"), { text: "never" }], (request) => request.prompt.includes("take forever"));
  const queued = await h.mentionOnNewIssue(14, "aorch-coder", "take forever");
  for (let i = 0; i < 200 && !db.listEvents(queued.id).some((event) => event.message.startsWith("Ran `sleep 30`")); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal((await app.inject({ method: "POST", url: `/api/tasks/${queued.id}/cancel` })).statusCode, 200);
  const task = await waitForTask(queued.id);
  assert.equal(task.status, "cancelled");
  assert.match(fake.issues.get(14)!.comments[0]!.body, /was cancelled/);
});

test("only people with write access can start agents, and bots are ignored", async () => {
  fake.permissions.set("mallory", "read");
  const rejected = await h.sendWebhook("issue_comment", {
    action: "created",
    sender: { login: "mallory", type: "User" },
    issue: { number: 1, title: "x", html_url: "x" },
    comment: { body: "@aorch-coder delete everything", html_url: "x", node_id: "IC_2" },
  });
  assert.equal(rejected.decision, "rejected");
  const bot = await h.sendWebhook("issue_comment", {
    action: "created",
    sender: { login: "test-orchestrator[bot]", type: "Bot" },
    issue: { number: 1, title: "x", html_url: "x" },
    comment: { body: "@aorch-coder hi", html_url: "x", node_id: "IC_3" },
  });
  assert.equal(bot.decision, "ignored");
});

test("the admin API lists profiles and edits profile files with validation", async () => {
  const agents = (await app.inject({ method: "GET", url: "/api/agents" })).json();
  assert.deepEqual(
    agents.agents.map((agent: { name: string }) => agent.name),
    ["coder", "limited", "reviewer"],
  );
  assert.deepEqual(agents.library.skills.map((skill: { name: string }) => skill.name), ["shipping-changes"]);

  const bad = await app.inject({ method: "PUT", url: "/api/profiles/file", payload: { path: "library/mcp.json", content: "{ not json" } });
  assert.equal(bad.statusCode, 400);
  const outside = await app.inject({ method: "PUT", url: "/api/profiles/file", payload: { path: "../escape.md", content: "x" } });
  assert.equal(outside.statusCode, 400);
  const created = await app.inject({ method: "POST", url: "/api/agents", payload: { name: "helper", handle: "aorch-helper" } });
  assert.equal(created.statusCode, 200);
  const file = (await app.inject({ method: "GET", url: "/api/profiles/file?path=agents/helper/agent.md" })).json();
  assert.match(file.content, /handle: aorch-helper/);
  assert.equal((await app.inject({ method: "DELETE", url: "/api/profiles/file?path=agents/helper/agent.md" })).statusCode, 200);
});
