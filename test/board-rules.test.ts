import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { ModelRequest } from "./fake-model.ts";
import { startHarness } from "./harness.ts";

const agent = (handle: string, extra = "") => `---\nhandle: ${handle}\ndescription: ${handle}\n${extra}---\nYou are ${handle}.\n`;

const h = await startHarness({
  "agents/coder/agent.md": agent("aorch-coder"),
  "agents/tester/agent.md": agent("aorch-tester", "github:\n  push: false\n  pull_request: false\n  finalize: false\n"),
  "boards/gated.yaml": `project: acme/1
needs_human: Needs human
poll_seconds: 0
work_types:
  docs:
    labels: [documentation]
    forbid: [In review]
columns:
  Ready:
    agent: coder
    role: ROLE_BUILD
    moves_to: [In review, Done]
  In review:
    agent: tester
    role: ROLE_CHECK
    moves_to: [Done, Ready]
    evidence: [pull_request]
    handoff_required: [status]
  Done:
    evidence: [approval, tests]
    test_command: ./check.sh
    handoff_required: [verified, risks]
`,
  "boards/broken.yaml": `project: other-org/9
poll_seconds: 0
work_types:
  bugfix: { labels: [], forbid: [Nowhere, Needs human], color: red }
columns:
  Todo: { evidence: [screenshots], handoff_required: [mood], test_command: npm test }
  Needs human: { handoff_required: [status] }
`,
});
after(() => h.stop());
const { db, app, fake, model } = h;

type Step = { tool: string; input: Record<string, unknown> } | { text: string };
const call = (tool: string, input: Record<string, unknown>): Step => ({ tool: `mcp__github__${tool}`, input });
const bash = (command: string): Step => ({ tool: "Bash", input: { command, description: "run" } });
const done = { verified: "ran ./check.sh: it passes", risks: "none" };

const build: Step[] = [
  bash("printf '#!/bin/sh\\ngrep -q hello HELLO.md\\n' > check.sh && chmod +x check.sh && echo hello > HELLO.md"),
  call("commit_and_push", { message: "Add HELLO.md and check.sh" }),
  call("move_to_column", { column: "In review", handoff: "Added HELLO.md" }),
  call("open_pull_request", { title: "Hello", body: "Adds HELLO.md" }),
  call("move_to_column", { column: "In review", handoff: "Added HELLO.md", fields: { status: "Ready for review" } }),
  { text: "Built." },
];
const check: Step[] = [
  call("move_to_column", { column: "Done", handoff: "Looks fine" }),
  bash("echo bye > HELLO.md && ./check.sh"),
  call("submit_review", { event: "APPROVE", body: "Works." }),
  call("move_to_column", { column: "Done", handoff: "Verified", fields: done }),
  bash("git checkout HELLO.md && ./check.sh"),
  bash("echo scratch > notes.txt"),
  call("move_to_column", { column: "Done", handoff: "Verified", fields: done }),
  bash("rm notes.txt && ./check.sh"),
  call("move_to_column", { column: "Done", handoff: "Verified", fields: done }),
  { text: "Verified." },
];
const changeAfterMove: Step[] = [
  bash("./check.sh"),
  call("submit_review", { event: "APPROVE", body: "Works." }),
  call("move_to_column", { column: "Done", handoff: "Verified", fields: done }),
  bash("echo late > LATE.md"),
  { text: "Verified." },
];
const docs: Step[] = [
  call("move_to_column", { column: "In review", handoff: "Docs", fields: { status: "done" } }),
  call("move_to_column", { column: "Needs human", handoff: "Docs cards skip review; please check it yourself" }),
  { text: "Handed to a person." },
];

model.script = (request: ModelRequest) => {
  const p = request.prompt;
  let steps: Step[] = [{ text: "OK" }];
  if (p.includes("ROLE_BUILD")) steps = p.includes("DOCS_CARD") ? docs : build;
  else if (p.includes("ROLE_CHECK")) steps = p.includes("CHANGE_AFTER_MOVE") ? changeAfterMove : check;
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

async function settle(itemId: string, column: string) {
  for (let i = 0; i < 1800; i++) {
    const status = fake.items.get(itemId)!.status;
    if (status === column && !db.activeBoardTasks("gated", itemId).length) {
      await h.scheduler.idle();
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`card never settled in ${column}; history: ${fake.items.get(itemId)!.history.join(" → ")}`);
}

/** Everything the agent saw back from its tools in its last request for this card. */
const toolResults = (marker: string, role: string) => JSON.stringify(model.agentRequests().filter((request) => request.prompt.includes(marker) && request.prompt.includes(role)).at(-1)!.body.messages);

test("agents get concrete refusals until a move has its evidence and handoff fields", async () => {
  fake.addIssue({ number: 1, title: "Greet people", body: "GREET_ONE", user: { login: "alice" } });
  const itemId = fake.addItem(1);
  await humanMoves(itemId, "Ready");
  await settle(itemId, "Done");
  assert.deepEqual(fake.items.get(itemId)!.history, ["Ready", "In review", "Done"]);

  const built = toolResults("GREET_ONE", "ROLE_BUILD");
  assert.match(built, /Can't move the card to \\"In review\\" yet/);
  assert.match(built, /evidence \\"pull_request\\" \(an open pull request that has your latest commit\): there's no open pull request for ao\/issue-1/);
  assert.match(built, /handoff field \\"status\\" is missing: pass fields.status/);

  const checked = toolResults("GREET_ONE", "ROLE_CHECK");
  assert.match(checked, /evidence \\"approval\\".*you haven't submitted a verdict in this task/);
  assert.match(checked, /evidence \\"tests\\".*no test run seen in this task\. Run a command containing `\.\/check\.sh`/);
  assert.match(checked, /handoff field \\"verified\\" is missing/);
  assert.match(checked, /handoff field \\"risks\\" is missing/);
  assert.match(checked, /the last test run \(`echo bye > HELLO\.md && \.\/check\.sh`\) failed/);
  assert.match(checked, /files changed after the last passing test run \(`git checkout HELLO\.md && \.\/check\.sh`\)/);
  assert.match(checked, /The card will move to \\"Done\\" when you finish/);

  const prompt = model.agentRequests().find((request) => request.prompt.includes("GREET_ONE") && request.prompt.includes("ROLE_CHECK"))!.prompt;
  assert.match(prompt, /- "Done": your approval of the pull request; a test run that passed after your last change \(a command containing `\.\/check\.sh`\); handoff fields: verified, risks/);

  const handoffs = db.listHandoffs("gated", itemId);
  assert.deepEqual(handoffs.map((handoff) => `${handoff.fromColumn}→${handoff.toColumn}`), ["Ready→In review", "In review→Done"]);
  assert.match(handoffs[0]!.note, /Added HELLO\.md\n\n\*\*Status:\*\* Ready for review/);
  assert.match(handoffs[1]!.note, /\*\*Verified:\*\* ran \.\/check\.sh: it passes\n\n\*\*Risks:\*\* none/);
});

test("evidence is checked again before the card moves, so changes after move_to_column keep it in place", async () => {
  fake.addIssue({ number: 2, title: "Late change", body: "CHANGE_AFTER_MOVE", user: { login: "alice" } });
  const itemId = fake.addItem(2);
  await humanMoves(itemId, "Ready");
  await settle(itemId, "In review");
  const tester = db.listTasks({ limit: 20 }).find((task) => task.boardItemId === itemId && task.boardColumn === "In review")!;
  assert.equal(tester.status, "succeeded", tester.error ?? "");
  await h.scheduler.idle();
  assert.deepEqual(fake.items.get(itemId)!.history, ["Ready", "In review"]);
  assert.ok(!db.listHandoffs("gated", itemId).some((handoff) => handoff.toColumn === "Done"));
  const reply = fake.issues.get(2)!.comments.map((comment) => comment.body).join("\n");
  assert.match(reply, /The card stays in \*\*In review\*\*\. The move to \*\*Done\*\* was refused because, by the end of the task:\n- evidence "tests".*files changed after the last passing test run/);
});

test("a work type keeps agents out of a column, and people can still move the card anywhere", async () => {
  fake.addIssue({ number: 3, title: "Fix the docs", body: "DOCS_CARD", user: { login: "alice" }, labels: ["documentation"] });
  const itemId = fake.addItem(3);
  await humanMoves(itemId, "Ready");
  await settle(itemId, "Needs human");

  const prompt = model.agentRequests().find((request) => request.prompt.includes("DOCS_CARD"))!.prompt;
  assert.match(prompt, /move_to_column with one of: "Done", "Needs human"/, "the forbidden column isn't offered");
  assert.match(prompt, /This card is a docs \(label "documentation"\), so it can't go to: "In review"\./);
  assert.match(toolResults("DOCS_CARD", "ROLE_BUILD"), /this card is a docs \(label \\"documentation\\"\), and docs cards can't go to \\"In review\\"/);

  await humanMoves(itemId, "In review");
  await settle(itemId, "In review");
  assert.equal(db.getBoardItem("gated", itemId)!.status, "In review", "a person moved it into the forbidden column");
});

test("rules are validated when a board loads and when it's saved", async () => {
  const boards = (await app.inject({ method: "GET", url: "/api/boards" })).json().boards;
  assert.deepEqual(boards.find((board: { name: string }) => board.name === "gated").errors, []);
  const errors: string[] = boards.find((board: { name: string }) => board.name === "broken").errors;
  for (const expected of [
    /Todo\.evidence: "screenshots" isn't one of pull_request, pushed, tests, review, approval/,
    /Todo\.handoff_required: "mood" isn't one of status, decisions, verified, open_questions, risks, do_not_redo/,
    /Todo\.test_command only applies with evidence: \[tests\]/,
    /Needs human: agents can always move a card to the needs-human column/,
    /work_types\.bugfix: unknown setting "color"/,
    /work_types\.bugfix: give it "labels"/,
    /work_types\.bugfix\.forbid: agents can always move a card to "Needs human"/,
    /work_types\.bugfix\.forbid: "Nowhere" isn't listed under columns/,
  ]) {
    assert.ok(errors.some((error) => expected.test(error)), `${expected} in:\n${errors.join("\n")}`);
  }

  const save = (content: string) => app.inject({ method: "PUT", url: "/api/profiles/file", payload: { path: "boards/new.yaml", content } });
  const bad = await save("project: acme/2\ncolumns:\n  Done: { evidence: [vibes] }\n");
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /Done\.evidence: "vibes" isn't one of/);
  assert.equal((await save("project: acme/2\ncolumns:\n  Done: { agent: coder, role: x }\n")).statusCode, 200, "boards without rules save as before");
  assert.equal((await save("project: acme/2\ncolumns:\n  Done: { evidence: [tests], test_command: make check, handoff_required: [verified] }\n")).statusCode, 200);
  assert.equal((await app.inject({ method: "DELETE", url: "/api/profiles/file?path=boards/new.yaml" })).statusCode, 200);
});
