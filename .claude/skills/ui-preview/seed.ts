// Fills a preview data folder with tasks, events, usage, schedules, webhooks and incidents.
// Run from the repository root: DATA_DIR=<folder>/data node --disable-warning=ExperimentalWarning .claude/skills/ui-preview/seed.ts
const db = await import(new URL("../../../src/db.ts", import.meta.url).href);

const day = 86_400_000;
const iso = (offset: number) => new Date(Date.now() - offset).toISOString();
const base = { installationId: 77, owner: "acme", repo: "widgets", threadUrl: "https://github.com/acme/widgets/issues/1", requestUrl: "https://github.com/acme/widgets/issues/1#issuecomment-1" };
const titles = ["Fix the login redirect loop", "Add CSV export to reports", "Upgrade to Node 24", "Flaky test in checkout flow", "Dark mode for settings", "Speed up the search index", "Document the webhook API", "Crash when the cart is empty"];
const agents = ["coder", "tester", "analyst", "reviewer"];
const statuses = ["succeeded", "succeeded", "succeeded", "failed", "cancelled", "succeeded"] as const;

function usage(cost: number) {
  const input = Math.round(cost * 120_000);
  const output = Math.round(cost * 9_000);
  return { inputTokens: input, outputTokens: output, cacheReadTokens: input * 4, cacheWriteTokens: Math.round(input / 3), models: { "claude-sonnet-5-5": { inputTokens: input, outputTokens: output, cacheReadTokens: input * 4, cacheWriteTokens: Math.round(input / 3), costUsd: cost } } };
}

let n = 0;
for (let i = 0; i < 46; i++) {
  const agent = agents[i % agents.length]!;
  const number = 10 + (i % 12);
  const task = db.createTask({
    ...base,
    agent,
    threadKind: i % 5 === 0 ? "pull" : "issue",
    threadNumber: number,
    threadTitle: titles[i % titles.length]!,
    threadUrl: `https://github.com/acme/widgets/issues/${number}`,
    triggerKind: i % 7 === 0 ? "schedule" : i % 6 === 0 ? "board" : "mention",
    requestedBy: i % 3 === 0 ? "alice" : "bob",
    requestText: `@aorch-${agent} please look at this: ${titles[i % titles.length]}. Keep the change small and add a test.`,
    board: i % 6 === 0 ? "product" : null,
    boardColumn: i % 6 === 0 ? "Ready" : null,
  });
  const status = statuses[i % statuses.length]!;
  const started = (46 - i) * 0.6 * day;
  const cost = 0.2 + ((i * 37) % 23) / 10;
  db.updateTask(task.id, {
    status,
    startedAt: iso(started),
    finishedAt: iso(started - 9 * 60_000 - i * 20_000),
    createdAt: iso(started + 30_000),
    costUsd: cost,
    usage: usage(cost),
    resultText: status === "succeeded" ? "I fixed the redirect loop by checking the session before redirecting, and added a test for it. Opened a pull request." : null,
    error: status === "failed" ? "The agent stopped: max turns reached (40)." : null,
    prUrl: status === "succeeded" && i % 2 === 0 ? `https://github.com/acme/widgets/pull/${100 + i}` : null,
    prNumber: status === "succeeded" && i % 2 === 0 ? 100 + i : null,
    branch: `agent/${agent}/issue-${number}`,
    baseBranch: "main",
    commits: 2,
    sessionId: "3f2a9c1e-7b6d-4e1a-9c2b-1a2b3c4d5e6f",
    exitCode: status === "succeeded" ? 0 : 1,
    profileVersion: i < 30 ? "a1b2c3d" : "e4f5a6b",
    prompt: "You are coder.\n\n# The request\nPlease look at this.\n\n# Earlier runs on this thread\n(none)\n",
  } as never);
  for (const [kind, message] of [
    ["status", "Workspace ready on `agent/coder/issue-12` (from `main`)"],
    ["tool", "Read src/auth/session.ts"],
    ["tool", "Bash: npm test -- auth"],
    ["text", "The redirect happens before the session is loaded."],
    ["stderr", "npm warn deprecated glob@7"],
    ["github", "Commented on acme/widgets#12"],
  ] as const)
    db.addEvent(task.id, kind, message);
  n++;
}

// One running and two queued.
const running = db.createTask({ ...base, agent: "coder", threadKind: "issue", threadNumber: 42, threadTitle: "Add retries to the webhook sender", threadUrl: "https://github.com/acme/widgets/issues/42", triggerKind: "mention", requestedBy: "alice", requestText: "@aorch-coder add retries with backoff" });
db.updateTask(running.id, { status: "running", startedAt: iso(4 * 60_000), branch: "agent/coder/issue-42", baseBranch: "develop" } as never);
for (const message of ["Workspace ready on `agent/coder/issue-42`", "Read src/webhooks/send.ts", "Edit src/webhooks/send.ts", "Bash: npm test"]) db.addEvent(running.id, "tool", message);
db.addEvent(running.id, "text", "Adding exponential backoff with a cap of 5 attempts.");
for (const number of [43, 44])
  db.createTask({ ...base, agent: number === 43 ? "tester" : "reviewer", threadKind: "issue", threadNumber: number, threadTitle: number === 43 ? "Check the new export" : "Review the API docs", threadUrl: `https://github.com/acme/widgets/issues/${number}`, triggerKind: "mention", requestedBy: "bob", requestText: "please check" });

// Pull request outcomes.
for (let i = 0; i < 12; i++) {
  db.recordPullOpened("acme", "widgets", 200 + i, agents[i % 3]!, `agent/x/${i}`, iso((20 - i) * day));
  if (i < 9) db.setPullState("acme", "widgets", 200 + i, i % 4 === 3 ? "closed" : "merged", iso((19 - i) * day));
}

// Schedules.
db.createSchedule({ agent: "coder", name: "Weekly dependency check", when: "0 9 * * 1", timezone: "Asia/Seoul", owner: "acme", repo: "widgets", installationId: 77, threadKind: "issue", threadNumber: 12, prompt: "Check for outdated dependencies and open one PR.", baseBranch: "develop", enabled: true, source: "ui", fileKey: null, createdBy: "alice", createdByTask: null, nextRunAt: iso(-3 * day), maxRuns: null, endsAt: null, note: null });
db.createSchedule({ agent: "tester", name: "Nightly smoke test", when: "@daily", timezone: "UTC", owner: "acme", repo: "widgets", installationId: 77, threadKind: null, threadNumber: null, prompt: "Run the smoke tests and report.", baseBranch: null, enabled: false, source: "agent", fileKey: null, createdBy: "bob", createdByTask: 3, nextRunAt: null, maxRuns: 10, endsAt: null, note: "Paused after 3 failed runs in a row." });

// Webhooks.
const decisions = ["triggered", "forwarded", "ignored", "rejected", "error"] as const;
for (let i = 0; i < 14; i++)
  db.recordDelivery({ deliveryId: `d-${i}`, event: i % 2 ? "issue_comment" : "issues", action: i % 2 ? "created" : "opened", repo: "acme/widgets", sender: i % 3 ? "alice" : "bob", decision: decisions[i % decisions.length]!, detail: i % 5 === 0 ? "Started coder on acme/widgets#12" : "No agent was mentioned" });

// Incidents and audit.
db.addIncident({ kind: "task_failed", severity: "warning", message: "coder failed twice in a row on acme/widgets#15", taskId: 4, url: null });
db.addIncident({ kind: "loop_guard", severity: "critical", message: "A card on product moved 10 times; sent to Needs human", taskId: null, url: "https://github.com/acme/widgets/issues/18" });
db.addAudit({ login: "alice", role: "admin", action: "PUT /api/settings", detail: '{"paused":true}', status: 200 });
db.addAudit({ login: "bob", role: "viewer", action: "POST /api/tasks", detail: "", status: 403 });

// Board cards.
for (const [i, status] of ["Backlog", "Ready", "In progress", "In review", "Done", "Needs human"].entries())
  db.saveBoardItem({ board: "product", itemId: `item-${i}`, owner: "acme", repo: "widgets", kind: "issue", number: 30 + i, title: titles[i]!, status, moves: i, entries: {} });

db.setSetting("base_branches", JSON.stringify({ "acme/widgets": "develop" }));
console.log(`seeded ${n} finished tasks`);
