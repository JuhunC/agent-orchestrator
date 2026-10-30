import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import { startHarness } from "./harness.ts";

const h = await startHarness(
  { "agents/coder/agent.md": "---\nhandle: aorch-coder\ndescription: coder\n---\nYou are coder.\n" },
  { AUTH_DISABLED: "false", ADMIN_USERS: "alice", OPERATOR_USERS: "olga", VIEWER_USERS: "vic" },
);
after(() => h.stop());
const { app, db } = h;
const as = (login: string) => {
  const id = randomBytes(18).toString("base64url");
  db.createSession(id, login, 1);
  return { cookie: `ao_session=${(app as unknown as { signCookie: (value: string) => string }).signCookie(id)}` };
};
const call = (login: string, method: "GET" | "PUT" | "POST" | "DELETE", url: string, payload?: unknown) => app.inject({ method, url, headers: as(login), ...(payload ? { payload } : {}) });

test("viewers only look, operators run the queue, admins change anything", async () => {
  assert.equal((await call("vic", "GET", "/api/auth/me")).json().role, "viewer");
  assert.equal((await call("vic", "GET", "/api/overview")).statusCode, 200);
  const refused = await call("vic", "PUT", "/api/settings", { paused: true });
  assert.equal(refused.statusCode, 403);
  assert.match(refused.json().error, /^Viewers can look but not change anything/);

  assert.equal((await call("olga", "PUT", "/api/settings", { paused: true })).statusCode, 200, "operators pause the queue");
  assert.equal((await call("olga", "PUT", "/api/settings", { paused: false })).statusCode, 200);
  assert.equal((await call("olga", "POST", "/api/agents/coder/enabled", { enabled: false })).statusCode, 200);
  assert.equal((await call("olga", "PUT", "/api/settings", { maxConcurrent: 5 })).statusCode, 403, "but don't configure it");
  assert.equal((await call("olga", "PUT", "/api/profiles/file", { path: "agents/coder/agent.md", content: "x" })).statusCode, 403);
  assert.equal((await call("olga", "PUT", "/api/agents/coder/github-account", { token: "ghp_x" })).statusCode, 403);

  assert.equal((await call("alice", "PUT", "/api/settings", { maxConcurrent: 3 })).statusCode, 200);
  assert.equal((await call("alice", "PUT", "/api/agents/coder/github-account", { token: "ghp_unknown" })).statusCode, 400);
  assert.equal((await call("mallory", "GET", "/api/overview")).statusCode, 401, "a session for someone no longer listed doesn't work");
  assert.equal((await app.inject({ method: "GET", url: "/api/overview" })).statusCode, 401);

  const log = (await call("vic", "GET", "/api/audit")).json() as { login: string; role: string; action: string; detail: string; status: number }[];
  const rows = log.map((row) => `${row.login} (${row.role}) ${row.action} ${row.status}: ${row.detail}`).reverse();
  assert.deepEqual(rows, [
    "vic (viewer) PUT /api/settings 403: refused: paused: true",
    "olga (operator) PUT /api/settings 200: paused: true",
    "olga (operator) PUT /api/settings 200: paused: false",
    "olga (operator) POST /api/agents/coder/enabled 200: enabled: false",
    "olga (operator) PUT /api/settings 403: refused: maxConcurrent: 5",
    'olga (operator) PUT /api/profiles/file 403: refused: path: "agents/coder/agent.md", content: "x"',
    "olga (operator) PUT /api/agents/coder/github-account 403: refused: token: (hidden)",
    "alice (admin) PUT /api/settings 200: maxConcurrent: 3",
    "alice (admin) PUT /api/agents/coder/github-account 400: token: (hidden)",
  ]);
});
