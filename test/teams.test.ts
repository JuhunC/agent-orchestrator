import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ModelRequest } from "./fake-model.ts";
import { startHarness } from "./harness.ts";

const agent = (name: string, extra = "") => `---\nhandle: aorch-${name}\ndescription: ${name}\n${extra}---\nYou are ${name}.\n`;

const h = await startHarness({
  "agents/dev-a/agent.md": agent("dev-a"),
  "agents/dev-b/agent.md": agent("dev-b", "effort: low\n"),
  "agents/web-dev/agent.md": agent("web-dev"),
  "agents/rev-sec/agent.md": agent("rev-sec"),
  "agents/rev-qa/agent.md": agent("rev-qa"),
  "agents/solo/agent.md": agent("solo", "replicas: 1\n"),
  "groups/devs.yaml": "description: Developers\nmembers: [dev-a, dev-b]\ndefaults:\n  model: claude-sonnet-5-5\n  effort: high\n  skills: [house]\n",
  "library/skills/house/SKILL.md": "---\nname: house\ndescription: House rules\n---\nTabs.\n",
  "boards/team.yaml": `project: acme/1
poll_seconds: 0
limits: { moves_per_issue: 20, entries_per_column: 5 }
columns:
  Backlog:
    agents: [group:devs]
    role: ROLE_POOL
    moves_to: [Done]
  Ready:
    mode: label
    routes:
      frontend: web-dev
      default: group:devs
    role: ROLE_LABEL
    moves_to: [Done]
  In review:
    agents: [rev-sec, rev-qa]
    mode: all
    role: ROLE_ALL
    moves_to: [Done, In progress]
  In progress:
    agents: [solo]
    role: ROLE_SOLO
    moves_to: [Done]
  Done: {}
`,
});
after(() => h.stop());
const { db, app, fake, model } = h;

const move = (column: string, handoff: string) => [{ type: "tool_use" as const, id: "", name: "mcp__github__move_to_column", input: { column, handoff } }];
model.script = (request: ModelRequest) => {
  const p = request.prompt;
  const system = JSON.stringify(request.body.system);
  const step = request.step;
  const sleep = (seconds: number) => [{ type: "tool_use" as const, id: "", name: "Bash", input: { command: `sleep ${seconds}`, description: "work" } }];
  const done = [{ type: "text" as const, text: "Done." }];
  if (p.includes("ROLE_POOL")) return step === 0 ? sleep(2) : step === 1 ? move("Done", "pooled") : done;
  if (p.includes("ROLE_LABEL")) return step === 0 ? move("Done", "routed") : done;
  if (p.includes("ROLE_SOLO")) return step === 0 ? sleep(2) : step === 1 ? move("Done", "solo") : done;
  if (p.includes("ROLE_ALL")) {
    const sendBack = system.includes("You are rev-sec.") && p.includes("insecure");
    return step === 0 ? sleep(1) : step === 1 ? move(sendBack ? "In progress" : "Done", sendBack ? "Found an injection bug" : "Looks fine") : done;
  }
  return done;
};

async function humanMoves(number: number, column: string, labels: string[] = [], title = `Card ${number}`) {
  fake.addIssue({ number, title, body: "x", user: { login: "alice" }, labels });
  const itemId = fake.addItem(number);
  const item = fake.items.get(itemId)!;
  item.status = column;
  item.history.push(column);
  await h.sendWebhook("projects_v2_item", {
    action: "edited",
    sender: { login: "alice", type: "User" },
    projects_v2_item: { node_id: itemId, project_node_id: fake.project.id },
    changes: { field_value: { field_node_id: "F_status" } },
  });
  return itemId;
}

async function settle(itemIds: string[], column: string) {
  for (let i = 0; i < 1800; i++) {
    if (itemIds.every((id) => fake.items.get(id)!.status === column && !db.activeBoardTasks("team", id).length)) return h.scheduler.idle();
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(itemIds.map((id) => fake.items.get(id)!.history.join(" → ")).join(" | "));
}
const tasksOf = (itemId: string) => db.listTasks({ limit: 200 }).filter((task) => task.boardItemId === itemId).reverse();

test("groups give members shared defaults; the agent's own setting wins", async () => {
  const { agents } = (await app.inject({ method: "GET", url: "/api/agents" })).json();
  const devA = agents.find((candidate: { name: string }) => candidate.name === "dev-a");
  const devB = agents.find((candidate: { name: string }) => candidate.name === "dev-b");
  assert.deepEqual([devA.model, devA.modelFrom, devA.effort, devA.effortFrom], ["claude-sonnet-5-5", "group", "high", "group"]);
  assert.deepEqual([devB.effort, devB.effortFrom], ["low", "agent"]);
  assert.deepEqual(devA.skills, ["house"]);
  assert.deepEqual(devA.groups, ["devs"]);
});

test("pool columns spread cards across the group's agents", async () => {
  const first = await humanMoves(1, "Backlog");
  const second = await humanMoves(2, "Backlog");
  await settle([first, second], "Done");
  const agents = [tasksOf(first)[0]!.agent, tasksOf(second)[0]!.agent].sort();
  assert.deepEqual(agents, ["dev-a", "dev-b"], "one card each");
});

test("label columns route by the issue's labels, with a default", async () => {
  const frontend = await humanMoves(10, "Ready", ["frontend"]);
  const other = await humanMoves(11, "Ready", ["backend"]);
  await settle([frontend, other], "Done");
  assert.equal(tasksOf(frontend)[0]!.agent, "web-dev");
  assert.ok(["dev-a", "dev-b"].includes(tasksOf(other)[0]!.agent));
});

test("all columns run every agent; the card moves when they've all voted, and send-back wins", async () => {
  const fine = await humanMoves(20, "In review");
  const bad = await humanMoves(21, "In review", [], "An insecure login form");
  await settle([fine], "Done");
  await settle([bad], "Done");
  assert.deepEqual(tasksOf(fine).map((task) => task.agent).sort(), ["rev-qa", "rev-sec"]);
  assert.equal(new Set(tasksOf(fine).map((task) => task.boardRound)).size, 1, "one round");
  assert.deepEqual(fake.items.get(bad)!.history, ["In review", "In progress", "Done"], "rev-sec sent it back even though rev-qa approved");
  const comments = fake.issues.get(21)!.comments.map((comment) => comment.body);
  assert.ok(comments.some((body) => /All agents in \*\*In review\*\* finished\. Moving the card to \*\*In progress\*\*/.test(body)));
  assert.match(tasksOf(bad).find((task) => task.agent === "solo")!.prompt!, /Found an injection bug/, "both handoffs reach the next stage");
});

test("replicas cap how many cards an agent works at once", async () => {
  const first = await humanMoves(30, "In progress");
  const second = await humanMoves(31, "In progress");
  await settle([first, second], "Done");
  const [a, b] = [tasksOf(first)[0]!, tasksOf(second)[0]!].sort((x, y) => Date.parse(x.startedAt!) - Date.parse(y.startedAt!));
  assert.ok(Date.parse(b!.startedAt!) >= Date.parse(a!.finishedAt!), "solo (replicas: 1) did one card at a time");
});

test("duplicating agents and applying settings to a whole group", async () => {
  const created = (await app.inject({ method: "POST", url: "/api/agents/dev-a/duplicate", payload: { count: 2, group: "devs" } })).json();
  assert.deepEqual(created.created, ["dev-a-2", "dev-a-3"]);
  const named = (await app.inject({ method: "POST", url: "/api/agents/dev-a/duplicate", payload: { name: "dev-fast", handle: "aorch-dev-fast" } })).json();
  assert.deepEqual(named.created, ["dev-fast"]);
  assert.equal((await app.inject({ method: "POST", url: "/api/agents/dev-a/duplicate", payload: { name: "dev-b" } })).statusCode, 400);

  const { agents, groups } = (await app.inject({ method: "GET", url: "/api/agents" })).json();
  assert.equal(agents.find((candidate: { name: string }) => candidate.name === "dev-a-3").handle, "aorch-dev-a-3");
  assert.deepEqual(groups.find((group: { name: string }) => group.name === "devs").members, ["dev-a", "dev-b", "dev-a-2", "dev-a-3"]);

  const applied = (await app.inject({ method: "POST", url: "/api/groups/devs/apply", payload: { model: "claude-opus-5-5", effort: "max", enabled: false } })).json();
  assert.equal(applied.members.length, 4);
  assert.match(readFileSync(join(h.profilesDir, "agents/dev-a-2/agent.md"), "utf8"), /model: claude-opus-5-5\neffort: max/);
  const after = (await app.inject({ method: "GET", url: "/api/agents" })).json().agents;
  assert.ok(after.filter((candidate: { groups: string[] }) => candidate.groups.includes("devs")).every((candidate: { enabled: boolean; effort: string }) => !candidate.enabled && candidate.effort === "max"));
});
