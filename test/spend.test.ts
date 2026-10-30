import assert from "node:assert/strict";
import { after, test } from "node:test";
import { startHarness } from "./harness.ts";

const h = await startHarness({
  "agents/coder/agent.md": "---\nhandle: aorch-coder\ndescription: coder\ngithub:\n  push: false\n  pull_request: false\n  finalize: false\n---\nYou are coder.\n",
});
after(() => h.stop());
const { app, db, model } = h;
model.script = () => [{ type: "text", text: "Done." }];
const settings = async () => (await app.inject({ method: "GET", url: "/api/settings" })).json();
const put = (payload: Record<string, unknown>) => app.inject({ method: "PUT", url: "/api/settings", payload });

test("a daily spending limit holds new tasks until it's raised", async () => {
  assert.equal((await put({ spendLimitDailyUsd: 0.000001 })).statusCode, 200);
  const first = await h.waitForTask((await h.mentionOnNewIssue(1, "aorch-coder", "one")).id);
  assert.equal(first.status, "succeeded", first.error ?? "");
  assert.ok((first.costUsd ?? 0) > 0, "the task cost something");

  const status = await settings();
  assert.equal(status.spend.dailyUsd, 0.000001);
  assert.ok(status.spend.today >= first.costUsd!);
  assert.equal(status.spend.blocked.period, "day");
  assert.match(status.spendBlocked, /reaching the \$0\.00 daily limit\. New tasks wait until \d{4}-\d\d-\d\d 00:00 UTC/);

  const waiting = await h.mentionOnNewIssue(2, "aorch-coder", "two");
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(db.getTask(waiting.id)!.status, "queued", "it waits for the limit");

  // Near the limit: a warning, nothing blocked.
  await put({ spendLimitDailyUsd: status.spend.today / 0.9 });
  const near = await settings();
  assert.equal(near.spend.blocked, null);
  assert.match(near.spend.warning, /of today's \$\d+\.\d\d limit/);
  const second = await h.waitForTask(waiting.id);
  assert.equal(second.status, "succeeded", second.error ?? "");

  await put({ spendLimitDailyUsd: null, spendLimitMonthlyUsd: null });
  const cleared = await settings();
  assert.equal(cleared.spend.dailyUsd, null);
  assert.equal(cleared.spendBlocked, null);
});
