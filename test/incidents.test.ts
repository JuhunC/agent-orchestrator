import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";

// A chat tool's incoming webhook, standing in for Slack or Discord.
const alerts: Record<string, unknown>[] = [];
const receiver = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    alerts.push(JSON.parse(body));
    res.end("ok");
  });
});
await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
const alertUrl = `http://127.0.0.1:${(receiver.address() as { port: number }).port}/hook`;

const { startHarness } = await import("./harness.ts");
const h = await startHarness(
  { "agents/coder/agent.md": "---\nhandle: aorch-coder\ndescription: coder\nlive: false\ngithub:\n  push: false\n  pull_request: false\n  finalize: false\n---\nYou are coder.\n" },
  { ALERT_WEBHOOK_URL: alertUrl, METRICS_TOKEN: "m3trics" },
);
after(async () => {
  await h.stop();
  receiver.close();
});
const { app, model } = h;
model.script = () => ({ status: 400, error: { type: "invalid_request_error", message: "prompt is too long" } });
const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(check());
};

test("problems are recorded, shown, posted to the alert webhook and counted in /metrics", async () => {
  const task = await h.waitForTask((await h.mentionOnNewIssue(1, "aorch-coder", "do it")).id);
  assert.equal(task.status, "failed");
  const forged = await app.inject({ method: "POST", url: "/api/github/webhooks", headers: { "content-type": "application/json", "x-github-event": "issues", "x-github-delivery": "x", "x-hub-signature-256": "sha256=00" }, payload: "{}" });
  assert.equal(forged.statusCode, 401);

  const incidents = (await app.inject({ method: "GET", url: "/api/incidents" })).json() as { kind: string; severity: string; message: string; taskId: number | null }[];
  assert.deepEqual(incidents.map((incident) => incident.kind), ["webhook_signature", "task_failed"]);
  assert.match(incidents[1]!.message, /^coder failed on acme\/widgets#1: /);
  assert.equal(incidents[1]!.taskId, task.id);
  assert.equal((await app.inject({ method: "GET", url: "/api/overview" })).json().incidents.length, 2);

  await waitFor(() => alerts.length === 2);
  const failed = alerts.find((alert) => alert.kind === "task_failed")!;
  assert.match(String(failed.text), /^🟠 Agent Orchestrator: coder failed on acme\/widgets#1: .* http:\/\/localhost:3000\/#\/tasks\/\d+$/);
  assert.equal(failed.content, failed.text, "Discord reads `content`");

  assert.equal((await app.inject({ method: "GET", url: "/metrics" })).statusCode, 401);
  const metrics = await app.inject({ method: "GET", url: "/metrics", headers: { authorization: "Bearer m3trics" } });
  assert.equal(metrics.statusCode, 200);
  assert.match(metrics.headers["content-type"] as string, /^text\/plain/);
  assert.match(metrics.body, /^ao_tasks_total\{agent="coder",status="failed"\} 1$/m);
  assert.match(metrics.body, /^ao_incidents_total\{kind="task_failed"\} 1$/m);
  assert.match(metrics.body, /^ao_tasks_running 0$/m);
  assert.match(metrics.body, /^# TYPE ao_spend_today_usd gauge$/m);
});
