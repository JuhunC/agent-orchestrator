import assert from "node:assert/strict";
import { after, test } from "node:test";
import { startHarness } from "./harness.ts";

const h = await startHarness(
  {
    "agents/coder/agent.md": "---\nhandle: aorch-coder\ndescription: coder\nmax_budget_usd: 5\n---\nYou are coder.\n",
    "boards/flow.yaml": "project: acme/1\npoll_seconds: 0\nlimits:\n  entries_per_column: 4\n  max_running: 2\ncolumns:\n  Doing:\n    agent: coder\n    role: work\n  Done: {}\n",
  },
  { MAX_AGENT_CHAIN: "2", SPEND_LIMIT_DAILY_USD: "40" },
);
after(() => h.stop());
const { app, db } = h;
const { chainDepth } = await import("../src/runtime/related-agents.ts");

test("the agent chain counts agents starting agents, also through board moves", () => {
  const make = (triggerKind: "mention" | "agent" | "board", startedByTask: number | null) =>
    db.createTask({ agent: "coder", installationId: 77, owner: "acme", repo: "widgets", threadKind: "issue", threadNumber: 9, threadTitle: "", threadUrl: "", triggerKind, requestedBy: "x", requestText: "", requestUrl: "", startedByTask });
  const person = make("mention", null);
  const woken = make("agent", person.id);
  const moved = make("board", woken.id); // woken moved its card; the next column's agent
  const movedAgain = make("board", moved.id);
  const wokenAgain = make("agent", movedAgain.id);
  assert.deepEqual([person, woken, moved, movedAgain, wokenAgain].map(chainDepth), [0, 1, 1, 1, 2]);
});

test("Settings lists every loop guard, per board and per agent", async () => {
  const guards = (await app.inject({ method: "GET", url: "/api/guards" })).json();
  const byName = Object.fromEntries(guards.global.map((guard: { name: string; value: string }) => [guard.name, guard.value]));
  assert.equal(byName["Agents starting agents"], "2");
  assert.equal(byName["Spending per day"], "$40");
  assert.equal(byName["Pull requests per issue"], "no limit");
  assert.deepEqual(guards.boards, [{ name: "flow", movesPerIssue: 10, entriesPerColumn: 4, budgetUsdPerIssue: null, maxRunning: 2, needsHuman: "Needs human" }]);
  assert.deepEqual(guards.agents, [{ name: "coder", maxBudgetUsd: 5, maxTurns: null, timeoutMinutes: null, replicas: null }]);
  assert.deepEqual(guards.recent, []);
});
