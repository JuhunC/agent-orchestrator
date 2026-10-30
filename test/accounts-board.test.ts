import assert from "node:assert/strict";
import { after, test } from "node:test";
import { startHarness } from "./harness.ts";

const h = await startHarness({
  "agents/coder/agent.md": "---\nhandle: aorch-coder\ndescription: coder\ngithub:\n  push: false\n  pull_request: false\n  finalize: false\n---\nYou are coder.\n",
  "boards/flow.yaml": "project: acme/1\npoll_seconds: 0\ncolumns:\n  Ready:\n    agent: coder\n    role: ROLE_MOVE\n    moves_to: [Done]\n  Done: {}\n",
});
after(() => h.stop());
const { app, fake, model } = h;
const soon = new Date(Date.now() + 5 * 86_400_000);
fake.userTokens.set("ghp_coder", { login: "coder-bot", id: 501, expires: `${soon.toISOString().slice(0, 19).replace("T", " ")} UTC` });
model.script = (request) =>
  request.step === 0 ? [{ type: "tool_use", id: "", name: "mcp__github__move_to_column", input: { column: "Done", handoff: "Finished" } }] : [{ type: "text", text: "Moved." }];

test("an agent with an account moves its cards as it; a token about to expire is flagged", async () => {
  const saved = (await app.inject({ method: "PUT", url: "/api/agents/coder/github-account", payload: { token: "ghp_coder" } })).json();
  assert.equal(saved.account.expiresAt.slice(0, 10), soon.toISOString().slice(0, 10));
  assert.equal(saved.account.scopes, "repo, project");

  fake.addIssue({ number: 1, title: "Card", body: "x", user: { login: "alice" } });
  const item = fake.addItem(1);
  fake.items.get(item)!.status = "Ready";
  fake.items.get(item)!.history.push("Ready");
  await h.sendWebhook("projects_v2_item", {
    action: "edited",
    sender: { login: "alice", type: "User" },
    organization: { login: "acme" },
    projects_v2_item: { node_id: item, project_node_id: fake.project.id, content_type: "Issue" },
    changes: { field_value: { field_node_id: "F_status", field_type: "single_select" } },
  });
  for (let i = 0; i < 400 && fake.items.get(item)!.status !== "Done"; i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fake.items.get(item)!.status, "Done");
  const moves = fake.requests.filter((request) => request.path === "/graphql" && String(request.body?.query).includes("updateProjectV2ItemFieldValue"));
  assert.deepEqual([...new Set(moves.map((request) => request.actor))], ["coder-bot"], "the card was moved as the agent's account");

  const { checkTokenExpiry } = await import("../src/github/accounts.ts");
  await checkTokenExpiry();
  const incidents = (await app.inject({ method: "GET", url: "/api/incidents" })).json() as { kind: string; message: string }[];
  const warning = incidents.find((incident) => incident.kind === "account_token");
  assert.match(warning!.message, /^coder's GitHub token \(@coder-bot\) expires on \d{4}-\d\d-\d\d, in [45] days\. Register a new one/);
  await checkTokenExpiry();
  assert.equal(((await app.inject({ method: "GET", url: "/api/incidents" })).json() as { kind: string }[]).filter((incident) => incident.kind === "account_token").length, 1, "once a day");
});
