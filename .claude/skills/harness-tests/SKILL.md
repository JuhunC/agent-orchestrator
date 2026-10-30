---
name: harness-tests
description: Write or run agent-orchestrator tests (test/*.test.ts) with the in-process harness, fake GitHub and fake model. Use before adding or debugging a test, instead of reading the harness files.
---
# Tests

- One file: `node --disable-warning=ExperimentalWarning --test test/<name>.test.ts 2>&1 | grep -v '^{"time"' | grep -E "^✔|^✖|ℹ (pass|fail)|Error|expected|actual"` (logs are JSON lines; filter them out).
- Types: `npm run typecheck` (server and web). Full suite: see the release skill.
- Each file boots its own harness (~2 s, plus ~5–20 s per agent task): put related checks in one file.

## Harness: test/harness.ts
`const h = await startHarness(profiles, env)`, then `after(() => h.stop())`.
- `profiles`: paths under PROFILES_DIR → contents (`"agents/coder/agent.md"`, `"boards/flow.yaml"`). `env` overrides (AUTH_DISABLED is "true" unless set "false").
- Returns `app` (Fastify, `app.inject`), `db` (src/db.ts), `fake`, `model`, `sendWebhook(event, payload, deliveryId?)`, `waitForTask(id)`, `mentionOnNewIssue(n, handle, text)`, `commentMention(n, body)`, `showRemote("branch:path")`, `run(cwd, ...gitArgs)`, `root`, `remotes`, `scheduler`.
- Read-only agent: `---\nhandle: aorch-x\ndescription: x\nlive: false\ngithub:\n  push: false\n  pull_request: false\n  finalize: false\n---\nYou are x.\n`
- Modules loaded after startHarness share its state: `await import("../src/…")`.

## Fake model: test/fake-model.ts
`model.script = (request) => …` answers each agent-loop call. `request.prompt` is the latest user prompt: pick behaviour by a MARKER word in the request, most specific first (a fresh prompt also holds the issue body and earlier requests). `request.step` = tool calls since that prompt; `request.body.model`. Return `[{ type: "tool_use", id: "", name: "mcp__github__<tool>" | "Bash", input }]`, `[{ type: "text", text }]`, or `{ status: 429, error: { type, message } }`. Also `model.agentRequests()`, `model.apiKeys`.
Checking what a tool returned: read the `tool_result` blocks in `request.body.messages`, never the whole JSON (it contains the commands too, so a regex on a command's own text matches).

## Fake GitHub: test/fake-github.ts (acme/widgets, installation 77, project acme/1)
- `fake.addIssue({ number, title, body, user: { login }, parent?, blockedBy? })`, `fake.issues.get(n)!.comments`, `.pull`, `.state`.
- `fake.permissions.set(login, "write")` (alice already has write).
- `fake.userTokens.set("ghp_x", { login, id, name?, expires? })`: requests with that token act as the user; an unknown `ghp_` token gets 401.
- `fake.requests` (`{ method, path, body, actor }`), `fake.reactionsBy`, `fake.repoLabels`, `fake.mergeBranches`, `fake.branchSha`.
- Board card: `const id = fake.addItem(n)`, set `fake.items.get(id)!.status` and push to `.history`, then send a `projects_v2_item` webhook (copy `humanMoves` from test/sub-issues.test.ts).

## Patterns
- Wait for all agents: loop until no queued/running task, then `await h.scheduler.idle()` (`quiet()` in test/sub-issues.test.ts).
- Task log: `GET /api/tasks/:id` → `events[].message`.
- Signed-in calls (AUTH_DISABLED "false"): `db.createSession(id, login, 1)` and cookie `ao_session=${app.signCookie(id)}` (test/roles.test.ts).
- Inside the Docker image only: `test/docker/isolation.docker-test.ts` (`docker build -t ao-test . && docker run --rm -v "$PWD/test:/app/test:ro" ao-test node --test test/docker/isolation.docker-test.ts`).
