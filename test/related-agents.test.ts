import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { ModelRequest } from "./fake-model.ts";
import { startHarness } from "./harness.ts";

const agent = (handle: string, github = "") => `---\nhandle: ${handle}\ndescription: ${handle}\ngithub:\n  push: false\n  pull_request: false\n  finalize: false\n${github}---\nYou are ${handle}.\n`;

const h = await startHarness(
  {
    "agents/sub/agent.md": agent("aorch-sub", "  start_related: [parent]\n"),
    "agents/lead/agent.md": agent("aorch-lead", "  start_related: true\n"),
    "agents/plain/agent.md": agent("aorch-plain"),
    "boards/flow.yaml": `project: acme/1
needs_human: Needs human
poll_seconds: 0
related_agents:
  columns: [Integrate]
columns:
  Integrate:
    agent: lead
    role: ROLE_LEAD
    moves_to: [Done]
  Locked:
    agent: lead
    role: ROLE_LOCKED
  Done: {}
`,
  },
  { MAX_AGENT_CHAIN: "2" },
);
after(() => h.stop());
const { db, fake, model } = h;

type Step = { tool: string; input: Record<string, unknown> } | { text: string };
const start = (input: Record<string, unknown>): Step => ({ tool: "mcp__github__start_related_agent", input });

// Markers in the request pick each agent's script; the more specific ones first, since a fresh
// prompt also shows the issue's description and earlier requests.
const SCRIPTS: [string, Step[]][] = [
  ["BOARD_PING", [{ text: "Integrated." }]],
  ["PING_AGAIN", [{ text: "Should not run." }]],
  ["PING_CHILD", [start({ number: 1, message: "PING_AGAIN once more" }), { text: "Fixed." }]],
  ["PING_PARENT", [start({ number: 2, agent: "aorch-sub", message: "PING_CHILD fix the edge case" }), { text: "Asked the sub-issue." }]],
  ["SUB_WORK", [start({ number: 99, message: "x" }), start({ number: 3, message: "x" }), start({ number: 1, message: "PING_PARENT #2 is merged into ao/issue-1" }), { text: "Done." }]],
  ["SUB_BOARD", [start({ number: 10, message: "BOARD_PING #11 is merged" }), { text: "Done." }]],
  ["SUB_LOCKED", [start({ number: 12, message: "no" }), { text: "Done." }]],
  ["ROLE_LEAD", [{ text: "Waiting for sub-issues." }]],
];
model.script = (request: ModelRequest) => {
  const steps = SCRIPTS.find(([marker]) => request.prompt.includes(marker))?.[1] ?? [{ text: "OK" }];
  const step = steps[Math.min(request.step, steps.length - 1)]!;
  return "tool" in step ? [{ type: "tool_use", id: "", name: step.tool, input: step.input }] : [{ type: "text", text: step.text }];
};

async function quiet(seconds = 240) {
  for (let i = 0; i < seconds * 10; i++) {
    const busy = () => db.listTasks({ limit: 100 }).some((task) => task.status === "queued" || task.status === "running");
    if (!busy()) {
      await h.scheduler.idle();
      if (!busy()) return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("agents never finished");
}

async function humanMoves(itemId: string, column: string) {
  const item = fake.items.get(itemId)!;
  item.status = column;
  item.history.push(column);
  return h.sendWebhook("projects_v2_item", {
    action: "edited",
    sender: { login: "alice", type: "User" },
    organization: { login: "acme" },
    projects_v2_item: { node_id: itemId, project_node_id: fake.project.id, content_type: "Issue" },
    changes: { field_value: { field_node_id: "F_status", field_type: "single_select" } },
  });
}

async function mention(number: number, handle: string, text: string, issue: { parent?: number; blockedBy?: number[] } = {}) {
  fake.addIssue({ number, title: `Issue ${number}`, body: `@${handle} ${text}`, user: { login: "alice" }, ...issue });
  const delivery = await h.sendWebhook("issues", {
    action: "opened",
    sender: { login: "alice", type: "User" },
    issue: { number, title: `Issue ${number}`, body: `@${handle} ${text}`, html_url: `${fake.url}/acme/widgets/issues/${number}`, node_id: `I_${number}` },
  });
  assert.equal(delivery.decision, "triggered", delivery.detail);
}

const tasks = () => db.listTasks({ limit: 100 });
const results = (marker: string) => JSON.stringify(model.agentRequests().filter((request) => request.prompt.includes(marker)).at(-1)!.body.messages);

test("a sub-issue's agent starts its parent's agent, which can start it back, until MAX_AGENT_CHAIN", async () => {
  // lead worked on the parent first, so it's the agent responsible for #1.
  await mention(1, "aorch-lead", "LEAD_FIRST look at this");
  await quiet();
  fake.addIssue({ number: 3, title: "Blocker", body: "x", user: { login: "alice" } });
  await mention(2, "aorch-sub", "SUB_WORK do your part", { parent: 1, blockedBy: [3] });
  await quiet();

  const first = tasks().find((task) => task.agent === "sub" && task.threadNumber === 2 && task.triggerKind === "mention")!;
  assert.match(first.prompt!, /start that agent with start_related_agent/);
  const asked = results("SUB_WORK");
  assert.match(asked, /#99 isn't related to #2\.\\nRelated issues:\\n- Parent: #1/);
  assert.match(asked, /#3 is an issue blocking this one, and you may only start agents on this issue's parent \(github.start_related/);
  assert.match(asked, /When you finish, \*\*lead\*\* starts on #1 \(this issue's parent\) with your message/);
  const comments = fake.issues.get(2)!.comments.map((comment) => comment.body).join("\n---\n");
  assert.match(comments, /\*\*Asked the agent of #1 to pick it up\*\* \(this issue's parent\)\./);

  // The parent's agent started from the sub-issue, with its message.
  const woken = tasks().find((task) => task.agent === "lead" && task.threadNumber === 1 && task.triggerKind === "agent")!;
  assert.ok(woken, "lead was started on #1");
  assert.equal(woken.status, "succeeded", woken.error ?? "");
  assert.equal(woken.startedByTask, first.id);
  assert.equal(woken.requestedBy, "aorch-sub");
  assert.match(woken.requestText, /\*\*sub\*\* \(@aorch-sub\) asked you to pick this up from acme\/widgets#2 "Issue 2", a sub-issue of this issue \(orchestrator task #\d+\):\n\n> PING_PARENT #2 is merged/);

  // lead started sub back (named by handle); that task is two starts deep, so it can't start another.
  const back = tasks().find((task) => task.agent === "sub" && task.threadNumber === 2 && task.triggerKind === "agent")!;
  assert.equal(back.startedByTask, woken.id);
  assert.match(back.requestText, /from acme\/widgets#1 "Issue 1", this issue's parent/);
  assert.match(results("PING_CHILD"), /end of a chain of 2 agents starting each other, and MAX_AGENT_CHAIN is 2/);

  // The task page shows the chain both ways.
  const view = (await h.app.inject({ method: "GET", url: `/api/tasks/${woken.id}` })).json().chain;
  assert.deepEqual(view.ancestors.map((node: { id: number }) => node.id), [first.id]);
  assert.deepEqual(view.started.map((node: { id: number; agent: string }) => [node.id, node.agent]), [[back.id, "sub"]]);
  assert.equal(tasks().filter((task) => task.agent === "lead" && task.threadNumber === 1).length, 2, "no third lead task");
  assert.ok(!model.agentRequests().some((request) => request.prompt.includes("PING_AGAIN")));
});

test("on a board, the card's column agent starts, unless the board's related_agents leaves the column out", async () => {
  fake.addIssue({ number: 10, title: "Board parent", body: "x", user: { login: "alice" } });
  const parentItem = fake.addItem(10);
  await humanMoves(parentItem, "Integrate");
  await quiet();
  await mention(11, "aorch-sub", "SUB_BOARD do it", { parent: 10 });
  await quiet();
  const sub = tasks().find((task) => task.threadNumber === 11)!;
  const leadTasks = tasks().filter((task) => task.agent === "lead" && task.threadNumber === 10);
  const woken = leadTasks.find((task) => task.triggerKind === "agent")!;
  assert.ok(woken, `lead was started on the card: ${JSON.stringify(results("SUB_BOARD"))}`);
  assert.equal(woken.board, "flow");
  assert.equal(woken.boardColumn, "Integrate");
  assert.equal(woken.startedByTask, sub.id);
  assert.match(woken.requestText, /^The card is in the "Integrate" column of the flow board\. Do this column's work.*\n\n\*\*sub\*\* \(@aorch-sub\) asked you to pick this up from acme\/widgets#11/s);
  assert.match(woken.requestText, /> BOARD_PING #11 is merged/);
  assert.match(results("SUB_BOARD"), /When you finish, the \\"Integrate\\" agent \(lead\) of the flow board starts on #10/);
  assert.equal(db.getBoardItem("flow", parentItem)!.entries.Integrate, 2, "the start counts as entering the column again");

  // Locked has an agent, but related_agents.columns doesn't list it.
  fake.addIssue({ number: 12, title: "Locked parent", body: "x", user: { login: "alice" } });
  await humanMoves(fake.addItem(12), "Locked");
  await quiet();
  await mention(13, "aorch-sub", "SUB_LOCKED do it", { parent: 12 });
  await quiet();
  assert.match(results("SUB_LOCKED"), /The flow board doesn't let agents on related issues start the agent of \\"Locked\\", where acme\/widgets#12 is \(related_agents.columns/);
  assert.equal(tasks().filter((task) => task.threadNumber === 12).length, 1, "only the board's own start");
});

test("agents without start_related don't get the tool", async () => {
  await mention(20, "aorch-plain", "PLAIN hello", { parent: 1 });
  await quiet();
  const request = model.agentRequests().find((candidate) => candidate.prompt.includes("PLAIN"))!;
  assert.ok(!request.body.tools.some((tool: { name: string }) => tool.name.endsWith("start_related_agent")));
  assert.doesNotMatch(request.prompt, /start_related_agent/);
});
