import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { ModelRequest } from "./fake-model.ts";
import { startHarness } from "./harness.ts";

const agent = (handle: string, extra = "") => `---\nhandle: ${handle}\ndescription: ${handle}\n${extra}---\nYou are ${handle}.\n`;
const readOnly = "  push: false\n  pull_request: false\n  finalize: false\n";

const h = await startHarness({
  "agents/planner/agent.md": agent("aorch-planner", `github:\n  sub_issues: write\n${readOnly}`),
  "agents/worker/agent.md": agent("aorch-worker", "github:\n  merge_into_parent: true\n"),
  "agents/integrator/agent.md": agent("aorch-integrator", `github:\n  sub_issues: read\n${readOnly}`),
  "agents/linker/agent.md": agent("aorch-linker", `github:\n  relations: true\n${readOnly}`),
  "boards/tree.yaml": `project: acme/1
needs_human: Needs human
poll_seconds: 0
sub_issues:
  column: Ready
  moves_to: [Ready, In review]
fields:
  start: Start date
  end: End date
  estimate: Estimate
  start_on: [Ready]
  end_on: [In review]
columns:
  Backlog:
    agent: planner
    role: ROLE_PLAN
    moves_to: [In progress]
  Ready:
    agent: worker
    role: ROLE_WORK
    moves_to: [In review]
  In review:
    evidence: [merged]
  In progress:
    agent: integrator
    role: ROLE_INTEGRATE
    moves_to: [Done]
  Done:
    evidence: [sub_issues]
`,
});
after(() => h.stop());
const { db, app, fake, model } = h;

type Step = { tool: string; input: Record<string, unknown> } | { text: string };
const call = (tool: string, input: Record<string, unknown>): Step => ({ tool: `mcp__github__${tool}`, input });
const bash = (command: string): Step => ({ tool: "Bash", input: { command, description: "run" } });

const plan: Step[] = [
  call("create_sub_issue", { title: "Part A", body: "SUB_A: add A.md", start: "2026-11-02", end: "2026-11-06", estimate: 3 }),
  call("create_sub_issue", { title: "Part B", body: "SUB_B: add B.md", estimate: 5 }),
  call("set_card_fields", { start: "2026-11-21", end: "2026-11-20" }),
  call("set_card_fields", { start: "2026-11-01", end: "2026-11-20", estimate: 8 }),
  call("set_card_fields", { number: 3, end: "2026-11-30" }),
  call("move_sub_issue", { number: 3, column: "In review", handoff: "Too early" }),
  call("move_sub_issue", { number: 99, column: "Ready", handoff: "Not mine" }),
  { text: "Planned: #2 and #3." },
];
const work = (part: "A" | "B"): Step[] => [
  bash(`echo ${part} > ${part}.md`),
  call("commit_and_push", { message: `Add ${part}.md` }),
  call("open_pull_request", { title: `Part ${part}`, body: `Adds ${part}.md` }),
  call("move_to_column", { column: "In review", handoff: "Done" }),
  ...(part === "A" ? [call("merge_into_parent", {}), call("move_to_column", { column: "In review", handoff: "Merged into the parent" })] : []),
  { text: `Worked on ${part}.` },
];
const integrate: Step[] = [call("list_sub_issues", {}), call("move_to_column", { column: "Done", handoff: "All parts are in" }), { text: "Integrated." }];
const link: Step[] = [
  call("link_issue", { relation: "blocked_by", number: 31 }),
  call("link_issue", { relation: "parent", number: 32 }),
  call("link_issue", { relation: "sub_issue", number: 33 }),
  call("link_issue", { relation: "blocks", number: 31, remove: true }),
  call("link_issue", { relation: "blocked_by", number: 30 }),
  { text: "Linked." },
];

model.script = (request: ModelRequest) => {
  const p = request.prompt;
  let steps: Step[] = [{ text: "OK" }];
  if (p.includes("ROLE_PLAN")) steps = plan;
  else if (p.includes("ROLE_WORK")) steps = work(p.includes("SUB_A") ? "A" : "B");
  else if (p.includes("ROLE_INTEGRATE")) steps = integrate;
  else if (p.includes("LINK_ME")) steps = link;
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

/** Waits until no agent is working on any card of the board. */
async function quiet(seconds = 240) {
  for (let i = 0; i < seconds * 10; i++) {
    const busy = db.listTasks({ limit: 100 }).some((task) => task.status === "queued" || task.status === "running");
    if (!busy) {
      await h.scheduler.idle();
      if (!db.listTasks({ limit: 100 }).some((task) => task.status === "queued" || task.status === "running")) return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("agents never finished");
}

const lastTask = (agentName: string, number: number) => db.listTasks({ limit: 100 }).find((task) => task.agent === agentName && task.threadNumber === number)!;
const results = (marker: string) => JSON.stringify(model.agentRequests().filter((request) => request.prompt.includes(marker)).at(-1)!.body.messages);
const lastComment = (number: number) => fake.issues.get(number)!.comments.at(-1)!.body;

test("a parent splits into sub-issues whose work merges into the parent's branch, checked before the parent moves on", async () => {
  fake.addIssue({ number: 1, title: "Build the widget", body: "PARENT_ISSUE", user: { login: "alice" } });
  const parentItem = fake.addItem(1);
  await humanMoves(parentItem, "Backlog");
  await quiet();

  // The planner created two sub-issues, which went on the board in Ready and started the workers.
  assert.equal(fake.issues.get(2)!.parent, 1);
  assert.equal(fake.issues.get(3)!.parent, 1);
  assert.match(fake.issues.get(2)!.body, /Sub-issue of #1, created by \*\*planner\*\*/);
  const planned = results("ROLE_PLAN");
  assert.match(planned, /Created #2 \\"Part A\\" as a sub-issue of #1/);
  assert.match(planned, /added to the tree board in \\"Ready\\" when you finish/);
  assert.match(planned, /Can't move #3 to \\"In review\\" yet:\\n- evidence \\"merged\\" for #3: #3 has no branch \(`ao\/issue-3`\) yet/);
  assert.match(planned, /#99 isn't a sub-issue of #1. Its sub-issues: #2, #3/);
  assert.match(lastComment(1), /Added sub-issues #2, #3 to the board in Ready/);
  assert.match(planned, /The start date \(2026-11-21\) is after the end date \(2026-11-20\)/);
  assert.match(planned, /Set #1's Start date 2026-11-01, End date 2026-11-20, Estimate 8/);
  assert.match(planned, /#3 isn't on the board yet; its End date 2026-11-30 are set when it's added/);
  assert.match(lastTask("planner", 1).prompt!, /The project tracks this card's start date \("Start date"\): not set; end date \("End date"\): not set; estimate \("Estimate"\): not set/);
  const cardOf = (number: number) => [...fake.items.values()].find((item) => item.number === number)!;
  assert.deepEqual(cardOf(1).history, ["Backlog"], "the planner didn't move the parent");

  // Each sub-issue branched from the parent's branch and opened its pull request against it.
  const workerPrompt = lastTask("worker", 2).prompt!;
  assert.match(workerPrompt, /- Parent: #1 "Build the widget" \(open\)/);
  assert.match(workerPrompt, /This is a sub-issue of #1: your branch `ao\/issue-2` starts from the parent's branch `ao\/issue-1`/);
  assert.match(workerPrompt, /merge_into_parent only merges a sub-issue's work into its parent issue's branch/);
  const pulls = [...fake.issues.values()].filter((issue) => issue.pull);
  assert.deepEqual(pulls.map((pr) => `${pr.pull!.head}→${pr.pull!.base}`).sort(), ["ao/issue-2→ao/issue-1", "ao/issue-3→ao/issue-1"]);
  assert.match(pulls[0]!.body, /part of #1 \(merges into `ao\/issue-1`/);

  // A merged itself into the parent (with a merge commit) and moved on; B wasn't merged, so it stayed.
  assert.match(results("SUB_A"), /evidence \\"merged\\" \(your branch merged into the branch it targets.*?\): your branch \(at [0-9a-f]{10}\) isn't merged into `ao\/issue-1` yet. Push it with commit_and_push, then call merge_into_parent/);
  assert.match(results("SUB_A"), /Done \(merged pull request #\d+\): `ao\/issue-2` at [0-9a-f]{10} is now an ancestor of `ao\/issue-1`/);
  assert.equal(h.showRemote("ao/issue-1:A.md"), "A");
  assert.equal(fake.issues.get(2)!.state, "closed");
  assert.deepEqual(cardOf(2).history, ["Ready", "In review"]);
  assert.deepEqual(cardOf(3).history, ["Ready"]);
  assert.match(lastComment(3), /The card stays in \*\*Ready\*\* \(the agent didn't move it\)/);

  // Dates and estimates: what the planner set, plus start_on (Ready) and end_on (In review) filled in today.
  const today = new Date().toISOString().slice(0, 10);
  const values = (number: number) => cardOf(number).values;
  assert.deepEqual(values(1), { F_start: "2026-11-01", F_end: "2026-11-20", F_estimate: 8 });
  assert.deepEqual(values(2), { F_start: "2026-11-02", F_end: today, F_estimate: 3 }, "its own start stays; entering In review sets the end");
  assert.deepEqual(values(3), { F_start: today, F_end: "2026-11-30", F_estimate: 5 });
  const cards = (await app.inject({ method: "GET", url: "/api/boards" })).json().boards.find((board: { name: string }) => board.name === "tree").items;
  assert.deepEqual(cards.find((card: { number: number }) => card.number === 3).fields, { start: today, end: "2026-11-30", estimate: 5 });

  // The parent can't be Done while B's work isn't in its branch.
  await humanMoves(parentItem, "In progress");
  await quiet();
  const checked = results("ROLE_INTEGRATE");
  assert.match(checked, /#2 \\"Part A\\" \(closed, completed\): `ao\/issue-2` at [0-9a-f]{10}: merged into `ao\/issue-1`/);
  assert.match(checked, /#3 \\"Part B\\" \(open\): `ao\/issue-3` at [0-9a-f]{10}: NOT merged into `ao\/issue-1`/);
  assert.match(checked, /evidence \\"sub_issues\\" [^:]*: #3's branch `ao\/issue-3` \(at [0-9a-f]{10}\) isn't merged into `ao\/issue-1` yet. See list_sub_issues/);
  assert.equal(cardOf(1).status, "In progress");
  const integratorTools = JSON.stringify(model.agentRequests().find((request) => request.prompt.includes("ROLE_INTEGRATE"))!.body.tools.map((tool: { name: string }) => tool.name));
  assert.match(integratorTools, /list_sub_issues/);
  assert.doesNotMatch(integratorTools, /create_sub_issue|move_sub_issue|merge_into_parent/, "sub_issues: read only lists");

  // A person merges B's pull request into the parent branch; now the parent may move on.
  const prB = pulls.find((pr) => pr.pull!.head === "ao/issue-3")!;
  fake.mergeBranches("ao/issue-1", "ao/issue-3", `Merge pull request #${prB.number}`);
  prB.state = "closed";
  await humanMoves(parentItem, "Needs human");
  await humanMoves(parentItem, "In progress");
  await quiet();
  assert.equal(cardOf(1).status, "Done");
  assert.match(lastComment(1), /Moved the card to Done/);
});

test("agents link issues: blocked by, parent, sub-issue, and removing a link", async () => {
  for (const number of [31, 32, 33]) fake.addIssue({ number, title: `Other ${number}`, body: "x", user: { login: "alice" } });
  fake.addIssue({ number: 30, title: "Linked one", body: "@aorch-linker LINK_ME", user: { login: "alice" } });
  const delivery = await h.sendWebhook("issues", {
    action: "opened",
    sender: { login: "alice", type: "User" },
    issue: { number: 30, title: "Linked one", body: "@aorch-linker LINK_ME", html_url: `${fake.url}/acme/widgets/issues/30`, node_id: "I_30" },
  });
  assert.equal(delivery.decision, "triggered", delivery.detail);
  const task = await h.waitForTask(db.listTasks({ limit: 1 })[0]!.id);
  assert.equal(task.status, "succeeded", task.error ?? "");
  assert.deepEqual(fake.issues.get(30)!.blockedBy, [31]);
  assert.equal(fake.issues.get(30)!.parent, 32);
  assert.equal(fake.issues.get(33)!.parent, 30);
  const seen = results("LINK_ME");
  assert.match(seen, /Linked: #30 is blocked by #31/);
  assert.match(seen, /Linked: #30 is a sub-issue of #32/);
  assert.match(seen, /Linked: #33 is a sub-issue of #30/);
  assert.match(seen, /Removed the relation: #30 blocks #31 no longer/);
  assert.match(seen, /An issue can't be related to itself/);
});

test("the options reference lists every kind of profile file and what exists now", async () => {
  const reference = (await app.inject({ method: "GET", url: "/api/profiles/reference" })).json();
  const ids = reference.files.map((file: { id: string }) => file.id);
  assert.deepEqual(ids, ["agent", "agent-mcp", "skill", "role", "library-mcp", "group", "board"]);
  const agentDoc = reference.files.find((file: { id: string }) => file.id === "agent");
  const subIssues = agentDoc.options.find((option: { key: string }) => option.key === "github.sub_issues");
  assert.deepEqual(subIssues.values, ["none", "read", "write"]);
  assert.equal(subIssues.default, "none");
  assert.ok(reference.values.agents.includes("planner"));
  assert.ok(reference.values.agentRefs.includes("planner"));
  const board = (await app.inject({ method: "GET", url: "/api/boards" })).json().boards.find((candidate: { name: string }) => candidate.name === "tree");
  assert.deepEqual(board.subIssues, { column: "Ready", movesTo: ["Ready", "In review"] });
  assert.ok(new RegExp(agentDoc.pattern).test("agents/planner/agent.md"));
});
