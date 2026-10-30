import { bus } from "../bus.ts";
import { config, repoAllowed } from "../config.ts";
import type { ScheduleRun } from "../agents/prompt.ts";
import { createSchedule, createTask, deleteSchedule, dueSchedules, getSchedule, listSchedules, scheduleCount, scheduleRunsBefore, scheduleTasks, updateSchedule, type NewSchedule } from "../db.ts";
import { clientFor } from "../github/accounts.ts";
import { findInstallation, installationClient } from "../github/app.ts";
import { signed } from "../github/threads.ts";
import { errorMessage, log } from "../log.ts";
import { loadProfiles } from "../profiles/loader.ts";
import type { Profile } from "../profiles/types.ts";
import { recordIncident } from "../runner/incidents.ts";
import { mention, taskAdminUrl } from "../runner/progress.ts";
import { scheduler } from "../runner/scheduler.ts";
import type { Schedule, Task, ThreadKind } from "../types.ts";
import { checkTimezone, describeWhen, nextRun, parseWhen, shortestGapMinutes, upcomingRuns, type When } from "./when.ts";

/** How often due schedules are looked for. */
const TICK_MS = 30_000;

/** Reads and checks a timing and time zone; throws an Error saying what's wrong. */
export function checkTiming(whenText: string, timezone: string, from = new Date()): When {
  const when = parseWhen(whenText);
  checkTimezone(timezone);
  if (!nextRun(when, timezone, from)) throw new Error(`"${whenText}" never comes round`);
  const gap = shortestGapMinutes(when, timezone, from);
  if (gap < config.scheduleMinMinutes) {
    throw new Error(`"${whenText}" would run every ${gap} minute${gap === 1 ? "" : "s"}; schedules may run at most every ${config.scheduleMinMinutes} minutes (SCHEDULE_MIN_MINUTES)`);
  }
  return when;
}

/** The next run after `after`, or null when the schedule never runs again. */
function followingRun(schedule: Pick<Schedule, "when" | "timezone" | "createdAt" | "endsAt">, after: Date, previous: Date | null = null): string | null {
  try {
    const next = nextRun(parseWhen(schedule.when), schedule.timezone, after, new Date(schedule.createdAt), previous);
    if (!next || (schedule.endsAt && next.getTime() > Date.parse(schedule.endsAt))) return null;
    return next.toISOString();
  } catch {
    return null;
  }
}

export interface ScheduleInput {
  agent: string;
  name: string;
  when: string;
  timezone?: string | null;
  owner: string;
  repo: string;
  threadKind?: ThreadKind | null;
  threadNumber?: number | null;
  prompt: string;
  maxRuns?: number | null;
  endsAt?: string | null;
  enabled?: boolean;
}

function checkFields(input: Partial<ScheduleInput>): void {
  if (input.name !== undefined && !input.name.trim()) throw new Error("A schedule needs a name");
  if (input.name && input.name.length > 120) throw new Error("Keep the name under 120 characters");
  if (input.prompt !== undefined && !input.prompt.trim()) throw new Error("A schedule needs a prompt: what the agent should do on each run");
  if (input.maxRuns !== undefined && input.maxRuns !== null && (!Number.isInteger(input.maxRuns) || input.maxRuns < 1)) throw new Error("max runs must be a whole number, 1 or more");
  if (input.endsAt && Number.isNaN(Date.parse(input.endsAt))) throw new Error(`"${input.endsAt}" isn't a date (use a date like 2026-12-31 or 2026-12-31T18:00:00Z)`);
  if (input.threadNumber !== undefined && input.threadNumber !== null && (!Number.isInteger(input.threadNumber) || input.threadNumber < 1)) throw new Error("The issue or pull request number must be a positive whole number");
}

const endOf = (value: string | null | undefined): string | null => {
  if (!value) return null;
  // A bare date means the end of that day (UTC).
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : new Date(value).toISOString();
};

/** Makes a schedule; throws an Error a person can act on when something's wrong. */
export function addSchedule(input: ScheduleInput, by: { login: string; source: Schedule["source"]; taskId?: number | null; fileKey?: string | null; profiles?: Profile[] }): Schedule {
  const agents = by.profiles ?? loadProfiles().agents;
  if (!agents.some((agent) => agent.name === input.agent)) throw new Error(`There's no agent called ${input.agent}`);
  checkFields(input);
  if (!input.owner || !input.repo) throw new Error("A schedule needs a repository (owner/name)");
  if (!repoAllowed(`${input.owner}/${input.repo}`)) throw new Error(`${input.owner}/${input.repo} isn't in ALLOWED_REPOS`);
  if (by.source !== "file" && config.schedulesPerAgent && scheduleCount(input.agent) >= config.schedulesPerAgent) {
    throw new Error(`${input.agent} already has ${config.schedulesPerAgent} schedules, the most allowed (SCHEDULES_PER_AGENT). Delete one first.`);
  }
  const timezone = input.timezone?.trim() || config.scheduleTimezone;
  checkTiming(input.when, timezone);
  const createdAt = new Date().toISOString();
  const endsAt = endOf(input.endsAt);
  const fields: NewSchedule = {
    agent: input.agent,
    name: input.name.trim(),
    when: input.when.trim(),
    timezone,
    owner: input.owner,
    repo: input.repo,
    installationId: null,
    threadKind: input.threadNumber ? (input.threadKind ?? null) : null,
    threadNumber: input.threadNumber ?? null,
    prompt: input.prompt.trim(),
    enabled: input.enabled !== false,
    source: by.source,
    fileKey: by.fileKey ?? null,
    createdBy: by.login,
    createdByTask: by.taskId ?? null,
    nextRunAt: followingRun({ when: input.when, timezone, createdAt, endsAt }, new Date()),
    maxRuns: input.maxRuns ?? null,
    endsAt,
    note: null,
  };
  const schedule = createSchedule(fields);
  bus.publish({ type: "schedules" });
  return schedule;
}

/** Changes a schedule's settings (not its target agent). Recomputes the next run when its timing changes. */
export function changeSchedule(schedule: Schedule, patch: Partial<Omit<ScheduleInput, "agent">>): Schedule {
  checkFields(patch);
  const next: Partial<Schedule> = {};
  for (const key of ["name", "prompt", "when"] as const) if (patch[key] !== undefined) next[key] = patch[key]!.trim();
  if (patch.timezone !== undefined) next.timezone = patch.timezone?.trim() || config.scheduleTimezone;
  if (patch.owner !== undefined && patch.repo !== undefined && `${patch.owner}/${patch.repo}`.toLowerCase() !== `${schedule.owner}/${schedule.repo}`.toLowerCase()) {
    if (!repoAllowed(`${patch.owner}/${patch.repo}`)) throw new Error(`${patch.owner}/${patch.repo} isn't in ALLOWED_REPOS`);
    Object.assign(next, { owner: patch.owner, repo: patch.repo, installationId: null });
  }
  if (patch.threadNumber !== undefined) Object.assign(next, { threadNumber: patch.threadNumber ?? null, threadKind: patch.threadNumber ? (patch.threadKind ?? null) : null });
  if (patch.maxRuns !== undefined) next.maxRuns = patch.maxRuns ?? null;
  if (patch.endsAt !== undefined) next.endsAt = endOf(patch.endsAt);
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  const merged = { ...schedule, ...next };
  if (next.when !== undefined || next.timezone !== undefined) checkTiming(merged.when, merged.timezone);
  const timingChanged = ["when", "timezone", "endsAt", "maxRuns", "enabled"].some((key) => key in next);
  if (timingChanged) {
    const finished = merged.maxRuns !== null && merged.runs >= merged.maxRuns;
    next.nextRunAt = merged.enabled && !finished ? followingRun(merged, new Date()) : null;
    if (merged.enabled && (finished || !next.nextRunAt)) {
      next.enabled = false;
      next.note = finished ? `Finished: it ran ${merged.runs} time${merged.runs === 1 ? "" : "s"}, its max runs` : "Finished: it doesn't come round again before its end date";
    } else if (patch.enabled === true) next.note = null;
  }
  const updated = updateSchedule(schedule.id, next);
  bus.publish({ type: "schedules" });
  return updated;
}

export function removeSchedule(id: number): void {
  deleteSchedule(id);
  bus.publish({ type: "schedules" });
}

/** What the UI and the agent tools show for a schedule. */
export function describeSchedule(schedule: Schedule): { description: string; upcoming: string[]; error: string | null } {
  try {
    const when = parseWhen(schedule.when);
    const upcoming = schedule.enabled ? upcomingRuns(when, schedule.timezone, new Date(), new Date(schedule.createdAt), 3).filter((run) => !schedule.endsAt || run.getTime() <= Date.parse(schedule.endsAt)) : [];
    return { description: describeWhen(when, schedule.timezone), upcoming: upcoming.map((run) => run.toISOString()), error: null };
  } catch (error) {
    return { description: schedule.when, upcoming: [], error: errorMessage(error) };
  }
}

/** One line per schedule, for the agent's tools. */
export function scheduleLine(schedule: Schedule): string {
  const { description } = describeSchedule(schedule);
  const target = schedule.threadNumber ? `${schedule.owner}/${schedule.repo}#${schedule.threadNumber}` : `${schedule.owner}/${schedule.repo} (an issue is opened on the first run)`;
  const state = schedule.enabled ? (schedule.nextRunAt ? `next run ${schedule.nextRunAt.slice(0, 16).replace("T", " ")} UTC` : "no run due") : `paused${schedule.note ? `: ${schedule.note}` : ""}`;
  const last = scheduleTasks(schedule.id, 1)[0];
  return `#${schedule.id} "${schedule.name}": ${description}, on ${target}; ${state}; ${schedule.runs} run${schedule.runs === 1 ? "" : "s"} so far${last ? ` (last: task #${last.id}, ${last.status})` : ""}${schedule.source === "file" ? "; from agent.md" : ""}`;
}

/** What a scheduled run's prompt says about its schedule; null for other tasks. */
export function scheduleRunInfo(task: Task, profile: Profile): ScheduleRun | null {
  const schedule = task.scheduleId ? getSchedule(task.scheduleId) : null;
  if (!schedule) return null;
  const before = scheduleRunsBefore(schedule.id, task.id);
  const setUpBy =
    schedule.source === "file"
      ? "your agent.md"
      : schedule.source === "agent"
        ? `you, when ${mention(schedule.createdBy)} asked${schedule.createdByTask ? ` (task #${schedule.createdByTask})` : ""}`
        : `${mention(schedule.createdBy)} in the admin UI`;
  return {
    id: schedule.id,
    name: schedule.name,
    description: describeSchedule(schedule).description,
    run: before.count + 1,
    setUpBy,
    canChange: profile.canSchedule && schedule.source !== "file",
    previousRunAt: before.lastAt,
  };
}

// ---------- schedules in agent.md ----------

/** Brings the database in line with the schedules: lists in agent.md files. */
export function syncFileSchedules(agents: Profile[] = loadProfiles().agents): void {
  const wanted = new Map<string, { agent: Profile; index: number }>();
  for (const agent of agents) agent.schedules.forEach((_, index) => wanted.set(`${agent.name}/${agent.schedules[index]!.name}`, { agent, index }));
  let changed = false;
  const known = new Map(listSchedules().filter((schedule) => schedule.fileKey).map((schedule) => [schedule.fileKey!, schedule]));
  for (const [key, schedule] of known) {
    if (!wanted.has(key)) {
      deleteSchedule(schedule.id);
      changed = true;
    }
  }
  for (const [key, { agent, index }] of wanted) {
    const entry = agent.schedules[index]!;
    const [owner, repo] = entry.repo.split("/") as [string, string];
    const fields: Partial<ScheduleInput> & Pick<ScheduleInput, "name" | "when" | "owner" | "repo" | "prompt"> = { name: entry.name, when: entry.when, timezone: entry.timezone ?? config.scheduleTimezone, owner, repo, prompt: entry.prompt, maxRuns: entry.maxRuns, endsAt: endOf(entry.endsAt) };
    // Without an issue in the file, the first run opens one and the schedule keeps it.
    if (entry.issue) fields.threadNumber = entry.issue;
    const existing = known.get(key);
    try {
      if (!existing) {
        addSchedule({ agent: agent.name, ...fields }, { login: `${agent.name}'s agent.md`, source: "file", fileKey: key, profiles: agents });
        changed = true;
        continue;
      }
      const differs = (Object.keys(fields) as (keyof typeof fields)[]).some((field) => ((existing as unknown as Record<string, unknown>)[field] ?? null) !== (fields[field] ?? null));
      if (differs) {
        changeSchedule(existing, { ...fields, ...(entry.issue ? { threadKind: existing.threadNumber === entry.issue ? existing.threadKind : null } : {}) });
        changed = true;
      }
    } catch (error) {
      log.warn("Couldn't load a schedule from agent.md", { agent: agent.name, schedule: entry.name, error: errorMessage(error) });
    }
  }
  if (changed) bus.publish({ type: "schedules" });
}

// ---------- runs ----------

/** Opens the issue a schedule without one works on, and remembers it. */
async function openScheduleIssue(schedule: Schedule, profile: Profile, installationId: number): Promise<Schedule> {
  const gh = await clientFor({ agent: profile.name, installationId });
  const { description } = describeSchedule(schedule);
  const body = [
    `**${profile.name}** works here on a schedule: ${description}. Each run posts its result on this issue.`,
    "",
    "> " + schedule.prompt.split("\n").join("\n> "),
    "",
    `<sub>Schedule #${schedule.id} in the agent orchestrator: change, pause or delete it in the admin UI under Schedules (${config.publicUrl}/#/schedules).</sub>`,
  ].join("\n");
  const { data } = await gh.rest.issues.create({ owner: schedule.owner, repo: schedule.repo, title: schedule.name, body: signed(body) });
  return updateSchedule(schedule.id, { threadKind: "issue", threadNumber: data.number });
}

const active = (task: Task | undefined) => task && (task.status === "queued" || task.status === "running");

/**
 * Starts one run of a schedule. "due": its time came (the next run moves on even if this one is
 * skipped); "now": someone asked for an extra run (the timetable doesn't change).
 */
export async function runSchedule(scheduleId: number, why: "due" | "now", at = new Date()): Promise<{ task: Task | null; note: string }> {
  let schedule = getSchedule(scheduleId);
  if (!schedule) return { task: null, note: "That schedule no longer exists" };
  const advance = (note: string | null, extra: Partial<Schedule> = {}) => {
    if (why === "due") {
      const nextRunAt = followingRun(schedule!, at, schedule!.nextRunAt ? new Date(schedule!.nextRunAt) : null);
      const finished = !nextRunAt ? { enabled: false, note: note ?? "Finished: it doesn't come round again before its end date" } : {};
      updateSchedule(schedule!.id, { nextRunAt, note, ...extra, ...finished });
    } else if (note || Object.keys(extra).length) updateSchedule(schedule!.id, { note, ...extra });
    bus.publish({ type: "schedules" });
  };
  const skip = (reason: string) => {
    const note = `Skipped the run due ${(why === "due" && schedule!.nextRunAt ? schedule!.nextRunAt : at.toISOString()).slice(0, 16).replace("T", " ")} UTC: ${reason}`;
    advance(note);
    return { task: null, note };
  };

  if (why === "due" && ((schedule.endsAt && at.getTime() > Date.parse(schedule.endsAt)) || (schedule.maxRuns !== null && schedule.runs >= schedule.maxRuns))) {
    const note = schedule.maxRuns !== null && schedule.runs >= schedule.maxRuns ? `Finished: it ran ${schedule.runs} times, its max runs` : "Finished: its end date has passed";
    updateSchedule(schedule.id, { enabled: false, nextRunAt: null, note });
    bus.publish({ type: "schedules" });
    return { task: null, note };
  }
  const profile = loadProfiles().agents.find((agent) => agent.name === schedule!.agent);
  if (!profile) return skip(`there's no agent called ${schedule.agent} any more`);
  if (!profile.enabled) return skip(`${profile.name} is turned off`);

  const recent = scheduleTasks(schedule.id, Math.max(1, config.schedulePauseAfterFailures));
  if (active(recent[0])) {
    if (why === "now") return { task: null, note: `Run #${recent[0]!.id} is still going` };
    return skip(`the last run (task #${recent[0]!.id}) was still going`);
  }
  const limit = config.schedulePauseAfterFailures;
  if (why === "due" && limit && recent.length >= limit && recent.every((task) => task.status === "failed")) {
    const note = `Paused: its last ${limit} runs failed. Look at task #${recent[0]!.id}, then switch it back on.`;
    updateSchedule(schedule.id, { enabled: false, nextRunAt: null, note });
    recordIncident("schedule", "warning", `${schedule.agent}'s schedule "${schedule.name}" is paused: its last ${limit} runs failed.`, { taskId: recent[0]!.id, url: taskAdminUrl(recent[0]!.id) });
    bus.publish({ type: "schedules" });
    return { task: null, note };
  }

  try {
    if (!schedule.installationId) schedule = updateSchedule(schedule.id, { installationId: await findInstallation(schedule.owner, schedule.repo) });
    const installationId = schedule.installationId!;
    if (!schedule.threadNumber) schedule = await openScheduleIssue(schedule, profile, installationId);
    if (!schedule.threadKind) {
      const gh = await installationClient(installationId);
      const { data } = await gh.rest.issues.get({ owner: schedule.owner, repo: schedule.repo, issue_number: schedule.threadNumber! });
      schedule = updateSchedule(schedule.id, { threadKind: data.pull_request ? "pull" : "issue" });
    }
  } catch (error) {
    const reason = errorMessage(error);
    return skip(/installation|404|Not Found/i.test(reason) && !schedule.installationId ? `the GitHub App isn't installed on ${schedule.owner}/${schedule.repo}` : reason);
  }

  const task = createTask({
    agent: profile.name,
    installationId: schedule.installationId!,
    owner: schedule.owner,
    repo: schedule.repo,
    threadKind: schedule.threadKind!,
    threadNumber: schedule.threadNumber!,
    threadTitle: "",
    threadUrl: "",
    triggerKind: "schedule",
    requestedBy: `schedule "${schedule.name}"`,
    requestText: schedule.prompt,
    requestUrl: "",
    scheduleId: schedule.id,
  });
  const runs = schedule.runs + 1;
  const done = schedule.maxRuns !== null && runs >= schedule.maxRuns;
  advance(null, { runs, lastRunAt: at.toISOString(), lastTaskId: task.id, ...(done ? { enabled: false, nextRunAt: null, note: `Finished: it ran ${runs} time${runs === 1 ? "" : "s"}, its max runs` } : {}) });
  bus.publish({ type: "task", task });
  scheduler.kick();
  log.info("Started a scheduled run", { schedule: schedule.id, agent: profile.name, task: task.id, why });
  return { task, note: `Started task #${task.id}` };
}

/** Starts every schedule whose time has come. A schedule missed while the server was down runs once. */
export async function runDueSchedules(at = new Date()): Promise<void> {
  try {
    syncFileSchedules();
  } catch (error) {
    log.warn("Couldn't read schedules from the agent files", { error: errorMessage(error) });
  }
  for (const schedule of dueSchedules(at.toISOString())) {
    await runSchedule(schedule.id, "due", at).catch((error) => log.warn("A scheduled run failed to start", { schedule: schedule.id, error: errorMessage(error) }));
  }
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startSchedules(): void {
  const tick = () => {
    if (running || scheduler.stopping) return;
    running = true;
    void runDueSchedules().finally(() => (running = false));
  };
  tick();
  timer ??= setInterval(tick, TICK_MS);
  timer.unref();
}
