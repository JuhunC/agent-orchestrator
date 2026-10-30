import type { FastifyInstance } from "fastify";
import { config } from "../config.ts";
import { getSchedule, listSchedules, scheduleTasks } from "../db.ts";
import { findInstallation, installationClient } from "../github/app.ts";
import { errorMessage } from "../log.ts";
import { loadProfiles } from "../profiles/loader.ts";
import { addSchedule, changeSchedule, checkTiming, describeSchedule, removeSchedule, runSchedule, syncFileSchedules, type ScheduleInput } from "../schedules/runner.ts";
import { describeWhen, upcomingRuns } from "../schedules/when.ts";
import type { Schedule, ThreadKind } from "../types.ts";

interface ScheduleBody {
  agent?: string;
  name?: string;
  when?: string;
  timezone?: string | null;
  /** owner/name */
  repo?: string;
  /** Issue or pull request number; null or left out: the first run opens an issue. */
  number?: number | null;
  prompt?: string;
  maxRuns?: number | null;
  endsAt?: string | null;
  enabled?: boolean;
}

function view(schedule: Schedule, agents: Set<string>) {
  return {
    ...schedule,
    ...describeSchedule(schedule),
    agentMissing: !agents.has(schedule.agent),
    recent: scheduleTasks(schedule.id, 5).map((task) => ({ id: task.id, status: task.status, createdAt: task.createdAt, finishedAt: task.finishedAt, costUsd: task.costUsd })),
  };
}

/** Checks the issue or pull request exists, and says which it is. */
async function threadKind(owner: string, repo: string, number: number): Promise<ThreadKind> {
  let installationId: number;
  try {
    installationId = await findInstallation(owner, repo);
  } catch {
    throw new Error(`The GitHub App isn't installed on ${owner}/${repo}`);
  }
  try {
    const gh = await installationClient(installationId);
    const { data } = await gh.rest.issues.get({ owner, repo, issue_number: number });
    return data.pull_request ? "pull" : "issue";
  } catch {
    throw new Error(`${owner}/${repo} has no issue or pull request #${number}`);
  }
}

function repoOf(value: unknown): { owner: string; repo: string } {
  const match = /^([\w.-]+)\/([\w.-]+)$/.exec(String(value ?? "").trim());
  if (!match) throw new Error("Give the repository as owner/name");
  return { owner: match[1]!, repo: match[2]! };
}

export function registerScheduleRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { agent?: string } }>("/api/schedules", async (request) => {
    syncFileSchedules();
    const agents = new Set(loadProfiles().agents.map((agent) => agent.name));
    return {
      timezone: config.scheduleTimezone,
      minMinutes: config.scheduleMinMinutes,
      perAgent: config.schedulesPerAgent,
      pauseAfterFailures: config.schedulePauseAfterFailures,
      schedules: listSchedules(request.query.agent ? { agent: request.query.agent } : {}).map((schedule) => view(schedule, agents)),
    };
  });

  /** What a timing means, before saving it. */
  app.get<{ Querystring: { when?: string; timezone?: string } }>("/api/schedules/preview", async (request) => {
    const timezone = request.query.timezone?.trim() || config.scheduleTimezone;
    try {
      const when = checkTiming(String(request.query.when ?? ""), timezone);
      return { description: describeWhen(when, timezone), upcoming: upcomingRuns(when, timezone, new Date(), new Date(), 3).map((run) => run.toISOString()), error: null };
    } catch (error) {
      return { description: null, upcoming: [], error: errorMessage(error) };
    }
  });

  app.post<{ Body: ScheduleBody }>("/api/schedules", async (request, reply) => {
    const body = request.body ?? {};
    try {
      const { owner, repo } = repoOf(body.repo);
      const number = body.number ? Number(body.number) : null;
      const kind = number ? await threadKind(owner, repo, number) : null;
      const schedule = addSchedule(
        {
          agent: String(body.agent ?? ""),
          name: String(body.name ?? ""),
          when: String(body.when ?? ""),
          timezone: body.timezone ?? null,
          owner,
          repo,
          threadKind: kind,
          threadNumber: number,
          prompt: String(body.prompt ?? ""),
          maxRuns: body.maxRuns ?? null,
          endsAt: body.endsAt || null,
          enabled: body.enabled,
        },
        { login: request.adminLogin ?? "admin", source: "ui" },
      );
      return view(schedule, new Set(loadProfiles().agents.map((agent) => agent.name)));
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.patch<{ Params: { id: string }; Body: ScheduleBody }>("/api/schedules/:id", async (request, reply) => {
    const schedule = getSchedule(Number(request.params.id));
    if (!schedule) return reply.code(404).send({ error: "Schedule not found" });
    const body = request.body ?? {};
    const keys = Object.keys(body).filter((key) => (body as Record<string, unknown>)[key] !== undefined);
    if (schedule.source === "file" && keys.some((key) => key !== "enabled")) {
      return reply.code(400).send({ error: `This schedule is written in agents/${schedule.agent}/agent.md: change it there. Here you can only pause and resume it.` });
    }
    try {
      const patch: Partial<Omit<ScheduleInput, "agent">> = {};
      for (const key of ["name", "when", "prompt"] as const) if (body[key] !== undefined) patch[key] = String(body[key]);
      if (body.timezone !== undefined) patch.timezone = body.timezone;
      if (body.maxRuns !== undefined) patch.maxRuns = body.maxRuns;
      if (body.endsAt !== undefined) patch.endsAt = body.endsAt || null;
      if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
      const where = body.repo !== undefined ? repoOf(body.repo) : { owner: schedule.owner, repo: schedule.repo };
      if (body.repo !== undefined) Object.assign(patch, where);
      if (body.number !== undefined || body.repo !== undefined) {
        const number = body.number !== undefined ? (body.number ? Number(body.number) : null) : schedule.threadNumber;
        patch.threadNumber = number;
        patch.threadKind = number ? await threadKind(where.owner, where.repo, number) : null;
      }
      return view(changeSchedule(schedule, patch), new Set(loadProfiles().agents.map((agent) => agent.name)));
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/schedules/:id", async (request, reply) => {
    const schedule = getSchedule(Number(request.params.id));
    if (!schedule) return reply.code(404).send({ error: "Schedule not found" });
    if (schedule.source === "file") return reply.code(400).send({ error: `This schedule is written in agents/${schedule.agent}/agent.md: remove it there.` });
    removeSchedule(schedule.id);
    return { deleted: schedule.id };
  });

  /** An extra run now; the timetable stays as it is. */
  app.post<{ Params: { id: string } }>("/api/schedules/:id/run", async (request, reply) => {
    const schedule = getSchedule(Number(request.params.id));
    if (!schedule) return reply.code(404).send({ error: "Schedule not found" });
    const result = await runSchedule(schedule.id, "now");
    if (!result.task) return reply.code(409).send({ error: result.note });
    return { task: result.task.id, note: result.note };
  });
}
