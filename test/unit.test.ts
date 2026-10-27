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
const { EVIDENCE, HANDOFF_FIELDS, isTestCommand, NO_RULES, parseBoardRules, renderHandoff, workTypeFor } = await import("../src/boards/rules.ts");
const { CONFIG_DOCS } = await import("../src/profiles/reference.ts");
const { GITHUB_DEFAULTS } = await import("../src/profiles/loader.ts");
const { EFFORTS } = await import("../src/profiles/types.ts");
const { parentBranchFor } = await import("../src/runtime/workspace.ts");
const { describeRelations, NO_RELATIONS, toIssueRef } = await import("../src/github/relations.ts");

test("board rules: common test runners count as test runs, and handoff fields render in order", () => {
  for (const command of ["npm test", "npm run test -- --watch=false", "pnpm test", "node --test test/", "python -m pytest -q", "pytest", "go test ./...", "cargo test", "./gradlew check", "make test"]) {
    assert.ok(isTestCommand(NO_RULES, command), command);
  }
  for (const command of ["cat test.txt", "npm install", "git status", "echo latest"]) assert.ok(!isTestCommand(NO_RULES, command), command);
  assert.ok(isTestCommand({ ...NO_RULES, testCommands: ["scripts/ci.sh"] }, "bash scripts/ci.sh --fast"));
  assert.ok(!isTestCommand({ ...NO_RULES, testCommands: ["scripts/ci.sh"] }, "npm test"), "a column's own command replaces the defaults");

  assert.equal(renderHandoff("Did it.", { risks: "none", verified: "ran it\nand read it", status: "  " }), "Did it.\n\n**Verified:**\nran it\nand read it\n\n**Risks:** none");
  assert.equal(renderHandoff("Plain note", {}), "Plain note");
  const types = [{ name: "bugfix", labels: ["Bug"], forbid: [] }, { name: "docs", labels: ["documentation"], forbid: [] }];
  assert.equal(workTypeFor(types, ["documentation", "bug"])?.type.name, "bugfix", "the first type in the file wins");
  assert.equal(workTypeFor(types, ["enhancement"]), null);
});

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

test("board sub_issues settings are validated", () => {
  const columns = { Backlog: {}, Ready: {}, Done: {} };
  assert.deepEqual(parseBoardRules({ columns, sub_issues: { column: "Backlog", moves_to: ["Ready", "Needs human", "Ready"] } }).subIssues, { column: "Backlog", movesTo: ["Ready", "Needs human"] });
  assert.deepEqual(parseBoardRules({ columns }).subIssues, { column: null, movesTo: [] });
  assert.deepEqual(parseBoardRules({ columns, sub_issues: { column: "Nowhere", moves_to: ["Later"], auto: true } }).errors, [
    'sub_issues: unknown setting "auto" (use column and moves_to)',
    'sub_issues.column: "Nowhere" isn\'t listed under columns',
    'sub_issues.moves_to: "Later" isn\'t listed under columns',
  ]);
  assert.deepEqual(parseBoardRules({ columns, sub_issues: ["Ready"] }).errors, ['"sub_issues" must be a map with "column" and/or "moves_to"']);
  assert.deepEqual(parseBoardRules({ columns: { Done: { evidence: ["merged", "sub_issues"] } } }).errors, []);
});

test("board fields (start/end dates, estimate) are validated", () => {
  const columns = { Ready: {}, Done: {} };
  assert.deepEqual(parseBoardRules({ columns, fields: { start: "Start date", end: "End date", estimate: "Estimate", start_on: ["Ready"], end_on: ["Done", "Done"] } }).fields, {
    start: "Start date",
    end: "End date",
    estimate: "Estimate",
    startOn: ["Ready"],
    endOn: ["Done"],
  });
  assert.deepEqual(parseBoardRules({ columns }).fields, { start: null, end: null, estimate: null, startOn: [], endOn: [] });
  assert.deepEqual(parseBoardRules({ columns, fields: { end: "Target", estimate: "target", start_on: ["Ready"], end_on: ["Later"], due: "x" } }).errors, [
    'fields: unknown setting "due" (use start, end, estimate, start_on, end_on)',
    "fields: start, end and estimate must be different project fields",
    "fields.start_on needs fields.start (the project's date field)",
    'fields.end_on: "Later" isn\'t listed under columns',
  ]);
  assert.deepEqual(parseBoardRules({ columns, fields: { start: 3 } }).errors, ['fields.start: give the name of a field in the project, e.g. "Start date"']);
});

test("a sub-issue's branch is its parent's, unless the agent turns it off or the parent doesn't qualify", () => {
  const issue = (number: number, extra: Record<string, unknown> = {}) =>
    toIssueRef({ id: 1000 + number, number, title: `#${number}`, state: "open", html_url: `https://github.com/acme/widgets/issues/${number}`, repository_url: "https://api.github.com/repos/acme/widgets", ...extra });
  const thread = (parent: ReturnType<typeof issue> | null, kind = "issue") => ({ kind, relations: { ...NO_RELATIONS, parent } }) as never;
  const on = { github: { parentBranch: true } } as never;
  const task = { owner: "acme", repo: "widgets" };
  assert.equal(parentBranchFor(on, thread(issue(7)), task), "ao/issue-7");
  assert.equal(parentBranchFor({ github: { parentBranch: false } } as never, thread(issue(7)), task), null);
  assert.equal(parentBranchFor(on, thread(issue(7, { state: "closed" })), task), null, "a closed parent's branch is done with");
  assert.equal(parentBranchFor(on, thread(issue(7, { repository_url: "https://api.github.com/repos/acme/other" })), task), null, "another repository's branch can't be a base");
  assert.equal(parentBranchFor(on, thread(null), task), null);
  assert.deepEqual(describeRelations({ ...NO_RELATIONS, parent: issue(7), blockedBy: [issue(9, { repository_url: "https://api.github.com/repos/acme/other" })] }, "acme", "widgets"), [
    '- Parent: #7 "#7" (open)',
    '- Blocked by: acme/other#9 "#9" (open)',
  ]);
});

test("the options reference covers every GitHub permission, evidence kind, handoff field and effort", () => {
  const options = (id: string) => CONFIG_DOCS.find((doc) => doc.id === id)!.options;
  const agentKeys = options("agent").map((option) => option.key);
  for (const key of Object.keys(GITHUB_DEFAULTS)) assert.ok(agentKeys.includes(`github.${key}`), `github.${key} is documented`);
  for (const option of options("agent").filter((candidate) => candidate.key.startsWith("github."))) {
    assert.equal(option.default, String(GITHUB_DEFAULTS[option.key.slice(7) as keyof typeof GITHUB_DEFAULTS]), `${option.key}'s documented default`);
  }
  const board = options("board");
  assert.deepEqual(board.find((option) => option.key === "columns.<name>.evidence")!.values, EVIDENCE);
  assert.deepEqual(board.find((option) => option.key === "columns.<name>.handoff_required")!.values, HANDOFF_FIELDS);
  assert.deepEqual(options("agent").find((option) => option.key === "effort")!.values, EFFORTS);
  for (const doc of CONFIG_DOCS) {
    assert.equal(new Set(doc.options.map((option) => option.key)).size, doc.options.length, `${doc.id} lists each option once`);
    for (const option of doc.options) assert.ok(option.description.trim(), `${doc.id} ${option.key} has a description`);
  }
  const match = (path: string) => CONFIG_DOCS.filter((doc) => new RegExp(doc.pattern).test(path)).map((doc) => doc.id);
  assert.deepEqual(match("agents/coder/agent.md"), ["agent"]);
  assert.deepEqual(match("agents/coder/skills/ship/SKILL.md"), ["skill"]);
  assert.deepEqual(match("library/skills/ship/SKILL.md"), ["skill"]);
  assert.deepEqual(match("library/skills/ship/notes.md"), []);
  assert.deepEqual(match("boards/product.yaml"), ["board"]);
  assert.deepEqual(match("groups/devs.yml"), ["group"]);
});
