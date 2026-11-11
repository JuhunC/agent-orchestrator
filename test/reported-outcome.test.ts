import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { ModelRequest } from "./fake-model.ts";
import { startHarness } from "./harness.ts";

const agent = (name: string) => `---\nhandle: aorch-${name}\ndescription: ${name}\nlive: false\ngithub:\n  push: false\n  pull_request: false\n  finalize: false\n---\nYou are ${name}.\n`;
const h = await startHarness({
  "agents/helper/agent.md": agent("helper"),
  "agents/second/agent.md": agent("second"),
  "boards/flow.yaml": `project: acme/1
needs_human: Needs human
poll_seconds: 0
columns:
  Backlog: { agent: helper, role: ROLE_WORK, moves_to: [Done] }
  Done: {}
`,
});
after(() => h.stop());
const { app, db, fake, model } = h;

const text = (value: string) => [{ type: "text" as const, text: value }];
const call = (name: string, input: Record<string, unknown>) => [{ type: "tool_use" as const, id: "", name: `mcp__github__${name}`, input }];
/** What the tools answered in this session so far. */
const toolResults = (request: ModelRequest) =>
  JSON.stringify((request.body.messages as { content: unknown }[]).flatMap((message) => (Array.isArray(message.content) ? message.content.filter((block: { type: string }) => block.type === "tool_result") : [])));
const answers: string[] = [];

model.script = (request: ModelRequest) => {
  const p = request.prompt;
  const steps = (...turns: ReturnType<typeof call>[]) => turns[request.step] ?? (answers.push(toolResults(request)), text("Here's where it stands."));
  if (p.includes("PLAIN_ANSWER")) return text("All done.");
  if (p.includes("REPORT_TAKEN_BACK")) return steps(call("report_outcome", { outcome: "blocked", note: "Thought I needed a key." }), call("report_outcome", { outcome: "done" }));
  if (p.includes("REPORT_NO_NOTE")) return steps(call("report_outcome", { outcome: "gave_up" }));
  if (p.includes("REPORT_AND_MOVE")) return steps(call("report_outcome", { outcome: "blocked", note: "The design isn't decided." }), call("move_to_column", { column: "Done", handoff: "Nothing more I can do" }));
  if (p.includes("REPORT_PARTIAL")) return steps(call("report_outcome", { outcome: "partial", note: "The docs aren't updated yet." }));
  if (p.includes("REPORT_GAVE_UP")) return steps(call("report_outcome", { outcome: "gave_up", note: "The test suite doesn't run here." }));
  if (p.includes("REPORT_BLOCKED")) return steps(call("report_outcome", { outcome: "blocked", note: "Needs the API key from ops." }));
  return text("All done.");
};
const overview = async () => (await app.inject({ method: "GET", url: "/api/overview" })).json() as { attention: { id: number }[]; incidents: { kind: string; message: string }[] };
const lastComment = (issue: number) => fake.issues.get(issue)!.comments.at(-1)!.body;

test("an agent that says it's blocked ends a task that isn't shown as done", async () => {
  const task = await h.waitForTask((await h.mentionOnNewIssue(1, "aorch-helper", "REPORT_BLOCKED please")).id);
  assert.equal(task.status, "succeeded", task.error ?? "");
  assert.equal(task.outcome, "blocked");
  assert.equal(task.outcomeNote, "Needs the API key from ops.");
  assert.match(lastComment(1), /\*\*helper\*\* is blocked and needs someone 🚧/);
  assert.match(lastComment(1), /\*\*Why:\*\* Needs the API key from ops\./);
  assert.match(answers.at(-1)!, /will be shown as blocked/);

  const listed = (await app.inject({ method: "GET", url: "/api/tasks?outcome=blocked" })).json() as { id: number }[];
  assert.deepEqual(listed.map((row) => row.id), [task.id]);
  const page = await overview();
  assert.deepEqual(page.attention.map((row) => row.id), [task.id], "it waits on a person");
  assert.ok(page.incidents.some((incident) => incident.kind === "task_blocked" && /helper is blocked on acme\/widgets#1: Needs the API key/.test(incident.message)));

  // Another agent on the thread is told how that run ended.
  const other = await h.waitForTask((await h.commentMention(1, "@aorch-second PLAIN_ANSWER can you help here?")).id);
  assert.match(other.prompt ?? "", new RegExp(`### helper — run ${task.id}, .* \\(blocked: Needs the API key from ops\\.\\)`));
  assert.deepEqual((await overview()).attention.map((row) => row.id), [task.id], "still waiting: its own agent hasn't been back");

  // Once the agent runs there again, nothing waits on a person any more.
  const next = await h.waitForTask((await h.commentMention(1, "@aorch-helper the key is in the vault now")).id);
  assert.equal(next.outcome, null);
  assert.match(lastComment(1), /\*\*helper\*\* finished ✅/);
  assert.deepEqual((await overview()).attention, []);
});

test("part done and given up are told apart; done takes a report back; a report needs a note", async () => {
  const partial = await h.waitForTask((await h.mentionOnNewIssue(2, "aorch-helper", "REPORT_PARTIAL please")).id);
  assert.equal(partial.outcome, "partial");
  assert.match(lastComment(2), /finished part of this ⚠️[\s\S]*\*\*Why:\*\* The docs aren't updated yet\./);
  assert.ok(!(await overview()).attention.some((row) => row.id === partial.id), "partly done isn't waiting on a person");

  const gaveUp = await h.waitForTask((await h.mentionOnNewIssue(3, "aorch-helper", "REPORT_GAVE_UP please")).id);
  assert.equal(gaveUp.outcome, "gave_up");
  assert.match(lastComment(3), /couldn't do this 🏳️/);

  const takenBack = await h.waitForTask((await h.mentionOnNewIssue(4, "aorch-helper", "REPORT_TAKEN_BACK please")).id);
  assert.equal(takenBack.outcome, null);
  assert.match(lastComment(4), /finished ✅/);

  const noNote = await h.waitForTask((await h.mentionOnNewIssue(5, "aorch-helper", "REPORT_NO_NOTE please")).id);
  assert.equal(noNote.outcome, null);
  assert.match(answers.at(-1)!, /Give a note/);

  const some = (await app.inject({ method: "GET", url: "/api/tasks?outcome=any" })).json() as { id: number }[];
  assert.deepEqual(some.map((row) => row.id).sort(), [1, partial.id, gaveUp.id].sort());
});

/** A person drags the card into `column` on GitHub. */
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
async function settled(itemId: string) {
  for (let i = 0; i < 900; i++) {
    const tasks = db.listTasks({ limit: 50 }).filter((task) => task.boardItemId === itemId);
    if (tasks.length && tasks.every((task) => !["queued", "running"].includes(task.status))) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await h.scheduler.idle();
}

test("a blocked agent's card goes to a person, unless the agent moved it itself", async () => {
  fake.addIssue({ number: 6, title: "Stuck", body: "REPORT_BLOCKED on this card", user: { login: "alice" } });
  const stuck = fake.addItem(6);
  await humanMoves(stuck, "Backlog");
  await settled(stuck);
  assert.equal(fake.items.get(stuck)!.status, "Needs human", fake.items.get(stuck)!.history.join(" → "));
  assert.match(lastComment(6), /is blocked and needs someone 🚧/);
  assert.match(lastComment(6), /\*\*Moved the card to Needs human\*\* for a person to look at, because the agent is blocked\./);
  const handoffs = (await app.inject({ method: "GET", url: `/api/boards/flow/items/${stuck}/handoffs` })).json() as { toColumn: string; note: string }[];
  assert.deepEqual(handoffs.map((handoff) => [handoff.toColumn, handoff.note]), [["Needs human", "Needs the API key from ops."]]);
  assert.match(answers.at(-1)!, /it goes to Needs human with your note when you finish/);

  fake.addIssue({ number: 7, title: "Moved anyway", body: "REPORT_AND_MOVE on this card", user: { login: "alice" } });
  const moved = fake.addItem(7);
  await humanMoves(moved, "Backlog");
  await settled(moved);
  assert.equal(fake.items.get(moved)!.status, "Done", "the agent's own move stands");
  assert.equal(db.listTasks({ limit: 50 }).find((task) => task.boardItemId === moved)!.outcome, "blocked");

  fake.addIssue({ number: 8, title: "Half", body: "REPORT_PARTIAL on this card", user: { login: "alice" } });
  const half = fake.addItem(8);
  await humanMoves(half, "Backlog");
  await settled(half);
  assert.equal(fake.items.get(half)!.status, "Backlog", "a partly done card stays where the agent left it");
});

test("the outcomes report counts only finished work as done", async () => {
  const report = (await app.inject({ method: "GET", url: "/api/outcomes?days=1" })).json();
  const helper = report.agents.find((row: { agent: string }) => row.agent === "helper");
  // Issues 1 (twice), 2-5 and the three cards: nine tasks, none failed.
  assert.deepEqual(helper.tasks, { succeeded: 9, failed: 0, cancelled: 0 });
  assert.deepEqual(helper.reported, { partial: 2, blocked: 3, gaveUp: 1 });
  assert.equal(helper.successRate, 3 / 9);
  assert.deepEqual(report.totals.reported, helper.reported);
});
