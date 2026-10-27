import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { ModelRequest } from "./fake-model.ts";
import { startHarness } from "./harness.ts";

const agent = (handle: string, extra = "") => `---\nhandle: ${handle}\ndescription: ${handle}\n${extra}---\nYou are ${handle}.\n`;

const h = await startHarness({
  "agents/planner/agent.md": agent("aorch-planner", "github:\n  sub_issues: write\n  push: false\n  pull_request: false\n  finalize: false\n"),
  "agents/worker/agent.md": agent("aorch-worker"),
  "boards/gates.yaml": `project: acme/1
needs_human: Needs human
poll_seconds: 0
sub_issues:
  column: Backlog
  moves_to: [Ready]
columns:
  Backlog:
    evidence: [dependencies]
  In progress:
    agent: planner
    role: ROLE_PLAN
    moves_to: [Done]
  Ready:
    agent: worker
    role: ROLE_WORK
    moves_to: [In review]
    evidence: [dependencies]
  In review:
    evidence: [merged_into_parent]
  Done: {}
`,
});
after(() => h.stop());
const { db, fake, model } = h;

type Step = { tool: string; input: Record<string, unknown> } | { text: string };
const call = (tool: string, input: Record<string, unknown>): Step => ({ tool: `mcp__github__${tool}`, input });
const bash = (command: string): Step => ({ tool: "Bash", input: { command, description: "run" } });

const firstPlan: Step[] = [
  call("create_sub_issue", { title: "Write the docs", body: "SUB_DOCS: document it in the wiki", labels: ["type:docs"] }),
  call("create_sub_issue", { title: "Build it", body: "SUB_BUILD: add B.md", labels: ["type:feature", "type:docs", "type:refactor"], blocked_by: [2] }),
  call("move_sub_issue", { number: 3, column: "Ready", handoff: "Build it" }),
  call("move_sub_issue", { number: 2, column: "Ready", handoff: "Docs first" }),
  call("list_sub_issues", {}),
  call("update_issue", { add_labels: ["type:spec"] }),
  call("update_issue", { state_reason: "not_planned" }),
  { text: "Planned." },
];
const secondPlan: Step[] = [call("move_sub_issue", { number: 3, column: "Ready", handoff: "The docs are done; build it" }), { text: "Unblocked." }];
const docs: Step[] = [call("move_to_column", { column: "In review", handoff: "Documented in the wiki" }), call("update_issue", { state: "closed" }), { text: "Documented." }];
const build: Step[] = [
  bash("echo B > B.md"),
  call("commit_and_push", { message: "Add B.md" }),
  call("open_pull_request", { title: "Build it", body: "Adds B.md" }),
  call("move_to_column", { column: "In review", handoff: "Built" }),
  { text: "Built, not merged." },
];

model.script = (request: ModelRequest) => {
  const p = request.prompt;
  let steps: Step[] = [{ text: "OK" }];
  if (p.includes("ROLE_PLAN")) steps = fake.issues.get(2)?.state === "closed" ? secondPlan : firstPlan;
  else if (p.includes("SUB_DOCS")) steps = docs;
  else if (p.includes("SUB_BUILD")) steps = build;
  const step = steps[Math.min(request.step, steps.length - 1)]!;
  return "tool" in step ? [{ type: "tool_use", id: "", name: step.tool, input: step.input }] : [{ type: "text", text: step.text }];
};

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

async function quiet() {
  for (let i = 0; i < 2400; i++) {
    const busy = () => db.listTasks({ limit: 100 }).some((task) => task.status === "queued" || task.status === "running");
    if (!busy()) {
      await h.scheduler.idle();
      if (!busy()) return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("agents never finished");
}

/** What the agent saw from its tools in its latest turn for a prompt containing `marker`. */
const results = (marker: string) => JSON.stringify(model.agentRequests().filter((request) => request.prompt.includes(marker)).at(-1)!.body.messages);
const cardOf = (number: number) => [...fake.items.values()].find((item) => item.number === number);
const lastComment = (number: number) => fake.issues.get(number)!.comments.at(-1)!.body;

test("labels are created on demand, blocked sub-issues can't move on, docs-only sub-issues close themselves, and unmerged sub-issues can't go to review", async () => {
  fake.addIssue({ number: 1, title: "Ship the widget", body: "PARENT", user: { login: "alice" } });
  const parent = fake.addItem(1);
  await humanMoves(parent, "In progress");
  await quiet();

  // Labels the repository didn't have were created once each, then applied.
  const createdLabels = fake.requests.filter((request) => request.method === "POST" && request.path === "/repos/acme/widgets/labels").map((request) => request.body.name);
  assert.deepEqual(createdLabels, ["type:docs", "type:feature", "type:spec"]);
  assert.deepEqual(fake.issues.get(3)!.labels, ["type:feature", "type:docs", "type:refactor"]);
  assert.deepEqual(fake.issues.get(1)!.labels, ["type:spec"]);
  const planned = results("ROLE_PLAN");
  assert.match(planned, /Created the label type:docs in acme\/widgets/);
  assert.match(planned, /It's blocked by #2\./);
  assert.deepEqual(fake.issues.get(3)!.blockedBy, [2]);

  // #3 is blocked by #2, so it can't go to Ready, nor land in Backlog (which also checks dependencies).
  assert.match(planned, /Can't move #3 to \\"Ready\\" yet:\\n- evidence \\"dependencies\\" for #3: #3 is blocked by #2 \\"Write the docs\\", which is still open/);
  assert.match(planned, /#3 \\"Build it\\" \(open\): no branch yet \(`ao\/issue-3`\) · labels: type:feature, type:docs, type:refactor · blocked by #2 \(open\)/);
  assert.match(planned, /state_reason goes with state: closed/);
  assert.match(lastComment(1), /Sub-issue #3 wasn't added to the board in \*\*Backlog\*\* because:\n- evidence "dependencies" for #3: #3 is blocked by #2/);
  assert.equal(cardOf(3), undefined);

  // #2 is docs-only: nothing to merge, so it may go to In review, and it closed itself after its task.
  assert.deepEqual(cardOf(2)!.history, ["Ready", "In review"]);
  assert.equal(fake.issues.get(2)!.state, "closed");
  assert.equal(fake.issues.get(2)!.stateReason, "completed");
  assert.match(results("SUB_DOCS"), /It's closed as completed when you finish/);
  assert.match(lastComment(2), /\*\*Closed the issue\*\* as completed/);

  // With #2 closed, the parent's agent may put #3 in Ready; its worker can't send unmerged work to review.
  await humanMoves(parent, "Done");
  await humanMoves(parent, "In progress");
  await quiet();
  assert.match(results("ROLE_PLAN"), /#3 will move to \\"Ready\\" when you finish \(it isn't on the board yet, so it's added there\)/);
  assert.deepEqual(cardOf(3)!.history, ["Ready"]);
  assert.match(results("SUB_BUILD"), /evidence \\"merged_into_parent\\" .*?: your branch \(at [0-9a-f]{10}\) isn't merged into the parent's branch `ao\/issue-1` yet/);
  assert.equal(cardOf(3)!.status, "Ready");
});
