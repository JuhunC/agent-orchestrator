// Runs inside the Docker image (see .github/workflows/deploy.yml), where agents run as the
// separate `agent` user: an agent's shell must not reach the orchestrator's data.
//   docker build -t ao-test . && docker run --rm -v "$PWD/test:/app/test:ro" ao-test \
//     node --disable-warning=ExperimentalWarning --test test/docker/isolation.docker-test.ts
import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { after, test } from "node:test";
import { startHarness } from "../harness.ts";

const h = await startHarness({ "agents/coder/agent.md": "---\nhandle: aorch-coder\ndescription: c\ngithub:\n  pull_request: false\n---\nYou are coder.\n" });
after(() => h.stop());
chmodSync(h.root, 0o711); // mkdtemp makes it private; folders above DATA_DIR must let the agent through
const { setupIsolation } = await import("../../src/runtime/isolation.ts");

const probe = [
  'D="$(git rev-parse --show-toplevel)/../../../../.."',
  'echo WHO=$(id -un)',
  'cat "$D/admin-token" 2>&1 | head -1',
  'ls "$D" 2>&1 | head -1',
  'cat "$D/orchestrator.db" > /dev/null 2>&1 && echo DB_READABLE || echo DB_BLOCKED',
  'for p in $(pgrep -u node); do cat /proc/$p/environ > /dev/null 2>&1 && echo READ_ENV_OF_$p; done; echo ENV_PROBE_DONE',
  'echo hi > made-by-agent.txt && mkdir -p sub && echo x > sub/y.txt && echo WROTE_OK',
].join("; ");
h.model.script = (request) => {
  const steps = request.prompt.includes("again")
    ? [{ type: "text", text: "Second run." }]
    : [
        { type: "tool_use", id: "", name: "Bash", input: { command: probe, description: "probe" } },
        { type: "tool_use", id: "", name: "mcp__github__commit_and_push", input: { message: "Agent files" } },
        { type: "text", text: "Done." },
      ];
  return [steps[Math.min(request.step, steps.length - 1)]!] as never;
};

test("agents run as the agent user and can't read the orchestrator's data", async () => {
  const status = await setupIsolation();
  assert.equal(status.problem, null);
  assert.equal(status.mode, "sudo");
  const task = await h.waitForTask((await h.mentionOnNewIssue(1, "aorch-coder", "probe")).id);
  assert.equal(task.status, "succeeded", task.error ?? "");
  // Only what the commands printed (tool results), not the commands themselves.
  const results: string[] = [];
  for (const request of h.model.agentRequests()) {
    for (const message of request.body.messages as { content: unknown }[]) {
      for (const block of Array.isArray(message.content) ? (message.content as Record<string, any>[]) : []) {
        if (block.type !== "tool_result") continue;
        results.push(typeof block.content === "string" ? block.content : (block.content ?? []).map((part: { text?: string }) => part.text ?? "").join(""));
      }
    }
  }
  const out = [...new Set(results)].join("\n---\n");

  assert.match(out, /WHO=agent/);
  assert.match(out, /admin-token: Permission denied/);
  assert.match(out, /DB_BLOCKED/);
  assert.doesNotMatch(out, /READ_ENV_OF_/);
  assert.match(out, /WROTE_OK/);
  assert.equal(h.showRemote("agent/coder/issue-1:made-by-agent.txt"), "hi");
  assert.equal(h.showRemote("agent/coder/issue-1:sub/y.txt"), "x");
  const again = await h.waitForTask((await h.commentMention(1, "@aorch-coder again")).id);
  assert.equal(again.status, "succeeded", again.error ?? "");
});
