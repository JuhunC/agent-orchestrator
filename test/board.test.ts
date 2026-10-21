import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { ModelRequest } from "./fake-model.ts";
import { startHarness } from "./harness.ts";

const agent = (handle: string, extra = "") => `---\nhandle: ${handle}\ndescription: ${handle}\n${extra}---\nYou are ${handle}.\n`;
const role = (marker: string) => `---\ndescription: ${marker}\n---\n${marker}\n`;

const h = await startHarness({
  "agents/analyst/agent.md": agent("aorch-analyst", "github:\n  push: false\n  pull_request: false\n  finalize: false\n"),
  "agents/coder/agent.md": agent("aorch-coder", "effort: low\n"),
  "agents/tester/agent.md": agent("aorch-tester", "github:\n  push: false\n  pull_request: false\n  finalize: false\n"),
  "library/roles/requirements.md": role("ROLE_REQUIREMENTS"),
  "library/roles/implement.md": role("ROLE_IMPLEMENT"),
  "library/roles/fix.md": role("ROLE_FIX"),
  "library/roles/verify.md": role("ROLE_VERIFY"),
  "boards/elsewhere.yaml": `project: other-org/4
poll_seconds: 0
columns:
  Todo: {}
`,
  "boards/product.yaml": `project: acme/1
needs_human: Needs human
poll_seconds: 0
limits:
  moves_per_issue: 12
  entries_per_column: 2
columns:
  Backlog: { agent: analyst, role: requirements, moves_to: [Ready] }
  Ready: { agent: coder, role: implement, on_start: In progress, model: claude-sonnet-5-5, effort: high, moves_to: [In review] }
  In progress: { agent: coder, role: fix, moves_to: [In review] }
  In review: { agent: tester, role: verify, moves_to: [Done, In progress] }
  Done: {}
`,
});
after(() => h.stop());
const { db, app, fake, model } = h;

type Step = { tool: string; input: Record<string, unknown> } | { text: string };
const call = (tool: string, input: Record<string, unknown>): Step => ({ tool: `mcp__github__${tool}`, input });
const bash = (command: string): Step => ({ tool: "Bash", input: { command, description: "run" } });

/** The fake model plays a different script for each board role (the role text is in the prompt). */
model.script = (request: ModelRequest) => {
  const p = request.prompt;
  let steps: Step[] = [{ text: "OK" }];
  if (p.includes("ROLE_REQUIREMENTS")) {
    steps = [
      call("update_issue", { body: "## Acceptance criteria\n1. HELLO.md says hello world", add_labels: ["ready"] }),
      call("move_to_column", { column: "Ready", handoff: "Criterion: HELLO.md says hello world" }),
      { text: "Requirements written." },
    ];
  } else if (p.includes("ROLE_IMPLEMENT")) {
    steps = p.includes("take your time")
      ? [bash("sleep 30"), { text: "never" }]
      : [bash("echo hello > HELLO.md"), call("commit_and_push", { message: "Add HELLO.md" }), call("open_pull_request", { title: "Hello", body: "Adds HELLO.md" }), call("move_to_column", { column: "In review", handoff: "Implemented; HELLO.md added" }), { text: "Implemented." }];
  } else if (p.includes("ROLE_FIX")) {
    steps = [bash("echo 'hello world' > HELLO.md"), call("commit_and_push", { message: "Say hello world" }), call("move_to_column", { column: "In review", handoff: "Fixed the greeting" }), { text: "Fixed." }];
  } else if (p.includes("ROLE_VERIFY")) {
    const passes = p.includes("Fixed the greeting") && !p.includes("always broken");
    steps = passes
      ? [bash("cat HELLO.md"), call("submit_review", { event: "APPROVE", body: "All criteria pass." }), call("move_to_column", { column: "Done", handoff: "Verified" }), { text: "Approved." }]
      : [bash("cat HELLO.md"), call("submit_review", { event: "REQUEST_CHANGES", body: "HELLO.md must say hello world" }), call("move_to_column", { column: "In progress", handoff: "HELLO.md must say hello world" }), { text: "Sent back." }];
  }
  const step = steps[Math.min(request.step, steps.length - 1)]!;
  return "tool" in step ? [{ type: "tool_use", id: "", name: step.tool, input: step.input }] : [{ type: "text", text: step.text }];
};

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

async function waitForColumn(itemId: string, column: string, seconds = 180) {
  for (let i = 0; i < seconds * 10; i++) {
    if (fake.items.get(itemId)!.status === column && !db.activeBoardTasks("product", itemId).length) {
      await h.scheduler.idle();
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`card never settled in ${column}; history: ${fake.items.get(itemId)!.history.join(" → ")}`);
}

test("a card moves through the whole board: requirements, implement, test, fix, retest, done", async () => {
  fake.addIssue({ number: 1, title: "Greet people", body: "We should greet people", user: { login: "alice" } });
  const itemId = fake.addItem(1);
  const delivery = await humanMoves(itemId, "Backlog");
  assert.match(delivery.detail, /card in Backlog/);
  await waitForColumn(itemId, "Done");

  assert.deepEqual(fake.items.get(itemId)!.history, ["Backlog", "Ready", "In progress", "In review", "In progress", "In review", "Done"]);
  const tasks = db.listTasks({ limit: 20 }).filter((task) => task.boardItemId === itemId).reverse();
  assert.deepEqual(
    tasks.map((task) => `${task.agent}@${task.boardColumn}:${task.status}`),
    ["analyst@Backlog:succeeded", "coder@Ready:succeeded", "tester@In review:succeeded", "coder@In progress:succeeded", "tester@In review:succeeded"],
  );

  assert.match(fake.issues.get(1)!.body, /Acceptance criteria/, "the analyst rewrote the issue");
  assert.deepEqual(fake.labels, ["ready"]);
  assert.equal(h.showRemote("ao/issue-1:HELLO.md"), "hello world", "every stage worked on one shared branch");
  const prs = [...fake.issues.values()].filter((issue) => issue.pull);
  assert.equal(prs.length, 1);
  assert.equal(prs[0]!.pull?.head, "ao/issue-1");
  assert.deepEqual(
    fake.reviews.map((review) => review.body.split("\n")[0]),
    ["**Changes requested.**", "**Approved.**"],
    "the app can't approve its own PR on GitHub, so verdicts become comment reviews",
  );

  const handoffs = db.listHandoffs("product", itemId);
  assert.deepEqual(handoffs.map((handoff) => `${handoff.fromColumn}→${handoff.toColumn}`), ["Backlog→Ready", "Ready→In review", "In review→In progress", "In progress→In review", "In review→Done"]);
  const fixPrompt = tasks[3]!.prompt!;
  assert.match(fixPrompt, /ROLE_FIX/);
  assert.match(fixPrompt, /HELLO\.md must say hello world/, "the developer got the tester's handoff");

  const implementRequest = model.agentRequests().find((request) => request.prompt.includes("ROLE_IMPLEMENT"))!;
  assert.equal(implementRequest.body.model, "claude-sonnet-5-5", "the column's model override is used");
  const verifyBody = JSON.stringify(model.agentRequests().find((request) => request.prompt.includes("ROLE_VERIFY"))!.body.tools);
  assert.doesNotMatch(verifyBody, /commit_and_push/, "the tester can't push");
  const toolNames = new Set(model.agentRequests().flatMap((request) => request.body.tools.map((tool: { name: string }) => tool.name)));
  assert.ok(![...toolNames].some((name) => /merge/i.test(name)), "no agent has a merge tool");
});

test("loop guards send a card that keeps failing to a person", async () => {
  fake.addIssue({ number: 50, title: "This is always broken", body: "x", user: { login: "alice" } });
  const itemId = fake.addItem(50);
  await humanMoves(itemId, "Backlog");
  await waitForColumn(itemId, "Needs human");
  const history = fake.items.get(itemId)!.history;
  assert.equal(history.at(-1), "Needs human");
  assert.ok(history.filter((column) => column === "In review").length <= 3, history.join(" → "));
  assert.ok(fake.issues.get(50)!.comments.some((comment) => /Stopped the agents on this card because it entered "(In review|In progress)" 3 times/.test(comment.body)));
});

test("moving a card away from an agent's column stops that agent", async () => {
  fake.addIssue({ number: 60, title: "Slow one", body: "take your time", user: { login: "alice" } });
  const itemId = fake.addItem(60, "Backlog");
  db.saveBoardItem({ board: "product", itemId, owner: "acme", repo: "widgets", kind: "issue", number: 60, title: "Slow one", status: "Backlog", moves: 0, entries: {} });
  await humanMoves(itemId, "Ready");
  const task = () => db.listTasks({ limit: 50 }).find((candidate) => candidate.boardItemId === itemId && candidate.boardColumn === "Ready");
  for (let i = 0; i < 300 && !db.listEvents(task()?.id ?? -1).some((event) => event.message.startsWith("Ran `sleep 30`")); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(fake.items.get(itemId)!.status, "In progress", "on_start moved the card");
  await humanMoves(itemId, "Done");
  for (let i = 0; i < 300 && task()!.status === "running"; i++) await new Promise((r) => setTimeout(r, 100));
  await h.scheduler.idle();
  assert.equal(task()!.status, "cancelled");
  assert.match(task()!.error ?? "", /moved to "Done"/);
});

test("a board on an account without the app says where the app is installed", async () => {
  const status = (await app.inject({ method: "POST", url: "/api/boards/elsewhere/sync" })).json();
  assert.match(status.error, /The GitHub App isn't installed on "other-org", which owns this project \(it's installed on: ACME\)/);
  assert.ok(!fake.requests.some((request) => /\/(orgs|users)\/[^/]+\/installation/.test(request.path)), "finds installations by listing them");
});

test("the boards API shows columns, mapping and cards", async () => {
  const data = (await app.inject({ method: "GET", url: "/api/boards" })).json();
  const board = data.boards.find((candidate: { name: string }) => candidate.name === "product");
  assert.equal(board.name, "product");
  assert.deepEqual(board.errors, []);
  assert.equal(board.columns.find((column: { name: string }) => column.name === "Ready").model, "claude-sonnet-5-5");
  assert.ok(board.status.project.columns.includes("Needs human"));
  assert.ok(board.items.length >= 3);

  const patched = await app.inject({ method: "PATCH", url: "/api/agents/coder", payload: { model: "claude-opus-5-5", effort: "max" } });
  assert.equal(patched.statusCode, 200);
  const agents = (await app.inject({ method: "GET", url: "/api/agents" })).json().agents;
  const coder = agents.find((candidate: { name: string }) => candidate.name === "coder");
  assert.equal(coder.model, "claude-opus-5-5");
  assert.equal(coder.effort, "max");
  assert.equal((await app.inject({ method: "PATCH", url: "/api/agents/coder", payload: { effort: "extreme" } })).statusCode, 400);
});
