import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { ModelRequest } from "./fake-model.ts";
import { startHarness } from "./harness.ts";

const h = await startHarness(
  { "agents/reader/agent.md": "---\nhandle: aorch-reader\ndescription: Reads\nlive: false\ngithub:\n  push: false\n  pull_request: false\n  finalize: false\n---\nYou are reader.\n" },
  { METRICS_TOKEN: "scrape", MAX_CONCURRENT_TASKS: "3" },
);
// (A test that fails must not leave a held agent running: stopping waits for it.)
after(() => (releaseAll(), h.stop()));
const { app, db, model } = h;
const { config } = await import("../src/config.ts");
const { inactiveFile, megabytes, pressureOf } = await import("../src/runner/executor.ts");

/** Agents asked to HOLD_x stay at work until release("HOLD_x"). */
const gates = new Map<string, { reached: boolean; open: boolean; go: () => void }>();
const gate = (name: string) => gates.get(name) ?? gates.set(name, { reached: false, open: false, go: () => {} }).get(name)!;
const release = (name: string) => {
  gate(name).open = true;
  gate(name).go();
};
const releaseAll = () => [...gates.keys()].forEach(release);
model.script = async (request: ModelRequest) => {
  const name = request.prompt.match(/HOLD_\w+/)?.[0];
  if (name && !gate(name).open) {
    gate(name).reached = true;
    await new Promise<void>((resolve) => (gate(name).go = resolve));
  }
  return [{ type: "text", text: "Read it." }];
};

async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 600; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`never happened: ${what}`);
}
const json = async <T>(url: string) => (await app.inject({ method: "GET", url })).json() as T;
type Host = { executor: string; cpus: number; totalMb: number; freeMb: number; loadPerCpu: number | null; limits: { minFreeMemoryMb: number; maxLoad: number }; pressure: string | null; holding: string | null };
const host = async () => (await json<{ host: Host }>("/api/settings")).host;
const events = async (id: number) => (await json<{ events: { message: string }[] }>(`/api/tasks/${id}`)).events.map((event) => event.message);
const waitsForHost = async (id: number) => (await events(id)).filter((message) => message.startsWith("Waiting for the host")).length;
const metrics = async () => (await app.inject({ method: "GET", url: "/metrics", headers: { authorization: "Bearer scrape" } })).body;
const incidents = async () => (await json<{ kind: string; severity: string; message: string }[]>("/api/incidents?kind=host_pressure"));

test("what counts as a host with no room", () => {
  const off = { minFreeMemoryMb: 0, maxLoad: 0 };
  assert.equal(pressureOf({ freeMb: 1, loadPerCpu: 50 }, off), null, "nothing is checked");
  assert.equal(pressureOf({ freeMb: 4096, loadPerCpu: 0.5 }, { minFreeMemoryMb: 256, maxLoad: 2 }), null, "room");
  assert.equal(pressureOf({ freeMb: 100.4, loadPerCpu: 0.5 }, { minFreeMemoryMb: 256, maxLoad: 2 }), "100 MB of memory is free, and HOST_MIN_FREE_MEMORY_MB is 256");
  assert.equal(pressureOf({ freeMb: 4096, loadPerCpu: 3.204 }, { minFreeMemoryMb: 256, maxLoad: 2 }), "the load is 3.20 per CPU, and HOST_MAX_LOAD is 2");
  assert.equal(pressureOf({ freeMb: 256, loadPerCpu: 2 }, { minFreeMemoryMb: 256, maxLoad: 2 }), null, "at the limits is still room");
  assert.equal(pressureOf({ freeMb: 4096, loadPerCpu: null }, { minFreeMemoryMb: 0, maxLoad: 2 }), null, "a system that reports no load");
  assert.deepEqual([megabytes(900.6), megabytes(1536)], ["901 MB", "1.5 GB"]);

  // A container's file cache counts as free: cgroup v2's figure, and v1's for the whole group.
  assert.equal(inactiveFile("anon 4096\nfile 9000\ninactive_file 2048\nactive_file 512\n"), 2048);
  assert.equal(inactiveFile("inactive_file 10\ntotal_cache 1\ntotal_inactive_file 300\n"), 300);
  assert.equal(inactiveFile(""), 0);
});

test("a host short of memory starts tasks one after another, says so, and never stops the queue", async () => {
  const before = await host();
  assert.equal(before.executor, "this host");
  assert.ok(before.cpus >= 1 && before.totalMb > 0 && before.freeMb > 0, JSON.stringify(before));
  assert.deepEqual([before.limits, before.pressure, before.holding], [{ minFreeMemoryMb: 0, maxLoad: 0 }, null, null]);

  config.hostMinFreeMemoryMb = 1e9;
  try {
    // Nothing is running: the first task starts whatever the host says.
    const first = await h.mentionOnNewIssue(1, "aorch-reader", "HOLD_A look at this");
    await until(() => gate("HOLD_A").reached, "the first agent at work");
    const second = await h.mentionOnNewIssue(2, "aorch-reader", "and this");
    await until(async () => (await waitsForHost(second.id)) === 1, "the second task says it waits for the host");
    assert.equal(db.getTask(second.id)!.status, "queued");
    assert.match((await events(second.id)).find((message) => message.startsWith("Waiting for the host"))!, /^Waiting for the host: [\d.]+ (MB|GB) of memory is free, and HOST_MIN_FREE_MEMORY_MB is 1000000000\. It starts when a running agent finishes or the host has room again$/);

    // The admin UI is told: Settings and the Dashboard, the task's page, the guards, the metrics, an alert.
    const now = await host();
    assert.match(now.holding ?? "", /of memory is free, and HOST_MIN_FREE_MEMORY_MB is 1000000000$/);
    assert.equal(now.pressure, now.holding);
    assert.equal(now.limits.minFreeMemoryMb, 1e9);
    assert.equal((await json<{ settings: { host: Host } }>("/api/overview")).settings.host.holding, now.holding);
    assert.equal((await json<{ queue: { ahead: number; host: string | null } }>(`/api/tasks/${second.id}`)).queue.host, now.holding);
    assert.match(await metrics(), /^ao_host_pressure 1$/m);
    assert.match(await metrics(), /^ao_host_memory_free_bytes \d+$/m);
    const guards = (await app.inject({ method: "GET", url: "/api/guards" })).body;
    assert.match(guards, /Free memory to start another agent/);
    assert.match(guards, /Load to start another agent/);
    const [incident, ...more] = await incidents();
    assert.deepEqual([incident!.severity, more.length], ["warning", 0]);
    assert.match(incident!.message, /^The host is holding queued tasks back: .* HOST_MIN_FREE_MEMORY_MB is 1000000000\. Running agents carry on, and one task always runs\./);

    // Looking again says nothing twice.
    h.scheduler.kick();
    h.scheduler.kick();
    assert.equal(await waitsForHost(second.id), 1);
    assert.equal((await incidents()).length, 1);
    assert.equal(await waitsForHost(first.id), 0);

    // The first one ends: the second starts, though the host is no better off.
    release("HOLD_A");
    assert.equal((await h.waitForTask(first.id)).status, "succeeded");
    assert.equal((await h.waitForTask(second.id)).status, "succeeded");
    assert.equal((await host()).holding, null);
    assert.match(await metrics(), /^ao_host_pressure 0$/m);

    // Room again while an agent works: what waited starts next to it.
    const third = await h.mentionOnNewIssue(3, "aorch-reader", "HOLD_C one more");
    await until(() => gate("HOLD_C").reached, "the third agent at work");
    const fourth = await h.mentionOnNewIssue(4, "aorch-reader", "HOLD_D and another");
    await until(async () => (await waitsForHost(fourth.id)) === 1, "the fourth task waits for the host");
    config.hostMinFreeMemoryMb = 0;
    h.scheduler.kick();
    await until(() => gate("HOLD_D").reached, "the fourth agent at work next to the third");
    assert.deepEqual([db.getTask(third.id)!.status, db.getTask(fourth.id)!.status], ["running", "running"]);
    assert.equal((await host()).holding, null);

    // With nothing checked, tasks start side by side and nothing is said.
    const fifth = await h.mentionOnNewIssue(5, "aorch-reader", "HOLD_E the last");
    await until(() => gate("HOLD_E").reached, "the fifth agent at work next to the others");
    assert.equal(await waitsForHost(fifth.id), 0);
    releaseAll();
    for (const task of [third, fourth, fifth]) assert.equal((await h.waitForTask(task.id)).status, "succeeded");
    assert.equal((await incidents()).length, 1);
  } finally {
    config.hostMinFreeMemoryMb = 0;
    releaseAll();
  }
});

test("a busy host holds tasks back too", async () => {
  config.hostMaxLoad = 1e-9;
  try {
    const first = await h.mentionOnNewIssue(6, "aorch-reader", "HOLD_F look");
    await until(() => gate("HOLD_F").reached, "the first agent at work");
    const second = await h.mentionOnNewIssue(7, "aorch-reader", "and this");
    const load = (await host()).loadPerCpu;
    // (A machine that has only just started, or reports no load, has nothing to hold tasks for.)
    if (load === null || load <= 1e-9) return;
    await until(async () => (await waitsForHost(second.id)) === 1, "the second task says it waits for the host");
    assert.match((await host()).holding ?? "", /^the load is [\d.]+ per CPU, and HOST_MAX_LOAD is 1e-9$/);
    assert.match(await metrics(), /^ao_host_load_per_cpu [\d.e-]+$/m);
    release("HOLD_F");
    assert.equal((await h.waitForTask(first.id)).status, "succeeded");
    assert.equal((await h.waitForTask(second.id)).status, "succeeded");
  } finally {
    config.hostMaxLoad = 0;
    releaseAll();
  }
});
