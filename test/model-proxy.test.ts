import assert from "node:assert/strict";
import { after, test } from "node:test";
import { startHarness } from "./harness.ts";

const h = await startHarness({
  "agents/oneoff/agent.md": "---\nhandle: aorch-oneoff\ndescription: oneoff\nlive: false\ngithub:\n  push: false\n  pull_request: false\n  finalize: false\n---\nYou are oneoff.\n",
});
after(() => h.stop());
const { model } = h;

model.script = (request) =>
  request.step === 0
    ? [{ type: "tool_use", id: "", name: "Bash", input: { command: 'echo "KEY=$ANTHROPIC_API_KEY BASE=$ANTHROPIC_BASE_URL"', description: "show the model settings" } }]
    : [{ type: "text", text: "Done." }];

test("agents reach the model service with a session credential; the real key stays in the orchestrator", async () => {
  const task = await h.waitForTask((await h.mentionOnNewIssue(1, "aorch-oneoff", "show the settings")).id);
  assert.equal(task.status, "succeeded", task.error ?? "");
  const shown = JSON.stringify(model.agentRequests().at(-1)!.body.messages).match(/KEY=(\S+) BASE=(http:\/\/127\.0\.0\.1:\d+)/);
  assert.ok(shown, "the agent printed its model settings");
  const [, key, base] = shown;
  assert.match(key!, /^ao-session-/, "the agent's key is a stand-in");
  assert.notEqual(base, model.url, "the agent talks to the orchestrator, not the model service");
  assert.ok(model.apiKeys.length > 0);
  assert.deepEqual([...new Set(model.apiKeys)], ["test-model-key"], "the model service only ever saw the real key");

  // The session ended (live: false), so its key is no longer accepted.
  const after = await fetch(`${base}/v1/messages`, { method: "POST", headers: { "x-api-key": key!, "content-type": "application/json" }, body: "{}" });
  assert.equal(after.status, 401);
  const forged = await fetch(`${base}/v1/messages`, { method: "POST", headers: { "x-api-key": "test-model-key" }, body: "{}" });
  assert.equal(forged.status, 401, "the proxy doesn't accept the real key from agents either");
});
