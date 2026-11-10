import assert from "node:assert/strict";
import { after, test } from "node:test";
import { startHarness } from "./harness.ts";

const agent = (handle: string) => `---\nhandle: ${handle}\ndescription: x\nlive: false\ngithub:\n  push: false\n  pull_request: false\n  finalize: false\n---\nYou are ${handle}.\n`;
const h = await startHarness({ "agents/coder/agent.md": agent("aorch-coder"), "agents/helper/agent.md": agent("aorch-helper") });
after(() => h.stop());
const { app, db, fake, model } = h;
model.script = () => [{ type: "text", text: "Done." }];
fake.permissions.set("chatty-bot", "write");
for (const number of [1, 2, 3]) fake.addIssue({ number, title: `Issue ${number}`, body: "x", user: { login: "alice" } });

type Users = { users: { login: string; addedBy: string; addedAt: string }[] };
const logins = (response: { json: () => unknown }) => (response.json() as Users).users.map((user) => user.login);
const comment = (number: number, login: string, body: string) =>
  h.sendWebhook("issue_comment", {
    action: "created",
    sender: { login, type: "User" },
    issue: { number, title: `Issue ${number}`, html_url: `${fake.url}/acme/widgets/issues/${number}` },
    comment: { body, html_url: `${fake.url}/c/${Math.random()}`, node_id: "IC", user: { login } },
  });
const bodies = (number: number) => fake.issues.get(number)!.comments.map((entry) => entry.body);

test("the blocked users list has a REST API: add, replace, remove", async () => {
  assert.deepEqual((await app.inject({ url: "/api/blocked-users" })).json(), { users: [] });
  const added = await app.inject({ method: "POST", url: "/api/blocked-users", payload: { login: "@Chatty-Bot" } });
  assert.equal(added.statusCode, 200);
  assert.deepEqual(logins(added), ["Chatty-Bot"]);
  assert.equal((added.json() as Users).users[0]!.addedBy, "dev");
  assert.equal((await app.inject({ method: "POST", url: "/api/blocked-users", payload: { login: "not a login!" } })).statusCode, 400);
  assert.deepEqual(logins(await app.inject({ method: "POST", url: "/api/blocked-users", payload: { login: "chatty-bot" } })), ["Chatty-Bot"], "logins are case-insensitive");

  assert.deepEqual(logins(await app.inject({ method: "PUT", url: "/api/blocked-users", payload: { users: ["chatty-bot", "other-bot", "other-bot"] } })), ["Chatty-Bot", "other-bot"]);
  assert.equal((await app.inject({ method: "PUT", url: "/api/blocked-users", payload: { users: ["fine", "bad login"] } })).statusCode, 400);
  assert.equal((await app.inject({ method: "PUT", url: "/api/blocked-users", payload: { users: "chatty-bot" } })).statusCode, 400);
  assert.deepEqual(logins(await app.inject({ url: "/api/blocked-users" })), ["Chatty-Bot", "other-bot"], "a bad request changes nothing");

  assert.deepEqual(logins(await app.inject({ method: "DELETE", url: "/api/blocked-users/other-bot" })), ["Chatty-Bot"]);
  assert.equal((await app.inject({ method: "DELETE", url: "/api/blocked-users/other-bot" })).statusCode, 404);
});

test("agents a blocked account calls say so once per thread, without mentioning it, and don't start", async () => {
  const before = db.listTasks({ limit: 100 }).length;
  const first = await comment(1, "chatty-bot", "@aorch-coder @aorch-helper what do you think?");
  assert.equal(first.decision, "rejected");
  assert.match(first.detail, /^chatty-bot is blocked; coder replied that it's blocked; helper replied that it's blocked$/);
  assert.equal(db.listTasks({ limit: 100 }).length, before, "no task");
  assert.equal(bodies(1).length, 2);
  assert.match(bodies(1)[0]!, /^🚫 \*\*coder\*\* won't respond: `chatty-bot` is blocked from calling agents here/);
  assert.match(bodies(1)[1]!, /^🚫 \*\*helper\*\* won't respond/);
  for (const body of bodies(1)) assert.doesNotMatch(body, /@chatty-bot/);

  // It answers back: nothing more is said on this thread.
  const again = await comment(1, "chatty-bot", "@aorch-coder but why?");
  assert.match(again.detail, /coder already said so here/);
  assert.equal(bodies(1).length, 2);

  // Another thread gets its one reply.
  await comment(2, "chatty-bot", "@aorch-coder hello");
  assert.equal(bodies(2).length, 1);
  assert.equal(db.listTasks({ limit: 100 }).length, before);
});

test("what a blocked account says doesn't reach an agent already working on the thread", async () => {
  await app.inject({ method: "PUT", url: "/api/settings", payload: { paused: true } });
  const task = db.createTask({
    agent: "coder", installationId: 77, owner: "acme", repo: "widgets", threadKind: "issue", threadNumber: 3, threadTitle: "Issue 3", threadUrl: "", triggerKind: "manual", requestedBy: "alice", requestText: "x", requestUrl: "",
  });
  db.updateTask(task.id, { status: "running" });
  try {
    const blocked = await comment(3, "chatty-bot", "an opinion nobody asked for");
    assert.equal(blocked.decision, "rejected");
    assert.match(blocked.detail, new RegExp(`not passed to coder \\(task #${task.id}\\)`));
    assert.equal((await comment(3, "alice", "a real note")).decision, "forwarded");
    const log = db.listEvents(task.id).map((event) => event.message).join("\n");
    assert.match(log, /@alice/);
    assert.doesNotMatch(log, /chatty-bot/);
  } finally {
    db.updateTask(task.id, { status: "cancelled" });
    await app.inject({ method: "PUT", url: "/api/settings", payload: { paused: false } });
  }
});

test("once unblocked, the account starts agents again; blocked again, agents tell it again", async () => {
  await app.inject({ method: "DELETE", url: "/api/blocked-users/chatty-bot" });
  const started = await comment(1, "chatty-bot", "@aorch-coder please look");
  assert.equal(started.decision, "triggered", started.detail);
  const task = await h.waitForTask(db.listTasks({ limit: 1 })[0]!.id);
  assert.equal(task.status, "succeeded", task.error ?? "");
  assert.equal(task.requestedBy, "chatty-bot");

  await app.inject({ method: "POST", url: "/api/blocked-users", payload: { login: "chatty-bot" } });
  const count = bodies(1).length;
  assert.match((await comment(1, "chatty-bot", "@aorch-coder thanks!")).detail, /coder replied that it's blocked/);
  assert.equal(bodies(1).length, count + 1);
});
