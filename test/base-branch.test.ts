import assert from "node:assert/strict";
import { after, test } from "node:test";
import { join } from "node:path";
import type { ModelRequest } from "./fake-model.ts";
import { startHarness } from "./harness.ts";

const agent = (name: string, extra = "") => `---\nhandle: aorch-${name}\ndescription: ${name}\nlive: false\n${extra}---\nYou are ${name}.\n`;
const h = await startHarness({
  "agents/coder/agent.md": agent("coder"),
  "agents/releaser/agent.md": agent("releaser", "github:\n  base_branch:\n    acme/widgets: release\n    default: develop\n"),
  "agents/broken/agent.md": agent("broken", "github:\n  base_branch: ao/issue-1\n"),
  "boards/flow.yaml": `project: acme/1
poll_seconds: 0
base_branch: develop
columns:
  Todo: {}
  Ready: { agent: releaser, role: implement it, moves_to: [Done] }
  Done: {}
`,
  "boards/bad.yaml": `project: acme/1
poll_seconds: 0
base_branch: { "not a repo": x, default: "has space" }
columns:
  Todo: {}
`,
});
after(() => h.stop());
const { app, db, fake, model } = h;

// Three long-lived branches, each a commit ahead of main, so a checkout shows where it started.
const remote = join(h.remotes, "acme", "widgets.git");
const git = (...args: string[]) => h.run(h.root, "--git-dir", remote, ...args);
const tips: Record<string, string> = {};
for (const branch of ["develop", "release", "staging"]) {
  tips[branch] = git("commit-tree", "main^{tree}", "-p", "main", "-m", `${branch} line`);
  git("update-ref", `refs/heads/${branch}`, tips[branch]!);
}

model.script = (request: ModelRequest) => {
  const name = request.prompt.match(/WRITE (\w+)/)?.[1] ?? "x";
  const steps = [
    { type: "tool_use" as const, id: "", name: "Bash", input: { command: `echo ${name} > ${name}.txt`, description: "write" } },
    { type: "tool_use" as const, id: "", name: "mcp__github__commit_and_push", input: { message: `Add ${name}` } },
    { type: "tool_use" as const, id: "", name: "mcp__github__open_pull_request", input: { title: name, body: name } },
    { type: "text" as const, text: "Done." },
  ];
  return [steps[Math.min(request.step, steps.length - 1)]!];
};

/** Runs a task to the end and returns it with its pull request's base and whether its branch started from `from`. */
async function finished(id: number) {
  const task = await h.waitForTask(id);
  assert.equal(task.status, "succeeded", task.error ?? "");
  assert.ok(task.prNumber, "opened a pull request");
  const pull = fake.issues.get(task.prNumber!)!;
  return { task, base: pull.pull!.base, body: pull.body ?? "", startsFrom: (branch: string) => git("merge-base", "--is-ancestor", tips[branch]!, task.branch!) === "" };
}
// The fake numbers a new pull request one past the highest issue, so issues here are 10 apart.
const prompt = (marker: string) => model.agentRequests().find((request) => request.prompt.includes(marker))?.prompt ?? "";
const put = (repo: string, branch: string | null) => app.inject({ method: "PUT", url: "/api/base-branches", payload: { repo, branch } });

test("base_branch is checked where it's written", async () => {
  const { parseBaseBranch, branchNameProblem, pickBase } = await import("../src/github/branches.ts");
  const errors: string[] = [];
  assert.deepEqual(parseBaseBranch("develop", "base_branch", errors), { all: "develop", repos: {} });
  const map = parseBaseBranch({ "Acme/Widgets": "release", default: "develop" }, "base_branch", errors)!;
  assert.equal(pickBase(map, "acme", "widgets"), "release");
  assert.equal(pickBase(map, "acme", "other"), "develop");
  assert.deepEqual(errors, []);
  for (const bad of ["has space", "a..b", "-x", "x.lock", "refs/heads/x", "ao/issue-3", "agent/coder/issue-1", "x/"]) assert.ok(branchNameProblem(bad), bad);
  assert.equal(branchNameProblem("release/2026.11"), null);

  const boards = (await app.inject({ method: "GET", url: "/api/boards" })).json() as { boards: { name: string; baseBranch: string | null; errors: string[] }[] };
  assert.equal(boards.boards.find((board) => board.name === "flow")!.baseBranch, "develop");
  const bad = boards.boards.find((board) => board.name === "bad")!;
  assert.ok(bad.errors.some((error) => /"not a repo" isn't a repository/.test(error)), bad.errors.join("; "));
  assert.ok(bad.errors.some((error) => /base_branch.default: "has space" isn't a valid branch name/.test(error)), bad.errors.join("; "));
  const agents = (await app.inject({ method: "GET", url: "/api/agents" })).json() as { agents: { name: string; baseBranch: string | null; errors: string[] }[] };
  assert.equal(agents.agents.find((entry) => entry.name === "releaser")!.baseBranch, "acme/widgets → release, otherwise develop");
  assert.match(agents.agents.find((entry) => entry.name === "broken")!.errors.join(";"), /github.base_branch: "ao\/issue-1" is one of the orchestrator's own work branches/);
});

test("without a setting pull requests go into the default branch; a repository setting changes that", async () => {
  const plain = await finished((await h.mentionOnNewIssue(10, "aorch-coder", "WRITE plain")).id);
  assert.equal(plain.base, "main");
  assert.doesNotMatch(plain.body, /into `/);

  assert.match((await put("acme/widgets", "nope")).json().error, /acme\/widgets has no branch `nope`/);
  assert.match((await put("acme/widgets", "a..b")).json().error, /isn't a valid branch name/);
  const set = await put("acme/widgets", "staging");
  assert.equal(set.statusCode, 200, set.body);
  assert.deepEqual(set.json().repos, [{ repo: "acme/widgets", branch: "staging" }]);
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/base-branches/resolve?agent=coder&repo=acme/widgets" })).json(), { branch: "staging", from: "for acme/widgets in Settings" });

  const staged = await finished((await h.mentionOnNewIssue(20, "aorch-coder", "WRITE staged")).id);
  assert.equal(staged.base, "staging");
  assert.ok(staged.startsFrom("staging"), "the branch starts from staging");
  assert.match(staged.body, /Closes #20 · into `staging` \(the base branch set for acme\/widgets in Settings\)/);
  assert.match(prompt("WRITE staged"), /goes into `staging` \(the base branch set for acme\/widgets in Settings\), not the default branch `main`/);
  assert.ok((await app.inject({ method: "GET", url: `/api/tasks/${staged.task.id}` })).json().events.some((event: { message: string }) => /work goes into `staging`/.test(event.message)));
});

test("an agent's setting beats the repository's, and a board's beats the agent's", async () => {
  const own = await finished((await h.mentionOnNewIssue(30, "aorch-releaser", "WRITE released")).id);
  assert.equal(own.base, "release", "github.base_branch names acme/widgets");
  assert.ok(own.startsFrom("release"));

  fake.addIssue({ number: 40, title: "Board work", body: "WRITE boarded", user: { login: "alice" } });
  const itemId = fake.addItem(40, "Todo");
  db.saveBoardItem({ board: "flow", itemId, owner: "acme", repo: "widgets", kind: "issue", number: 40, title: "Board work", status: "Todo", moves: 0, entries: {} });
  const item = fake.items.get(itemId)!;
  item.status = "Ready";
  item.history.push("Ready");
  await h.sendWebhook("projects_v2_item", {
    action: "edited",
    sender: { login: "alice", type: "User" },
    organization: { login: "acme" },
    projects_v2_item: { node_id: itemId, project_node_id: fake.project.id, content_type: "Issue" },
    changes: { field_value: { field_node_id: "F_status", field_type: "single_select" } },
  });
  const boardTask = db.listTasks({ limit: 1 })[0]!;
  assert.equal(boardTask.board, "flow");
  const boarded = await finished(boardTask.id);
  assert.equal(boarded.base, "develop", "the board's base_branch wins over releaser's");
  assert.ok(boarded.startsFrom("develop"));
  assert.match(boarded.body, /the base branch set on the flow board/);
});

test("a run started in the admin UI can name its own base branch, and a retry keeps it", async () => {
  fake.addIssue({ number: 50, title: "Run here", body: "x", user: { login: "alice" } });
  const missing = await app.inject({ method: "POST", url: "/api/tasks", payload: { agent: "coder", repo: "acme/widgets", number: 50, instruction: "WRITE manual", baseBranch: "nope" } });
  assert.equal(missing.statusCode, 400);
  assert.match(missing.json().error, /has no branch `nope`/);
  const started = await app.inject({ method: "POST", url: "/api/tasks", payload: { agent: "coder", repo: "acme/widgets", number: 50, instruction: "WRITE manual", baseBranch: "release" } });
  const manual = await finished(started.json().id);
  assert.equal(manual.task.requestedBase, "release");
  assert.equal(manual.base, "release", "the run's choice beats the repository's staging");
  assert.match(manual.body, /the base branch set when this run was started/);

  const retry = (await app.inject({ method: "POST", url: `/api/tasks/${manual.task.id}/retry` })).json();
  assert.equal(retry.requestedBase, "release");
  await h.waitForTask(retry.id);
});

test("a schedule's runs go into its base branch", async () => {
  fake.addIssue({ number: 60, title: "Scheduled", body: "x", user: { login: "alice" } });
  const body = { agent: "coder", name: "Nightly", when: "0 3 1 1 *", repo: "acme/widgets", number: 60, prompt: "WRITE nightly" };
  const refused = await app.inject({ method: "POST", url: "/api/schedules", payload: { ...body, baseBranch: "nope" } });
  assert.match(refused.json().error, /has no branch `nope`/);
  const schedule = (await app.inject({ method: "POST", url: "/api/schedules", payload: { ...body, baseBranch: "develop" } })).json();
  assert.equal(schedule.baseBranch, "develop");
  const run = (await app.inject({ method: "POST", url: `/api/schedules/${schedule.id}/run` })).json();
  const nightly = await finished(run.task);
  assert.equal(nightly.task.requestedBase, "develop");
  assert.equal(nightly.base, "develop");
  assert.match(nightly.body, /the base branch set on schedule "Nightly"/);
  const overview = (await app.inject({ method: "GET", url: "/api/base-branches" })).json();
  assert.deepEqual(overview.boards, [{ name: "flow", branch: "develop" }]);
  assert.ok(overview.schedules.some((entry: { name: string; branch: string }) => entry.name === "Nightly" && entry.branch === "develop"));
  await app.inject({ method: "DELETE", url: `/api/schedules/${schedule.id}` });
});

test("a sub-issue still goes into its parent's branch, which starts from the base branch", async () => {
  fake.addIssue({ number: 70, title: "Parent", body: "x", user: { login: "alice" } });
  fake.addIssue({ number: 71, title: "Child", body: "@aorch-coder WRITE child", user: { login: "alice" }, parent: 70 });
  const child = await finished((await h.commentMention(71, "@aorch-coder WRITE child")).id);
  assert.equal(child.base, "ao/issue-70");
  assert.equal(git("rev-parse", "refs/heads/ao/issue-70"), tips.staging, "the parent's branch was cut from staging, not main");
  assert.match(child.body, /part of #70 \(merges into `ao\/issue-70`, the parent issue's branch\)/);
});

test("merging an agent's pull request into a base branch closes its issue; GitHub does it for the default branch", async () => {
  const merged = (number: number, base: string) =>
    h.sendWebhook("pull_request", {
      action: "closed",
      sender: { login: "alice", type: "User" },
      repository: { full_name: "acme/widgets", default_branch: "main" },
      pull_request: { number, merged: true, merged_at: new Date().toISOString(), title: "x", body: fake.issues.get(number)!.body, html_url: "x", node_id: `PR_${number}`, base: { ref: base }, head: { ref: "x" } },
    });
  const intoMain = db.listTasks({ limit: 100 }).find((task) => task.threadNumber === 10)!.prNumber!;
  const intoStaging = db.listTasks({ limit: 100 }).find((task) => task.threadNumber === 20)!.prNumber!;
  await merged(intoMain, "main");
  await merged(intoStaging, "staging");
  for (let i = 0; i < 200 && fake.issues.get(20)!.state !== "closed"; i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fake.issues.get(20)!.state, "closed");
  assert.ok(fake.issues.get(20)!.comments.some((comment) => /pull request #\d+ was merged into `staging`/.test(comment.body)));
  assert.notEqual(fake.issues.get(10)!.state, "closed", "left to GitHub");
});

test("a base branch deleted after it was set fails the task with a clear message", async () => {
  const { setRepoBaseBranch } = await import("../src/runtime/base-branch.ts");
  setRepoBaseBranch("acme/widgets", "gone");
  const task = await h.waitForTask((await h.mentionOnNewIssue(80, "aorch-coder", "WRITE gone")).id);
  assert.equal(task.status, "failed");
  assert.match(task.error ?? "", /The base branch `gone` \(set for acme\/widgets in Settings\) isn't in acme\/widgets/);
  assert.equal((await put("acme/widgets", null)).json().repos.length, 0);
});
