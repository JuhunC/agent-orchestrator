import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { ModelRequest } from "./fake-model.ts";
import { startHarness } from "./harness.ts";

const agent = (name: string, description: string, github = "") =>
  `---\nhandle: aorch-${name}\ndescription: ${description}\nlive: false\ngithub:\n  push: false\n  pull_request: false\n  finalize: false\n${github}---\nYou are ${name}.\n`;
const h = await startHarness(
  {
    "agents/triage/agent.md": agent("triage", "Routes new issues"),
    "agents/backend/agent.md": agent("backend", "APIs and the database"),
    "agents/web/agent.md": agent("web", "The web front end", "  route: true\n"),
  },
  { TRIAGE_AGENT: "triage" },
);
// (A test that fails must not leave the held agent running: stopping waits for it.)
after(() => (release(), h.stop()));
const { app, db, fake, model } = h;
const { config } = await import("../src/config.ts");
const { triageAgentFor } = await import("../src/routing.ts");

const toolResults = (request: ModelRequest) =>
  (request.body.messages as { content: unknown }[])
    .flatMap((message) => (Array.isArray(message.content) ? message.content.filter((block: { type: string }) => block.type === "tool_result") : []))
    .map((block) => JSON.stringify(block));
const route = (name: string, instructions = "DO_IT carefully") => [
  { type: "tool_use" as const, id: "", name: "mcp__github__route_to_agent", input: { agent: name, reason: `REASON for ${name}`, instructions } },
];

/** Each agent's first prompt on an issue (by the issue's TAG), and what the last task's route_to_agent calls returned. */
const prompts = new Map<string, string>();
let results: string[] = [];
/** Lets the agent that's held at SLOW_WORK go on. */
let held = true;
let go = () => {};
const release = () => {
  held = false;
  go();
};
model.script = async (request: ModelRequest) => {
  const { prompt, step } = request;
  // The triage agent's prompt says "## Routing"; an agent with github.route (web) gets "## Passing this on".
  const role = prompt.includes("## Routing") ? "triage" : prompt.includes("## Passing this on") ? "web" : "backend";
  const tag = prompt.match(/TAG_\w+/)?.[0];
  if (tag && step === 0 && !prompts.has(`${role}:${tag}`)) prompts.set(`${role}:${tag}`, prompt);
  const triage = prompt.includes("## Routing") ? prompt.match(/TRIAGE_TO (\S+)/)?.[1] : undefined;
  const pass = prompt.includes("## Passing this on") ? prompt.match(/WEB_TO (\S+)/)?.[1] : undefined;
  if (prompt.includes("## Passing this on") && prompt.includes("WEB_BAD")) {
    const tries = ["nobody", "web", "aorch-triage"];
    if (step < tries.length) return route(tries[step]!);
    results = toolResults(request);
    return [{ type: "text", text: "Couldn't pass it on." }];
  }
  const target = triage ?? pass;
  if (target) {
    if (step === 0) return route(target);
    results = toolResults(request);
    return [{ type: "text", text: `${target} takes it from here.` }];
  }
  if (held && prompt.includes("SLOW_WORK")) await new Promise<void>((resolve) => (go = resolve));
  return [{ type: "text", text: "Did the work." }];
};

const settings = async () => (await app.inject({ method: "GET", url: "/api/settings" })).json() as { routing: { agent: string | null; repos: string[]; problem: string | null } };
const setRouting = (routing: unknown) => app.inject({ method: "PUT", url: "/api/settings", payload: { routing } });
const events = async (id: number) => ((await app.inject({ method: "GET", url: `/api/tasks/${id}` })).json() as { events: { message: string }[] }).events.map((event) => event.message);
const tasksOn = (number: number) => db.listTasks({ limit: 100 }).filter((task) => task.threadNumber === number);
const opened = (number: number, body: string, extra: Record<string, unknown> = {}, sender = "alice") => {
  fake.addIssue({ number, title: `Issue ${number}`, body, user: { login: sender } });
  return h.sendWebhook("issues", {
    action: "opened",
    sender: { login: sender, type: "User" },
    issue: { number, title: `Issue ${number}`, body, html_url: `${fake.url}/acme/widgets/issues/${number}`, node_id: `I_${number}`, ...extra },
  });
};
const start = (agentName: string, number: number, requestText: string) =>
  db.createTask({ agent: agentName, installationId: 77, owner: "acme", repo: "widgets", threadKind: "issue", threadNumber: number, threadTitle: "", threadUrl: "", triggerKind: "mention", requestedBy: "alice", requestText, requestUrl: "" });

test("a new issue that names no agent goes to the triage agent, which passes it to the agent that fits", async () => {
  assert.deepEqual((await settings()).routing, { agent: "triage", repos: [], problem: null }, "TRIAGE_AGENT until Settings changes it");
  const agents = ((await app.inject({ method: "GET", url: "/api/agents" })).json() as { agents: { name: string; triage: boolean }[] }).agents;
  assert.deepEqual(agents.filter((entry) => entry.triage).map((entry) => entry.name), ["triage"]);
  const guards = (await app.inject({ method: "GET", url: "/api/guards" })).json() as { global: { name: string; value: string }[] };
  assert.equal(guards.global.find((row) => row.name === "Routes per task")?.value, "3");

  const delivery = await opened(1, "TAG_ONE The orders API returns 500. TRIAGE_TO backend");
  assert.equal(delivery.decision, "triggered", delivery.detail);
  assert.match(delivery.detail, /Queued task #\d+ for triage to route: no agent was named/);
  const [first] = tasksOn(1);
  assert.equal(first!.agent, "triage");
  assert.equal(first!.triggerKind, "triage");
  assert.equal((await h.waitForTask(first!.id)).status, "succeeded");

  // The triage agent is told what it's for, and who there is.
  const prompt = prompts.get("triage:TAG_ONE")!;
  assert.match(prompt, /named no agent, so it came to you, the triage agent/);
  assert.match(prompt, /- \*\*backend\*\* \(@aorch-backend\): APIs and the database \(now: free\)/);
  assert.match(prompt, /- \*\*web\*\* \(@aorch-web\): The web front end/);
  assert.doesNotMatch(prompt, /- \*\*triage\*\*/);
  assert.match(results.join("\n"), /When you finish, \*\*backend\*\* starts on this issue with your reason and instructions/);

  // The agent it chose starts on the same issue, for the person who opened it.
  const routed = tasksOn(1).find((task) => task.agent === "backend")!;
  assert.ok(routed, "backend was started");
  assert.equal(routed.triggerKind, "agent");
  assert.equal(routed.requestedBy, "alice");
  assert.equal(routed.startedByTask, first!.id);
  assert.ok(routed.requestText.startsWith(`**triage** (@aorch-triage) passed this issue to you (orchestrator task #${first!.id}): REASON for backend`), routed.requestText);
  assert.match(routed.requestText, /^> DO_IT carefully$/m);
  assert.doesNotMatch(routed.requestText, /asked triage/, "the issue is the request: not repeated");
  assert.equal((await h.waitForTask(routed.id)).status, "succeeded");
  assert.match(prompts.get("backend:TAG_ONE") ?? "", /passed this issue to you/, "backend has its request, and no section about passing work on");

  // People see who took it and why: on the issue, and in the task's log.
  const comments = fake.issues.get(1)!.comments.map((comment) => comment.body);
  assert.ok(comments.some((body) => body.includes("**Passed this to backend**: REASON for backend")), comments.join("\n---\n"));
  const log = await events(first!.id);
  assert.ok(log.includes("Will pass this issue to backend when the task finishes: REASON for backend"), log.join("\n"));
  assert.ok(log.includes(`Passed this issue to backend (task #${routed.id}): REASON for backend`), log.join("\n"));
  assert.ok(fake.assignees.includes("aorch-backend"), "the issue is assigned to the agent that took it");
  assert.ok(!fake.assignees.includes("aorch-triage"), "not to the triage agent");
  const page = (await app.inject({ method: "GET", url: `/api/tasks/${routed.id}` })).json() as { chain: { ancestors: { id: number }[] } };
  assert.deepEqual(page.chain.ancestors.map((entry) => entry.id), [first!.id]);
});

test("not triaged: an issue that names an agent, one from someone who can't start agents, a repository that isn't listed, triage turned off", async () => {
  const named = await h.mentionOnNewIssue(2, "aorch-backend", "TAG_TWO look at this");
  assert.equal(named.agent, "backend");
  assert.equal(named.triggerKind, "mention");
  await h.waitForTask(named.id);
  assert.deepEqual(tasksOn(2).map((task) => task.agent), ["backend"]);

  // Assigned to an agent as it was opened: the assignment starts that agent.
  const assigned = await opened(3, "TRIAGE_TO backend", { assignees: [{ login: "aorch-web" }] });
  assert.equal(assigned.decision, "ignored", assigned.detail);

  const stranger = await opened(4, "TRIAGE_TO backend", {}, "mallory");
  assert.equal(stranger.decision, "ignored", stranger.detail);
  assert.match(stranger.detail, /No agent named, and @mallory has \w+ access; write is required for triage to triage it/);

  // Only some repositories.
  assert.equal((await setRouting({ repos: ["Other/*", "acme/gadgets"] })).statusCode, 200);
  assert.deepEqual((await settings()).routing.repos, ["other/*", "acme/gadgets"]);
  assert.equal(triageAgentFor("acme/widgets"), null);
  assert.equal(triageAgentFor("other/thing")?.name, "triage");
  assert.equal(triageAgentFor("Acme/Gadgets")?.name, "triage");
  const elsewhere = await opened(5, "TRIAGE_TO backend");
  assert.equal(elsewhere.decision, "ignored", elsewhere.detail);
  assert.match(elsewhere.detail, /No agent mentioned or assigned/);

  // What Settings refuses.
  const unknown = await setRouting({ agent: "nobody" });
  assert.equal(unknown.statusCode, 400);
  assert.match(unknown.json().error, /There's no agent called "nobody"\. Agents: /);
  const wrong = await setRouting({ repos: ["widgets"] });
  assert.equal(wrong.statusCode, 400);
  assert.match(wrong.json().error, /"widgets" isn't a repository: write owner\/name/);
  assert.equal((await setRouting("triage")).statusCode, 400);

  // Off, and on again. A triage agent that's switched off is a problem Settings shows.
  assert.equal((await setRouting({ agent: null, repos: [] })).statusCode, 200);
  assert.deepEqual((await settings()).routing, { agent: null, repos: [], problem: null });
  assert.equal((await opened(6, "TRIAGE_TO backend")).decision, "ignored");
  assert.equal((await setRouting({ agent: "triage" })).statusCode, 200);
  await app.inject({ method: "POST", url: "/api/agents/triage/enabled", payload: { enabled: false } });
  assert.match((await settings()).routing.problem ?? "", /triage is turned off, so new issues that name no agent start nobody/);
  assert.equal((await opened(7, "TRIAGE_TO backend")).decision, "ignored");
  await app.inject({ method: "POST", url: "/api/agents/triage/enabled", payload: { enabled: true } });
  assert.equal((await settings()).routing.problem, null);

  for (const number of [3, 4, 5, 6, 7]) assert.deepEqual(tasksOn(number), [], `#${number} started nobody`);
});

test("an agent with github.route passes a request that isn't its kind of work to the agent that fits", async () => {
  const asked = await h.mentionOnNewIssue(10, "aorch-web", "TAG_TEN the query is slow. WEB_TO backend");
  assert.equal((await h.waitForTask(asked.id)).status, "succeeded");
  const prompt = prompts.get("web:TAG_TEN")!;
  assert.match(prompt, /## Passing this on/);
  assert.match(prompt, /- \*\*backend\*\* \(@aorch-backend\): APIs and the database/);
  assert.doesNotMatch(prompt, /- \*\*triage\*\*/, "nobody passes work to the triage agent");

  const routed = tasksOn(10).find((task) => task.agent === "backend")!;
  assert.ok(routed, "backend was started");
  assert.equal(routed.requestedBy, "alice");
  assert.equal(routed.startedByTask, asked.id);
  // It's told what the person asked the first agent.
  assert.match(routed.requestText, /What @alice asked web:\n\n> Issue 10\n> \n> @aorch-web TAG_TEN the query is slow\./);
  assert.equal((await h.waitForTask(routed.id)).status, "succeeded");

  // What it can't pass on to: nobody, itself, the triage agent.
  const bad = await h.mentionOnNewIssue(11, "aorch-web", "WEB_BAD");
  assert.equal((await h.waitForTask(bad.id)).status, "succeeded");
  assert.equal(results.length, 3);
  assert.match(results[0]!, /There's no agent called \\"nobody\\"\. Agents you can pass it to: backend \(APIs and the database\)\./);
  assert.match(results[1]!, /That's you\. Do the work yourself, or pass it to another agent\./);
  assert.match(results[2]!, /triage is the triage agent: it only passes new issues on/);
  assert.deepEqual(tasksOn(11).map((task) => task.agent), ["web"]);
});

test("MAX_AGENT_CHAIN limits passing on, and an agent already working on the thread gets the message instead of a second task", async () => {
  // Triage → web is one agent starting another: with MAX_AGENT_CHAIN=1, web can't pass it on again.
  config.maxAgentChain = 1;
  try {
    const delivery = await opened(20, "TAG_CHAIN TRIAGE_TO web WEB_TO backend");
    assert.equal(delivery.decision, "triggered", delivery.detail);
    const [first] = tasksOn(20);
    await h.waitForTask(first!.id);
    const second = tasksOn(20).find((task) => task.agent === "web")!;
    assert.ok(second, "triage passed it to web");
    assert.equal((await h.waitForTask(second.id)).status, "succeeded");
    assert.match(results.join("\n"), /This task is the end of a chain of 1 agent passing work to each other, and MAX_AGENT_CHAIN is 1/);
    assert.deepEqual(tasksOn(20).map((task) => task.agent).sort(), ["triage", "web"]);
    const incidents = (await app.inject({ method: "GET", url: "/api/incidents" })).json() as { kind: string; message: string }[];
    assert.ok(incidents.some((incident) => incident.kind === "loop_guard" && /web on acme\/widgets#20 couldn't pass it to another agent/.test(incident.message)), JSON.stringify(incidents));
  } finally {
    config.maxAgentChain = 3;
  }

  // backend is at work on #30 when web passes #30 to it.
  fake.addIssue({ number: 30, title: "Issue 30", body: "x", user: { login: "alice" } });
  const working = start("backend", 30, "SLOW_WORK on the importer");
  h.scheduler.kick();
  await h.waitForTask(working.id, ["running"]);
  const passing = start("web", 30, "WEB_TO backend");
  h.scheduler.kick();
  // (waitForTask would wait for backend too, which is held until released below.)
  const told = `Passed the message to backend on this issue, already working on it (task #${working.id}): REASON for backend`;
  let log: string[] = [];
  for (let i = 0; i < 600 && !log.includes(told); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    log = await events(passing.id);
  }
  assert.ok(log.includes(told), log.join("\n"));
  assert.equal(db.getTask(passing.id)!.status, "succeeded");
  assert.deepEqual(tasksOn(30).map((task) => task.agent).sort(), ["backend", "web"], "no second task for backend");
  release();
  assert.equal((await h.waitForTask(working.id)).status, "succeeded");
});
