import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { ModelRequest } from "./fake-model.ts";
import { startHarness } from "./harness.ts";

const agent = (handle: string, github = "") => `---\nhandle: ${handle}\ndescription: ${handle}\n${github ? `github:\n${github}` : ""}---\nYou are ${handle}.\n`;

const h = await startHarness(
  {
    "agents/coder/agent.md": agent("aorch-coder"),
    "agents/plain/agent.md": agent("aorch-plain", "  push: false\n  pull_request: false\n  finalize: false\n"),
    "agents/envy/agent.md": agent("aorch-envy", "  push: false\n  pull_request: false\n  finalize: false\n  account_token_env: ENVY_TOKEN\n"),
  },
  { ENVY_TOKEN: "ghp_envy" },
);
after(() => h.stop());
const { app, db, fake, model } = h;
fake.userTokens.set("ghp_coder", { login: "coder-bot", id: 501, name: "Coder Bot" });
fake.userTokens.set("ghp_envy", { login: "envy-bot", id: 502 });

type Step = { tool: string; input: Record<string, unknown> } | { text: string };
const call = (tool: string, input: Record<string, unknown>): Step => ({ tool: `mcp__github__${tool}`, input });
model.script = (request: ModelRequest) => {
  const steps: Step[] = request.prompt.includes("WRITE_CODE")
    ? [
        { tool: "Bash", input: { command: "echo hello > hello.txt", description: "write" } },
        call("commit_and_push", { message: "Add hello.txt" }),
        call("open_pull_request", { title: "Hello", body: "Adds hello.txt" }),
        call("post_comment", { body: "Opened the PR." }),
        { text: "Done." },
      ]
    : [{ text: "Hi." }];
  const step = steps[Math.min(request.step, steps.length - 1)]!;
  return "tool" in step ? [{ type: "tool_use", id: "", name: step.tool, input: step.input }] : [{ type: "text", text: step.text }];
};

const agents = async () => (await app.inject({ method: "GET", url: "/api/agents" })).json().agents as { name: string; errors: string[]; account: Record<string, unknown> | null }[];
const authors = (number: number) => fake.issues.get(number)!.comments.map((comment) => comment.user.login);

test("an agent registered as a GitHub account comments, opens PRs, reacts and commits as that account", async () => {
  const bad = await app.inject({ method: "PUT", url: "/api/agents/coder/github-account", payload: { token: "ghp_wrong" } });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /GitHub didn't accept the token/);
  const saved = await app.inject({ method: "PUT", url: "/api/agents/coder/github-account", payload: { token: "ghp_coder" } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().account.login, "coder-bot");

  const listed = await app.inject({ method: "GET", url: "/api/agents" });
  assert.doesNotMatch(listed.body, /ghp_coder|ghp_envy/, "tokens never leave the server");
  const byName = Object.fromEntries((await agents()).map((entry) => [entry.name, entry]));
  assert.equal(byName.coder!.account!.login, "coder-bot");
  assert.equal(byName.coder!.account!.source, "ui");
  assert.equal(byName.envy!.account!.login, "envy-bot");
  assert.equal(byName.envy!.account!.source, "env");
  assert.equal(byName.envy!.account!.envVar, "ENVY_TOKEN");
  assert.equal(byName.plain!.account, null);
  const envOnly = await app.inject({ method: "PUT", url: "/api/agents/envy/github-account", payload: { token: "ghp_coder" } });
  assert.equal(envOnly.statusCode, 400);
  assert.match(envOnly.json().error, /account_token_env \(ENVY_TOKEN\), which takes precedence/);

  const task = await h.waitForTask((await h.mentionOnNewIssue(1, "aorch-coder", "WRITE_CODE please")).id);
  assert.equal(task.status, "succeeded", task.error ?? "");
  assert.ok(authors(1).length >= 3, "progress, the agent's comment and the result");
  assert.deepEqual([...new Set(authors(1))], ["coder-bot"], "every comment on the issue is the account's");
  const pr = [...fake.issues.values()].find((issue) => issue.pull?.head === "agent/coder/issue-1")!;
  assert.equal(pr.user.login, "coder-bot");
  assert.ok(fake.reactionsBy.includes("coder-bot"), "the 👀 reaction too");
  assert.equal(h.run(h.root, "--git-dir", `${h.remotes}/acme/widgets.git`, "log", "-1", "--format=%an <%ae>", "agent/coder/issue-1"), "Coder Bot <501+coder-bot@users.noreply.127.0.0.1>");
  const appWrites = fake.requests.filter((request) => request.method !== "GET" && request.actor.endsWith("[bot]") && /\/issues\/1\/|\/pulls/.test(request.path));
  assert.deepEqual(appWrites, [], "nothing on the issue or its PR was done as the App");

  const checked = (await app.inject({ method: "POST", url: "/api/agents/coder/github-account/check", payload: { repository: "acme/secret" } })).json();
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.repositories, [
    { repository: "acme/secret", access: "none" },
    { repository: "acme/widgets", access: "write" },
  ]);
});

test("what the orchestrator did as an account is ignored; what a person does with it, and mentions of it, count", async () => {
  fake.addIssue({ number: 2, title: "Issue 2", body: "x", user: { login: "alice" } });
  fake.permissions.set("coder-bot", "write");
  const comment = (sender: string, body: string, id: string) =>
    h.sendWebhook("issue_comment", {
      action: "created",
      sender: { login: sender, type: "User" },
      issue: { number: 2, title: "Issue 2", html_url: `${fake.url}/acme/widgets/issues/2` },
      comment: { body, html_url: `${fake.url}/c/${id}`, node_id: `IC_${id}` },
    });

  // The agent's own comment (it carries the orchestrator's mark) mentioning another agent: ignored.
  const own = await comment("coder-bot", "@aorch-plain please look\n\n<!-- agent-orchestrator -->", "1");
  assert.equal(own.decision, "ignored");
  assert.equal(own.detail, "Made by agent coder as @coder-bot");

  // A person typing with that same account (say it's their own): handled like anyone's comment.
  const typed = await comment("coder-bot", "@aorch-plain please look", "2");
  assert.equal(typed.decision, "triggered", typed.detail);
  await h.waitForTask(db.listTasks({ limit: 1 })[0]!.id);

  // Mentioning the account starts the agent that acts as it, like its handle.
  const byAccount = await comment("alice", "@envy-bot can you check this?", "3");
  assert.equal(byAccount.decision, "triggered", byAccount.detail);
  const started = db.listTasks({ limit: 1 })[0]!;
  assert.equal(started.agent, "envy");
  await h.waitForTask(started.id);

  // The orchestrator's other changes as the account (here: the issue it just commented on) are its echo.
  const labeled = await h.sendWebhook("issues", { action: "labeled", sender: { login: "envy-bot", type: "User" }, label: { name: "x" }, issue: { number: 2, title: "Issue 2", body: "x", html_url: `${fake.url}/acme/widgets/issues/2`, node_id: "I_2" } });
  assert.equal(labeled.detail, "Made by agent envy as @envy-bot");
  const elsewhere = await h.sendWebhook("issues", { action: "assigned", sender: { login: "envy-bot", type: "User" }, assignee: { login: "envy-bot" }, issue: { number: 77, title: "Issue 77", body: "x", html_url: `${fake.url}/acme/widgets/issues/77`, node_id: "I_77" } });
  assert.notEqual(elsewhere.detail, "Made by agent envy as @envy-bot", "an issue it didn't touch: a person assigned it");
});

test("agents without an account act as the App; an env account works; removing one goes back to the App", async () => {
  const plain = await h.waitForTask((await h.mentionOnNewIssue(3, "aorch-plain", "say hi")).id);
  assert.equal(plain.status, "succeeded", plain.error ?? "");
  assert.deepEqual([...new Set(authors(3))], ["test-orchestrator[bot]"]);

  const envy = await h.waitForTask((await h.mentionOnNewIssue(4, "aorch-envy", "say hi")).id);
  assert.equal(envy.status, "succeeded", envy.error ?? "");
  assert.deepEqual([...new Set(authors(4))], ["envy-bot"]);

  assert.equal((await app.inject({ method: "DELETE", url: "/api/agents/coder/github-account" })).statusCode, 200);
  assert.equal((await agents()).find((entry) => entry.name === "coder")!.account, null);
  const again = await h.waitForTask((await h.commentMention(1, "@aorch-coder say hi")).id);
  assert.equal(again.status, "succeeded", again.error ?? "");
  assert.equal(fake.issues.get(1)!.comments.at(-1)!.user.login, "test-orchestrator[bot]");

  // A token that stops working fails the task with a reason; it doesn't fall back to the App.
  await app.inject({ method: "PUT", url: "/api/agents/coder/github-account", payload: { token: "ghp_coder" } });
  fake.userTokens.delete("ghp_coder");
  const broken = await h.waitForTask((await h.commentMention(1, "@aorch-coder once more")).id);
  assert.equal(broken.status, "failed");
  assert.match(broken.error ?? "", /acts on GitHub as @coder-bot: check that this account can access acme\/widgets/);
  assert.equal(db.getTask(broken.id)!.progressCommentId, null, "no progress comment as the App");
});
