import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "ao-unit-"));

const { extractMentions } = await import("../src/mentions.ts");
const { describeTool } = await import("../src/runtime/describe.ts");
const { parseFrontmatter } = await import("../src/profiles/loader.ts");
const { normaliseMcpServers, expandMcpServers } = await import("../src/profiles/mcp.ts");
const { detectUsageLimit } = await import("../src/runner/limits.ts");
const { serverErrorOf } = await import("../src/runtime/session.ts");
const { mention, renderProgress, formatDuration } = await import("../src/runner/progress.ts");
const { verifySignature } = await import("../src/server/http.ts");
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

test("mention only pings real-looking GitHub logins", () => {
  assert.equal(mention("octocat"), "@octocat");
  assert.equal(mention("admin (token)"), "admin (token)");
});

test("progress comment shows recent steps, the current one, and links the task", () => {
  const agent = { name: "claude" };
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

test("tool calls are described for people", () => {
  const rel = (path: unknown) => String(path).replace("/w/", "");
  assert.equal(describeTool("Bash", { command: "npm test" }, rel), "Ran `npm test`");
  assert.equal(describeTool("Edit", { file_path: "/w/src/a.ts" }, rel), "Edited `src/a.ts`");
  assert.equal(describeTool("mcp__github__commit_and_push", {}, rel), "Committing and pushing");
  assert.equal(describeTool("mcp__linear__create_issue", {}, rel), "Used linear.create_issue");
  assert.equal(describeTool("Agent", { subagent_type: "test-writer", description: "add tests" }, rel), "Asked the test-writer subagent: add tests");
});

test("profile frontmatter and MCP definitions are parsed and validated", () => {
  const { data, body } = parseFrontmatter("---\nhandle: aorch-x\nskills: [a, b]\n---\nYou are X.\n");
  assert.deepEqual(data, { handle: "aorch-x", skills: ["a", "b"] });
  assert.equal(body, "You are X.");
  const servers = normaliseMcpServers('{"mcpServers": {"docs": {"command": "npx", "args": ["docs"], "env": {"T": "${TOKEN}"}}, "web": {"url": "https://x.test/mcp", "headers": {"A": "Bearer ${TOKEN}"}}}}');
  assert.deepEqual(expandMcpServers(servers, { TOKEN: "s" }).web, { type: "http", url: "https://x.test/mcp", headers: { A: "Bearer s" }, command: undefined, args: undefined, env: undefined });
  assert.throws(() => normaliseMcpServers({ github: { command: "x" } }), /reserved/);
  assert.throws(() => normaliseMcpServers({ bad: {} }), /needs a "command"/);
});

test("usage-limit messages are recognised with their reset time", () => {
  const now = new Date("2026-10-20T12:00:00Z");
  assert.equal(detectUsageLimit("Claude AI usage limit reached|1761000000", now)?.resetAt?.toISOString(), "2025-10-20T22:40:00.000Z");
  assert.equal(detectUsageLimit("You've hit your limit · resets 3pm (America/Los_Angeles)", now)?.resetAt?.toISOString(), "2026-10-20T22:00:00.000Z");
  assert.equal(detectUsageLimit("API Error: 429 try again in 2 hours 13 minutes. rate_limit_error", now)?.resetAt?.toISOString(), "2026-10-20T14:13:00.000Z");
  assert.equal(detectUsageLimit("Failed to authenticate. API Error: 401", now), null);
});

test("server-side model errors are told apart from client errors", () => {
  assert.match(serverErrorOf("API Error: 503 upstream unavailable", []) ?? "", /503/);
  assert.match(serverErrorOf("API Error: Connection error.", []) ?? "", /Connection error/);
  assert.ok(serverErrorOf("something failed", ["overloaded"]));
  assert.equal(serverErrorOf("API Error: 400 prompt is not allowed here", []), null);
  assert.equal(serverErrorOf("API Error: 401 invalid x-api-key", ["authentication_failed"]), null);
});
