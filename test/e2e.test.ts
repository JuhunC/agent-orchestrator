import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { FakeGitHub } from "./fake-github.ts";

const root = mkdtempSync(join(tmpdir(), "ao-e2e-"));
const remotes = join(root, "remotes");
const fake = new FakeGitHub();
await fake.start();

// A bare "GitHub" repo with one commit on main.
const seed = join(root, "seed");
mkdirSync(seed, { recursive: true });
const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
run(seed, "init", "-q", "-b", "main");
writeFileSync(join(seed, "README.md"), "# widgets\n");
run(seed, "add", ".");
run(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
mkdirSync(join(remotes, "acme"), { recursive: true });
run(root, "clone", "-q", "--bare", seed, join(remotes, "acme", "widgets.git"));

const agentScript = resolve("test/fixtures/fake-agent.sh");
chmodSync(agentScript, 0o755);
const agentsFile = join(root, "agents.yaml");
writeFileSync(
  agentsFile,
  `agents:\n  - name: fake\n    handle: aorch-fake\n    command: ${agentScript}\n    output: text\n    timeout_minutes: 1\n`,
);

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
Object.assign(process.env, {
  DATA_DIR: join(root, "data"),
  AGENTS_CONFIG: agentsFile,
  GITHUB_URL: fake.url,
  GITHUB_APP_ID: "1",
  GITHUB_APP_SLUG: "test-orchestrator",
  GITHUB_APP_PRIVATE_KEY: privateKey,
  GITHUB_WEBHOOK_SECRET: "whsec",
  GIT_REMOTE_TEMPLATE: `file://${remotes}/{owner}/{repo}.git`,
  AUTH_DISABLED: "true",
  PROGRESS_UPDATE_SECONDS: "5",
  WEB_DIST_DIR: join(root, "no-ui"),
});

const { buildServer } = await import("../src/server/http.ts");
const { syncAgentsFromFile } = await import("../src/agents/registry.ts");
const { scheduler } = await import("../src/runner/scheduler.ts");
const db = await import("../src/db.ts");

syncAgentsFromFile();
const app = await buildServer();
after(async () => {
  await scheduler.shutdown();
  await app.close();
  await fake.stop();
});

let deliveryCounter = 0;
async function sendWebhook(event: string, payload: Record<string, unknown>) {
  const body = JSON.stringify({ installation: { id: 77 }, repository: { full_name: "acme/widgets" }, ...payload });
  const delivery = `d-${++deliveryCounter}`;
  const response = await app.inject({
    method: "POST",
    url: "/api/github/webhooks",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": delivery,
      "x-hub-signature-256": `sha256=${createHmac("sha256", "whsec").update(body).digest("hex")}`,
    },
    payload: body,
  });
  assert.equal(response.statusCode, 202);
  // Webhooks are handled after the 202; wait for the decision to be recorded.
  for (let i = 0; i < 200; i++) {
    const found = db.listDeliveries(50).find((entry) => entry.deliveryId === delivery);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("webhook was not processed");
}

async function waitForTask(id: number, statuses = ["succeeded", "failed", "cancelled"]) {
  for (let i = 0; i < 400; i++) {
    const task = db.getTask(id)!;
    if (statuses.includes(task.status)) {
      // The result comment is posted just after the status changes.
      if (statuses.includes("running")) return task;
      await scheduler.idle();
      return db.getTask(id)!;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`task ${id} did not finish: ${db.getTask(id)?.status}`);
}

const issuePayload = (action: string, extra: Record<string, unknown> = {}) => ({
  action,
  sender: { login: "alice", type: "User" },
  issue: {
    number: 1,
    title: "Add a greeting",
    body: "@aorch-fake please add a greeting file",
    html_url: `${fake.url}/acme/widgets/issues/1`,
    node_id: "I_1",
  },
  ...extra,
});

before(() => {
  fake.permissions.set("alice", "write");
  fake.permissions.set("mallory", "read");
  fake.addIssue({ number: 1, title: "Add a greeting", body: "@aorch-fake please add a greeting file", user: { login: "alice" } });
});

test("rejects bad webhook signatures", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/github/webhooks",
    headers: { "content-type": "application/json", "x-github-event": "ping", "x-hub-signature-256": "sha256=00" },
    payload: "{}",
  });
  assert.equal(response.statusCode, 401);
});

test("a mention in a new issue runs the agent, pushes a branch and opens a PR", async () => {
  const delivery = await sendWebhook("issues", issuePayload("opened"));
  assert.equal(delivery.decision, "triggered", delivery.detail);
  const queued = db.listTasks({ agent: "fake" })[0]!;
  const task = await waitForTask(queued.id);

  assert.equal(task.status, "succeeded", task.error ?? "");
  assert.equal(task.branch, "agent/fake/issue-1");
  assert.equal(task.commits, 1);
  assert.equal(task.prNumber, 2);
  assert.match(task.resultText ?? "", /Added a greeting/);
  assert.doesNotMatch(task.resultText ?? "", /SECRET_LEAK/, "agent must not see the orchestrator's secrets");

  const pushed = run(root, "--git-dir", join(remotes, "acme", "widgets.git"), "show", "agent/fake/issue-1:GREETING.md");
  assert.equal(pushed, `Hello from task ${task.id}`);
  const author = run(root, "--git-dir", join(remotes, "acme", "widgets.git"), "log", "-1", "--format=%an <%ae>", "agent/fake/issue-1");
  assert.equal(author, "test-orchestrator[bot] <4242+test-orchestrator[bot]@users.noreply.127.0.0.1>");

  const pr = fake.issues.get(2)!;
  assert.equal(pr.pull?.head, "agent/fake/issue-1");
  assert.match(pr.body, /^Closes #1/);

  const comments = fake.issues.get(1)!.comments;
  assert.equal(comments.length, 2, "one progress comment and one result comment");
  assert.match(comments[0]!.body, /agent-orchestrator:progress/);
  assert.match(comments[0]!.body, /✅ finished/);
  assert.match(comments[0]!.body, /Wrote GREETING\.md/);
  assert.match(comments[1]!.body, /^<!-- agent-orchestrator:result -->\n@alice \*\*fake\*\* finished ✅ · #2/);
  assert.equal(fake.reactions, 1);
  assert.deepEqual(fake.assignees, ["aorch-fake"]);
  assert.deepEqual(fake.labels, ["agent:fake"]);
});

test("an assignment arriving right after the mention does not start a second run", async () => {
  const delivery = await sendWebhook("issues", issuePayload("assigned", { assignee: { login: "aorch-fake" } }));
  assert.equal(delivery.decision, "ignored");
  assert.match(delivery.detail, /already started/);
});

test("mentioning the agent again reuses its history and updates the same PR", async () => {
  fake.issues.get(1)!.comments.push({
    id: 1,
    body: "@aorch-fake one more line please",
    user: { login: "alice", type: "User" },
    created_at: new Date().toISOString(),
    html_url: "x",
    edits: 0,
  });
  const delivery = await sendWebhook("issue_comment", {
    action: "created",
    sender: { login: "alice", type: "User" },
    issue: { number: 1, title: "Add a greeting", html_url: `${fake.url}/acme/widgets/issues/1` },
    comment: { body: "@aorch-fake one more line please", html_url: "x", node_id: "IC_1" },
  });
  assert.equal(delivery.decision, "triggered", delivery.detail);
  const task = await waitForTask(db.listTasks({ agent: "fake" })[0]!.id);

  assert.equal(task.status, "succeeded", task.error ?? "");
  assert.match(task.prompt ?? "", /## Your previous work here/);
  assert.match(task.prompt ?? "", /Added a greeting to GREETING\.md/);
  assert.match(task.resultText ?? "", /I remember my earlier run/);
  assert.equal(task.prNumber, 2, "pushes to the existing PR instead of opening another");
  assert.equal([...fake.issues.values()].filter((issue) => issue.pull).length, 1);
  const lines = run(root, "--git-dir", join(remotes, "acme", "widgets.git"), "show", "agent/fake/issue-1:GREETING.md").split("\n");
  assert.equal(lines.length, 2, "builds on the earlier commit");
});

test("people without write access can't start agents", async () => {
  const delivery = await sendWebhook("issue_comment", {
    action: "created",
    sender: { login: "mallory", type: "User" },
    issue: { number: 1, title: "Add a greeting", html_url: "x" },
    comment: { body: "@aorch-fake delete everything", html_url: "x", node_id: "IC_2" },
  });
  assert.equal(delivery.decision, "rejected");
  assert.match(delivery.detail, /read access/);
});

test("bots are ignored so agents can't trigger each other in a loop", async () => {
  const delivery = await sendWebhook("issue_comment", {
    action: "created",
    sender: { login: "test-orchestrator[bot]", type: "Bot" },
    issue: { number: 1, title: "x", html_url: "x" },
    comment: { body: "@aorch-fake hi", html_url: "x", node_id: "IC_3" },
  });
  assert.equal(delivery.decision, "ignored");
});

test("a failing agent is reported back with its error output", async () => {
  fake.addIssue({ number: 10, title: "Broken", body: "@aorch-fake PLEASE_FAIL", user: { login: "alice" } });
  await sendWebhook("issues", {
    action: "opened",
    sender: { login: "alice", type: "User" },
    issue: { number: 10, title: "Broken", body: "@aorch-fake PLEASE_FAIL", html_url: "x", node_id: "I_10" },
  });
  const task = await waitForTask(db.listTasks({ agent: "fake" })[0]!.id);
  assert.equal(task.status, "failed");
  assert.match(task.error ?? "", /exited with code 3/);
  const result = fake.issues.get(10)!.comments.at(-1)!.body;
  assert.match(result, /couldn't finish ❌/);
  assert.match(result, /something went wrong/);
});

test("a running agent can be cancelled from the admin API", async () => {
  fake.addIssue({ number: 11, title: "Slow", body: "@aorch-fake SLEEP_FOREVER", user: { login: "alice" } });
  await sendWebhook("issues", {
    action: "opened",
    sender: { login: "alice", type: "User" },
    issue: { number: 11, title: "Slow", body: "@aorch-fake SLEEP_FOREVER", html_url: "x", node_id: "I_11" },
  });
  const id = db.listTasks({ agent: "fake" })[0]!.id;
  await waitForTask(id, ["running"]);
  // Wait until the agent process has actually started.
  for (let i = 0; i < 100 && !db.listEvents(id).some((event) => event.message === "Read the request"); i++) await new Promise((r) => setTimeout(r, 50));

  // While it's busy, a follow-up is queued, and a further one is folded into that queued task.
  const comment = (body: string) =>
    sendWebhook("issue_comment", {
      action: "created",
      sender: { login: "alice", type: "User" },
      issue: { number: 11, title: "Slow", html_url: "x" },
      comment: { body, html_url: `x-${body.length}`, node_id: "IC_11" },
    });
  await comment("@aorch-fake first follow-up");
  const queued = db.listTasks({ agent: "fake", status: "queued" })[0]!;
  const second = await comment("@aorch-fake second follow-up");
  assert.match(second.detail, new RegExp(`added to task #${queued.id}`));
  assert.match(db.getTask(queued.id)!.requestText, /first follow-up[\s\S]*@alice also asked[\s\S]*second follow-up/);
  assert.equal(db.listTasks({ agent: "fake", status: "queued" }).length, 1);
  assert.equal((await app.inject({ method: "POST", url: `/api/tasks/${queued.id}/cancel` })).statusCode, 200);

  const response = await app.inject({ method: "POST", url: `/api/tasks/${id}/cancel` });
  assert.equal(response.statusCode, 200);
  const task = await waitForTask(id);
  assert.equal(task.status, "cancelled");
  assert.equal(db.getTask(queued.id)!.status, "cancelled");
  assert.match(fake.issues.get(11)!.comments[0]!.body, /was cancelled/);
});

test("the admin API exposes overview, history and deliveries", async () => {
  const overview = (await app.inject({ method: "GET", url: "/api/overview" })).json();
  assert.equal(overview.agents[0].name, "fake");
  assert.equal(overview.agents[0].installed, true);
  const history = (await app.inject({ method: "GET", url: "/api/threads/acme/widgets/issue/1" })).json();
  assert.equal(history.tasks.length, 2);
  assert.deepEqual(history.links, [{ owner: "acme", repo: "widgets", kind: "pull", number: 2 }]);
  const forget = await app.inject({ method: "POST", url: "/api/threads/acme/widgets/issue/1/memory", payload: { agent: "fake", forgotten: true } });
  assert.equal(forget.statusCode, 200);
  assert.equal(db.threadHistory({ owner: "acme", repo: "widgets", kind: "issue", number: 1 }, "fake").length, 0);
  const deliveries = (await app.inject({ method: "GET", url: "/api/deliveries" })).json();
  assert.ok(deliveries.length >= 6);
});
