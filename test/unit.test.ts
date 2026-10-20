import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "ao-unit-"));

const { extractMentions } = await import("../src/mentions.ts");
const { createAdapter } = await import("../src/agents/adapters.ts");
const { mention, renderProgress, formatDuration } = await import("../src/runner/progress.ts");
const { verifySignature } = await import("../src/server/http.ts");
const { normaliseAgent } = await import("../src/agents/registry.ts");
const { createHmac } = await import("node:crypto");

test("extractMentions finds handles and skips code, quotes, emails and teams", () => {
  const body = [
    "@aorch-claude please fix this, cc @Some-User.",
    "> @quoted-person said something",
    "```",
    "@in-code-block",
    "```",
    "Inline `@in-code` and mail me at me@example.com",
    "Team @acme/reviewers should not count",
    "<!-- @hidden -->",
    "(@paren-user)",
  ].join("\n");
  assert.deepEqual(extractMentions(body).sort(), ["aorch-claude", "paren-user", "some-user"]);
  assert.deepEqual(extractMentions(null), []);
});

test("claude stream-json adapter turns tool calls into steps and keeps the result", () => {
  const adapter = createAdapter("claude-stream-json", "/work/repo");
  const lines = [
    { type: "system", subtype: "init", session_id: "s-1", model: "claude-opus-5-5" },
    { type: "assistant", message: { content: [{ type: "text", text: "Looking at the code" }, { type: "tool_use", name: "Read", input: { file_path: "/work/repo/src/a.ts" } }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/work/repo/src/a.ts" } }] } },
    { type: "result", subtype: "success", is_error: false, result: "Fixed the bug.", session_id: "s-1", total_cost_usd: 0.42 },
  ];
  const events = lines.flatMap((line) => adapter.onLine(JSON.stringify(line)));
  assert.deepEqual(
    events.filter((event) => event.kind === "tool").map((event) => event.message),
    ["Read `src/a.ts`", "Ran `npm test`", "Edited `src/a.ts`"],
  );
  assert.deepEqual(adapter.finish(), { result: "Fixed the bug.", sessionId: "s-1", costUsd: 0.42, isError: false });
});

test("claude adapter understands Cursor CLI tool_call events", () => {
  const adapter = createAdapter("claude-stream-json", "/w");
  const events = adapter.onLine(JSON.stringify({ type: "tool_call", subtype: "started", tool_call: { shellToolCall: { args: { command: "ls -la" } } } }));
  assert.equal(events[0]?.message, "Ran `ls -la`");
  adapter.onLine(JSON.stringify({ type: "result", subtype: "success", result: "done", session_id: "chat-9" }));
  assert.equal(adapter.finish().sessionId, "chat-9");
});

test("codex adapter reads thread id, commands, file changes and the last message", () => {
  const adapter = createAdapter("codex-json", "/w");
  const lines = [
    { type: "thread.started", thread_id: "th-1" },
    { type: "item.started", item: { id: "1", type: "command_execution", command: "bash -lc 'cargo test'" } },
    { type: "item.completed", item: { id: "2", type: "file_change", changes: [{ path: "/w/src/lib.rs", kind: "update" }] } },
    { type: "item.completed", item: { id: "3", type: "agent_message", text: "All tests pass." } },
    { type: "turn.completed", usage: {} },
  ];
  const events = lines.flatMap((line) => adapter.onLine(JSON.stringify(line)));
  assert.deepEqual(events.map((event) => event.message), ["Session started", "Ran `cargo test`", "Edited `src/lib.rs`", "All tests pass."]);
  assert.equal(adapter.finish().sessionId, "th-1");
  assert.equal(adapter.finish().result, "All tests pass.");
});

test("gemini adapter keeps the text after the last tool call as the answer", () => {
  const adapter = createAdapter("gemini-stream-json", "/w");
  const lines = [
    { type: "init", session_id: "g-1", model: "gemini-3" },
    { type: "message", role: "assistant", content: "Let me check.", delta: true },
    { type: "tool_use", tool_name: "run_shell_command", tool_id: "t1", parameters: { command: "ls" } },
    { type: "tool_result", tool_id: "t1", status: "success" },
    { type: "message", role: "assistant", content: "Here is the ", delta: true },
    { type: "message", role: "assistant", content: "answer.", delta: true },
    { type: "result", status: "success" },
  ];
  lines.forEach((line) => adapter.onLine(JSON.stringify(line)));
  assert.deepEqual(adapter.finish(), { result: "Here is the answer.", sessionId: "g-1", costUsd: null, isError: false });
});

test("text adapter treats ::progress:: lines as steps and the rest as the reply", () => {
  const adapter = createAdapter("text", "/w");
  assert.deepEqual(adapter.onLine("::progress:: Cloning"), [{ kind: "tool", message: "Cloning" }]);
  adapter.onLine("Line one");
  adapter.onLine("Line two");
  assert.equal(adapter.finish().result, "Line one\nLine two");
});

test("mention only pings real-looking GitHub logins", () => {
  assert.equal(mention("octocat"), "@octocat");
  assert.equal(mention("admin (token)"), "admin (token)");
});

test("progress comment shows recent steps, the current one, and links the task", () => {
  const agent = normaliseAgent({ name: "claude", handle: "aorch-claude", command: "claude" }, "file") as never;
  const task = { id: 7, requestedBy: "octocat" } as never;
  const steps = Array.from({ length: 20 }, (_, index) => `Step ${index + 1}`);
  const body = renderProgress(agent, task, { phase: "working", steps, latestText: "thinking", startedAt: 0, finishedAt: null, note: "", prNumber: null, prUrl: null }, 65_000);
  assert.match(body, /is working on this · requested by @octocat/);
  assert.match(body, /…5 earlier steps/);
  assert.match(body, /- ⏳ Step 20/);
  assert.match(body, /task #7\]\(http:\/\/localhost:3000\/#\/tasks\/7\)/);
  assert.equal(formatDuration(65_000), "1m 05s");
});

test("webhook signatures are checked over the raw body", () => {
  const body = Buffer.from('{"hello":"world"}');
  const good = `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;
  assert.equal(verifySignature("s3cret", body, good), true);
  assert.equal(verifySignature("s3cret", body, good.replace(/.$/, "0")), false);
  assert.equal(verifySignature("", body, good), false);
});

test("agent definitions are validated", () => {
  assert.throws(() => normaliseAgent({ name: "x", handle: "bad handle", command: "x" }, "ui"), /Invalid handle/);
  assert.throws(() => normaliseAgent({ name: "x", command: "x", output: "xml" }, "ui"), /output must be/);
  const agent = normaliseAgent({ name: "mine", handle: "@aorch-mine", command: "myClaude", args: ["-p", "{prompt}"] }, "ui");
  assert.equal(agent.handle, "aorch-mine");
  assert.equal(agent.openPullRequest, true);
});
