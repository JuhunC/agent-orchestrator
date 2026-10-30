import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { ModelRequest } from "./fake-model.ts";
import { startHarness } from "./harness.ts";

const agent = (handle: string, extra = "") =>
  `---\nhandle: ${handle}\ndescription: ${handle}\nlive: false\ngithub:\n  push: false\n  pull_request: false\n  finalize: false\n${extra}---\nYou are ${handle}.\n`;

const h = await startHarness({
  "agents/reporter/agent.md": agent("aorch-reporter"),
  "agents/quiet/agent.md": agent("aorch-quiet", "can_schedule: false\n"),
  "agents/nightly/agent.md": agent(
    "aorch-nightly",
    `schedules:
  - name: Nightly check
    when: "0 3 1 1 *"
    repo: acme/widgets
    prompt: NIGHTLY_CHECK look around
`,
  ),
  "agents/broken/agent.md": agent(
    "aorch-broken",
    `schedules:
  - name: Too often
    when: "*/5 * * * *"
    repo: acme/widgets
    prompt: x
`,
  ),
});
after(() => h.stop());
const { app, db, fake, model } = h;
const { runDueSchedules } = await import("../src/schedules/runner.ts");
const { listIncidents } = await import("../src/db.ts");

type Step = { tool: string; input: Record<string, unknown> } | { text: string };
const call = (name: string, input: Record<string, unknown> = {}): Step => ({ tool: `mcp__github__${name}`, input });
let scheduleId = 0;
const SCRIPTS: [string, () => Step[]][] = [
  ["DAILY_REPORT", () => [call("create_schedule", { name: "More", when: "@daily", prompt: "x" }), call("list_schedules"), call("delete_schedule", { id: scheduleId }), { text: "Reported, and stopped the schedule." }]],
  [
    "MAKE_SCHEDULE",
    () => [
      call("create_schedule", { name: "Too often", when: "*/5 * * * *", prompt: "x" }),
      call("create_schedule", { name: "Weekday report", when: "0 9 * * 1-5", timezone: "Asia/Seoul", prompt: "DAILY_REPORT summarize what changed" }),
      { text: "Set up." },
    ],
  ],
  ["NIGHTLY_CHECK", () => [{ text: "Nothing new tonight." }]],
];
model.script = (request: ModelRequest) => {
  const steps = SCRIPTS.find(([marker]) => request.prompt.includes(marker))?.[1]() ?? [{ text: "OK" }];
  const step = steps[Math.min(request.step, steps.length - 1)]!;
  return "tool" in step ? [{ type: "tool_use", id: "", name: step.tool, input: step.input }] : [{ type: "text", text: step.text }];
};

/** What the tools answered in the agent's requests that contain `marker`. */
function toolResults(marker: string): string[] {
  const texts: string[] = [];
  for (const request of model.agentRequests().filter((candidate: ModelRequest) => candidate.prompt.includes(marker))) {
    for (const message of request.body.messages ?? []) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block.type !== "tool_result") continue;
        const text = Array.isArray(block.content) ? block.content.map((part: { text?: string }) => part.text ?? "").join("") : String(block.content ?? "");
        if (!texts.includes(text)) texts.push(text);
      }
    }
  }
  return texts;
}

const later = (iso: string) => new Date(Date.parse(iso) + 1000);

test("an agent sets up its own schedule when asked, and its runs come round", async () => {
  const asked = await h.mentionOnNewIssue(1, "aorch-reporter", "MAKE_SCHEDULE every weekday at 9 Seoul time, tell me what changed");
  assert.equal((await h.waitForTask(asked.id)).status, "succeeded");
  const results = toolResults("MAKE_SCHEDULE");
  assert.ok(results.some((text) => /may run at most every 15 minutes/.test(text)), results.join("\n"));
  assert.ok(results.some((text) => /Created #\d+ "Weekday report" runs every weekday at 09:00 Asia\/Seoul/.test(text)), results.join("\n"));

  const [schedule] = db.listSchedules({ agent: "reporter" });
  assert.ok(schedule, "one schedule");
  assert.equal(db.listSchedules({ agent: "reporter" }).length, 1, "the too-frequent one was refused");
  assert.equal(schedule.source, "agent");
  assert.equal(schedule.createdBy, "alice");
  assert.equal(schedule.createdByTask, asked.id);
  assert.equal(schedule.threadNumber, 1);
  assert.equal(schedule.threadKind, "issue");
  assert.equal(new Date(schedule.nextRunAt!).getUTCHours(), 0, "09:00 in Seoul is midnight UTC");
  assert.ok([1, 2, 3, 4, 5].includes(new Date(schedule.nextRunAt!).getUTCDay()), "a weekday");
  scheduleId = schedule.id;

  // Its time comes: a run starts on #1 with the schedule's request.
  const due = schedule.nextRunAt!;
  await runDueSchedules(later(due));
  const runAfter = db.getSchedule(schedule.id)!;
  assert.equal(runAfter.runs, 1);
  assert.ok(runAfter.nextRunAt! > due, "the next run moved on");
  const run = db.getTask(runAfter.lastTaskId!)!;
  assert.equal(run.triggerKind, "schedule");
  assert.equal(run.scheduleId, schedule.id);
  assert.equal(run.threadNumber, 1);

  // The run is still going when the next one is due: that one is skipped, not stacked up.
  await runDueSchedules(later(runAfter.nextRunAt!));
  const skipped = db.getSchedule(schedule.id)!;
  assert.equal(skipped.runs, 1);
  assert.match(skipped.note ?? "", /Skipped .*the last run \(task #\d+\) was still going/);

  // The run knows it's a scheduled run, can't make more schedules, and deletes this one.
  assert.equal((await h.waitForTask(run.id)).status, "succeeded");
  const prompt = db.getTask(run.id)!.prompt ?? "";
  assert.match(prompt, /scheduled run of "Weekday report"/);
  assert.match(prompt, /## This schedule/);
  assert.match(prompt, /set up by you, when @alice asked/);
  assert.match(prompt, /delete_schedule \(id \d+\)/);
  assert.ok(toolResults("DAILY_REPORT").some((text) => /A scheduled run can't make more schedules/.test(text)));
  assert.equal(db.getSchedule(schedule.id), null, "the agent deleted it");
  assert.equal(db.listSchedules({ agent: "reporter" }).length, 0);
  assert.match(fake.issues.get(1)!.comments.at(-1)!.body, /Reported, and stopped the schedule/);
});

test("an agent with can_schedule: false gets no schedule tools", async () => {
  const task = await h.mentionOnNewIssue(2, "aorch-quiet", "QUIET_ASK hello");
  assert.equal((await h.waitForTask(task.id)).status, "succeeded");
  const request = model.agentRequests().find((candidate: ModelRequest) => candidate.prompt.includes("QUIET_ASK"))!;
  const tools = (request.body.tools ?? []).map((tool: { name: string }) => tool.name);
  assert.ok(tools.includes("mcp__github__get_thread"), tools.join(", "));
  assert.ok(!tools.some((name: string) => name.includes("schedule")), tools.join(", "));
  const reporter = model.agentRequests().find((candidate: ModelRequest) => candidate.prompt.includes("MAKE_SCHEDULE"))!;
  assert.ok((reporter.body.tools ?? []).some((tool: { name: string }) => tool.name === "mcp__github__create_schedule"));
});

test("schedules in agent.md open an issue on their first run and keep it", async () => {
  const list = await app.inject({ method: "GET", url: "/api/schedules?agent=nightly" });
  const schedules = list.json().schedules;
  assert.equal(schedules.length, 1);
  const nightly = schedules[0];
  assert.equal(nightly.source, "file");
  assert.equal(nightly.description, "on day 1 of January at 03:00 UTC");
  assert.equal(nightly.threadNumber, null);
  const agents = (await app.inject({ method: "GET", url: "/api/agents" })).json().agents;
  assert.match(agents.find((candidate: { name: string }) => candidate.name === "broken").errors.join("\n"), /schedules\[0\] \(Too often\) runs every 5 minutes/);
  assert.equal((await app.inject({ method: "GET", url: "/api/schedules?agent=broken" })).json().schedules.length, 0, "a bad entry isn't loaded");

  await runDueSchedules(later(nightly.nextRunAt));
  const ran = db.getSchedule(nightly.id)!;
  assert.ok(ran.threadNumber, "an issue was opened");
  const issue = fake.issues.get(ran.threadNumber!)!;
  assert.equal(issue.title, "Nightly check");
  assert.match(issue.body, /works here on a schedule: on day 1 of January at 03:00 UTC/);
  assert.match(issue.body, /<!-- agent-orchestrator -->/, "the orchestrator recognises its own issue");
  assert.equal((await h.waitForTask(ran.lastTaskId!)).status, "succeeded");
  assert.match(issue.comments.at(-1)!.body, /Nothing new tonight/);
  assert.match(db.getTask(ran.lastTaskId!)!.prompt ?? "", /set up by your agent\.md[\s\S]*Only a person can change or stop this schedule/);

  // Reloading the file keeps the issue; the UI may pause it but not change or delete it.
  await app.inject({ method: "GET", url: "/api/schedules" });
  assert.equal(db.getSchedule(nightly.id)!.threadNumber, ran.threadNumber);
  assert.equal((await app.inject({ method: "PATCH", url: `/api/schedules/${nightly.id}`, payload: { name: "Renamed" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/schedules/${nightly.id}` })).statusCode, 400);
  const paused = await app.inject({ method: "PATCH", url: `/api/schedules/${nightly.id}`, payload: { enabled: false } });
  assert.equal(paused.statusCode, 200, paused.body);
  assert.equal(paused.json().enabled, false);
  assert.equal(paused.json().nextRunAt, null);
});

test("people make, run, change and delete schedules in the admin UI", async () => {
  fake.addIssue({ number: 5, title: "Weekly digest", body: "", user: { login: "alice" } });
  const tooOften = await app.inject({ method: "POST", url: "/api/schedules", payload: { agent: "reporter", name: "x", when: "every 5m", repo: "acme/widgets", number: 5, prompt: "x" } });
  assert.equal(tooOften.statusCode, 400);
  assert.match(tooOften.json().error, /SCHEDULE_MIN_MINUTES/);
  const missing = await app.inject({ method: "POST", url: "/api/schedules", payload: { agent: "reporter", name: "x", when: "@daily", repo: "acme/widgets", number: 404, prompt: "x" } });
  assert.equal(missing.statusCode, 400);
  assert.match(missing.json().error, /no issue or pull request #404/);

  const preview = (await app.inject({ method: "GET", url: `/api/schedules/preview?when=${encodeURIComponent("0 8 * * 1")}&timezone=Europe/Paris` })).json();
  assert.equal(preview.description, "every Monday at 08:00 Europe/Paris");
  assert.equal(preview.upcoming.length, 3);
  assert.match((await app.inject({ method: "GET", url: "/api/schedules/preview?when=nope&timezone=Mars/Base" })).json().error, /five cron fields/);
  assert.match((await app.inject({ method: "GET", url: "/api/schedules/preview?when=@daily&timezone=Mars/Base" })).json().error, /Unknown time zone/);

  const created = await app.inject({ method: "POST", url: "/api/schedules", payload: { agent: "reporter", name: "Digest", when: "every 2h", repo: "acme/widgets", number: 5, prompt: "WEEKLY_DIGEST write it", maxRuns: 2 } });
  assert.equal(created.statusCode, 200, created.body);
  const digest = created.json();
  assert.equal(digest.source, "ui");
  assert.equal(digest.threadKind, "issue");
  assert.equal(digest.description, "every 2 hours");
  assert.equal(digest.createdBy, "dev");

  // Run now: an extra run, the timetable stays; a second one waits for the first.
  const now = await app.inject({ method: "POST", url: `/api/schedules/${digest.id}/run` });
  assert.equal(now.statusCode, 200, now.body);
  const again = await app.inject({ method: "POST", url: `/api/schedules/${digest.id}/run` });
  assert.equal(again.statusCode, 409);
  assert.match(again.json().error, /still going/);
  assert.equal(db.getSchedule(digest.id)!.nextRunAt, digest.nextRunAt);
  assert.equal((await h.waitForTask(now.json().task)).status, "succeeded");
  assert.match(db.getTask(now.json().task)!.prompt ?? "", /set up by dev in the admin UI/);

  // Its second run is its last (max runs 2).
  await runDueSchedules(later(digest.nextRunAt));
  const finished = db.getSchedule(digest.id)!;
  assert.equal(finished.runs, 2);
  assert.equal(finished.enabled, false);
  assert.match(finished.note ?? "", /Finished: it ran 2 times/);
  await h.waitForTask(finished.lastTaskId!);

  // Raising max runs and switching it back on schedules the next run; a new timing moves it.
  const resumed = await app.inject({ method: "PATCH", url: `/api/schedules/${digest.id}`, payload: { maxRuns: 5, enabled: true, when: "0 7 * * *" } });
  assert.equal(resumed.statusCode, 200, resumed.body);
  assert.equal(resumed.json().enabled, true);
  assert.equal(resumed.json().note, null);
  assert.equal(new Date(resumed.json().nextRunAt).getUTCHours(), 7);
  const list = (await app.inject({ method: "GET", url: "/api/schedules?agent=reporter" })).json().schedules;
  assert.deepEqual(
    list[0].recent.map((run: { status: string }) => run.status),
    ["succeeded", "succeeded"],
  );

  assert.equal((await app.inject({ method: "DELETE", url: `/api/schedules/${digest.id}` })).statusCode, 200);
  assert.equal(db.getSchedule(digest.id), null);
});

test("a schedule whose runs keep failing pauses itself and says so", async () => {
  const made = await app.inject({ method: "POST", url: "/api/schedules", payload: { agent: "reporter", name: "Flaky", when: "@hourly", repo: "acme/widgets", number: 5, prompt: "x" } });
  const flaky = made.json();
  for (let index = 0; index < 3; index++) {
    const task = db.createTask({ agent: "reporter", installationId: 77, owner: "acme", repo: "widgets", threadKind: "issue", threadNumber: 5, threadTitle: "", threadUrl: "", triggerKind: "schedule", requestedBy: "x", requestText: "x", requestUrl: "", scheduleId: flaky.id });
    db.updateTask(task.id, { status: "failed", finishedAt: new Date().toISOString() });
  }
  await runDueSchedules(later(flaky.nextRunAt));
  const paused = db.getSchedule(flaky.id)!;
  assert.equal(paused.enabled, false);
  assert.equal(paused.runs, 0, "no fourth run");
  assert.match(paused.note ?? "", /Paused: its last 3 runs failed/);
  assert.ok(listIncidents(10, "schedule").some((incident: { message: string }) => /"Flaky" is paused/.test(incident.message)));
  assert.equal((await app.inject({ method: "GET", url: "/api/guards" })).json().global.some((row: { setting: string }) => row.setting === "SCHEDULE_PAUSE_AFTER_FAILURES"), true);
});

test("operators may run and pause schedules, not change them", async () => {
  const { refusal } = await import("../src/server/roles.ts");
  assert.equal(refusal("operator", "POST", "/api/schedules/3/run", {}), null);
  assert.equal(refusal("operator", "PATCH", "/api/schedules/3", { enabled: false }), null);
  assert.match(refusal("operator", "PATCH", "/api/schedules/3", { enabled: true, when: "@daily" }) ?? "", /Operators can/);
  assert.match(refusal("operator", "POST", "/api/schedules", { agent: "x" }) ?? "", /Operators can/);
  assert.match(refusal("operator", "DELETE", "/api/schedules/3", {}) ?? "", /Operators can/);
  assert.match(refusal("viewer", "POST", "/api/schedules/3/run", {}) ?? "", /Viewers/);
});
