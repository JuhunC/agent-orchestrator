import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { ModelRequest } from "./fake-model.ts";
import { startHarness } from "./harness.ts";

const agent = (handle: string) => `---\nhandle: ${handle}\ndescription: x\nlive: false\ngithub:\n  push: false\n  pull_request: false\n  finalize: false\n---\nYou are ${handle}.\n`;
const h = await startHarness({ "agents/coder/agent.md": agent("aorch-coder"), "agents/reviewer/agent.md": agent("aorch-reviewer") });
after(() => h.stop());
const { app, db, model } = h;
model.script = (request: ModelRequest) => [{ type: "text", text: request.prompt.includes('You are "reviewer"') ? "REVIEW: looks right, one nit." : "CODER: added the retry in client.ts." }];

const promptOf = (id: number) => db.getTask(id)!.prompt ?? "";

test("an agent is told what other agents did on the thread, and what they've done since its last run", async () => {
  const first = await h.waitForTask((await h.mentionOnNewIssue(1, "aorch-coder", "add a retry")).id);
  assert.equal(first.status, "succeeded", first.error ?? "");
  assert.doesNotMatch(promptOf(first.id), /Other agents/, "nobody else has been here yet");

  // The reviewer, new to the thread, gets the coder's run: who, how it ended, what it said.
  const review = await h.waitForTask((await h.commentMention(1, "@aorch-reviewer please review")).id);
  assert.equal(review.status, "succeeded", review.error ?? "");
  const reviewPrompt = promptOf(review.id);
  assert.match(reviewPrompt, /## Other agents' work here/);
  assert.match(reviewPrompt, new RegExp(`### coder — run ${first.id}, .* UTC on issue #1 \\(succeeded\\)\\nAsked by @alice: .*add a retry`));
  assert.match(reviewPrompt, /Its reply began:\n> CODER: added the retry in client\.ts\./);
  assert.doesNotMatch(reviewPrompt, /## Your previous work here/);
  assert.ok(reviewPrompt.indexOf("## Other agents' work here") < reviewPrompt.indexOf("## How to reply"));

  // The coder's session already knows the thread: its follow-up prompt has only what's new, the review included.
  const second = await h.waitForTask((await h.commentMention(1, "@aorch-coder fix the nit")).id);
  assert.equal(second.status, "succeeded", second.error ?? "");
  const followUp = promptOf(second.id);
  assert.match(followUp, /## Other agents here since your last run/);
  assert.match(followUp, new RegExp(`### reviewer — run ${review.id}, [\\s\\S]*> REVIEW: looks right, one nit\\.`));
  assert.doesNotMatch(followUp, new RegExp(`### coder — run ${first.id}`));

  // The task page lists the same runs, newest first.
  const page = (await app.inject({ url: `/api/tasks/${review.id}` })).json() as { others: { id: number; agent: string; status: string }[] };
  assert.deepEqual(page.others.map((other) => [other.id, other.agent, other.status]), [[second.id, "coder", "succeeded"], [first.id, "coder", "succeeded"]]);
  assert.equal(((await app.inject({ url: `/api/tasks/${review.id}?after=0` })).json() as { others?: unknown }).others, undefined, "not sent again with each log update");
});

test("an agent that's working on the thread now is named as such", async () => {
  const { buildPrompt } = await import("../src/agents/prompt.ts");
  const running = { ...db.getTask(1)!, id: 99, agent: "tester", status: "running" as const, finishedAt: null, resultText: null };
  const thread = { kind: "issue" as const, number: 1, title: "t", body: "b", url: "u", author: "alice", state: "open", nodeId: "I", databaseId: 1, defaultBranch: "main", relations: { parent: null, subIssues: [], blockedBy: [], blocking: [] }, comments: [], reviewComments: [], pull: null };
  const prompt = buildPrompt({ agent: { name: "coder", handle: "aorch-coder" }, task: db.getTask(1)!, thread, history: [], others: [running], workspace: { branch: "x", baseBranch: "main", canPush: true, willPush: false } });
  assert.match(prompt, /### tester — working on it now on issue #1 \(task 99\)/);
});
