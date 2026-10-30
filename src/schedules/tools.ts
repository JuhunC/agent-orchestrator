import { tool, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { config } from "../config.ts";
import { getSchedule, listSchedules } from "../db.ts";
import { errorMessage } from "../log.ts";
import type { Profile } from "../profiles/types.ts";
import type { ToolContext } from "../runtime/github-tools.ts";
import type { Schedule } from "../types.ts";
import { addSchedule, changeSchedule, describeSchedule, removeSchedule, scheduleLine } from "./runner.ts";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

const WHEN = z
  .string()
  .min(1)
  .describe('When it runs: a cron expression (minute hour day month weekday, e.g. "0 9 * * 1-5" for weekdays at 09:00), a shortcut (@hourly, @daily, @weekly, @monthly), or an interval ("every 30m", "every 6h", "every 2d")');
const TIMEZONE = z.string().optional().describe(`Time zone for cron times, e.g. "Asia/Seoul" or "America/New_York" (default ${config.scheduleTimezone})`);
const ENDS = z.string().nullable().optional().describe("Stop after this date or time, e.g. 2026-12-31 (null: no end)");
const MAX_RUNS = z.number().int().positive().nullable().optional().describe("Stop after this many runs (null: no limit)");

/** The schedule tools an agent gets (can_schedule in agent.md): make, list, change and stop its own repeating runs. */
export function scheduleTools(profile: Profile, current: () => ToolContext | null): SdkMcpToolDefinition<any>[] {
  if (!profile.canSchedule) return [];
  const run = (handler: (ctx: ToolContext) => Promise<ToolResult> | ToolResult) => async (): Promise<ToolResult> => {
    const ctx = current();
    if (!ctx) return fail("No task is active.");
    try {
      return await handler(ctx);
    } catch (error) {
      return fail(errorMessage(error));
    }
  };
  /** One of this agent's own schedules (not one from its agent.md, which only the file changes). */
  const own = (id: number, action: string): Schedule | string => {
    const schedule = getSchedule(id);
    if (!schedule || schedule.agent !== profile.name) return `You have no schedule #${id}. list_schedules shows yours.`;
    if (schedule.source === "file") return `Schedule #${id} is written in your agent.md, so only a change to that file can ${action} it.`;
    return schedule;
  };
  const summary = (schedule: Schedule) => {
    const { description, upcoming } = describeSchedule(schedule);
    const target = schedule.threadNumber ? `${schedule.threadKind === "pull" ? "pull request" : "issue"} #${schedule.threadNumber}` : "a new issue (opened on the first run)";
    return `#${schedule.id} "${schedule.name}" runs ${description}${schedule.maxRuns ? `, ${schedule.maxRuns} times at most` : ""}${schedule.endsAt ? `, until ${schedule.endsAt.slice(0, 16).replace("T", " ")} UTC` : ""}. Each run works on ${target} in ${schedule.owner}/${schedule.repo} and posts its result there.${upcoming.length ? ` Next runs (UTC): ${upcoming.map((time) => time.slice(0, 16).replace("T", " ")).join(", ")}.` : schedule.enabled ? "" : " It's paused."}`;
  };

  return [
    tool(
      "create_schedule",
      "Set yourself up to run again and again on a timetable, when someone asks for repeating work (\"every Monday, check for outdated dependencies\", \"remind me daily until this is merged\"). Each run starts you on the thread with the prompt you give here, so write the prompt as a complete instruction that makes sense on its own each time. People can pause, change or delete it in the admin UI.",
      {
        name: z.string().min(1).max(120).describe('A short name, e.g. "Weekly dependency check"'),
        when: WHEN,
        timezone: TIMEZONE,
        prompt: z.string().min(1).describe("What to do on each run, as a complete instruction"),
        issue: z.number().int().positive().optional().describe("The issue or pull request number in this repository each run works on (default: this thread)"),
        max_runs: MAX_RUNS,
        ends_at: ENDS,
      },
      (args) =>
        run((ctx) => {
          const { task } = ctx;
          if (task.triggerKind === "schedule") return fail("A scheduled run can't make more schedules. You can change or stop this one with update_schedule or delete_schedule.");
          const schedule = addSchedule(
            {
              agent: profile.name,
              name: args.name,
              when: args.when,
              timezone: args.timezone ?? null,
              owner: task.owner,
              repo: task.repo,
              threadKind: args.issue && args.issue !== task.threadNumber ? null : task.threadKind,
              threadNumber: args.issue ?? task.threadNumber,
              prompt: args.prompt,
              maxRuns: args.max_runs ?? null,
              endsAt: args.ends_at ?? null,
            },
            { login: task.requestedBy, source: "agent", taskId: task.id },
          );
          ctx.onEvent("tool", `Created schedule #${schedule.id} "${schedule.name}" (${describeSchedule(schedule).description})`);
          return ok(`Created ${summary(schedule)} Mention the schedule's id if someone may want to change it later.`);
        })(),
    ),
    tool("list_schedules", "List your schedules (all repositories): id, name, when, where, and how recent runs went.", {}, () =>
      run(() => {
        const schedules = listSchedules({ agent: profile.name });
        if (!schedules.length) return ok("You have no schedules.");
        return ok(schedules.map(scheduleLine).join("\n"));
      })(),
    ),
    tool(
      "update_schedule",
      "Change one of your schedules: its timing, prompt, name or end, or pause and resume it. Leave out what stays the same.",
      {
        id: z.number().int().positive().describe("The schedule's id (see list_schedules)"),
        name: z.string().min(1).max(120).optional(),
        when: WHEN.optional(),
        timezone: TIMEZONE,
        prompt: z.string().min(1).optional().describe("The new instruction for each run"),
        paused: z.boolean().optional().describe("true pauses it, false starts it again"),
        max_runs: MAX_RUNS,
        ends_at: ENDS,
      },
      (args) =>
        run((ctx) => {
          const schedule = own(args.id, "change");
          if (typeof schedule === "string") return fail(schedule);
          const updated = changeSchedule(schedule, {
            ...(args.name !== undefined ? { name: args.name } : {}),
            ...(args.when !== undefined ? { when: args.when } : {}),
            ...(args.timezone !== undefined ? { timezone: args.timezone } : {}),
            ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
            ...(args.paused !== undefined ? { enabled: !args.paused } : {}),
            ...(args.max_runs !== undefined ? { maxRuns: args.max_runs } : {}),
            ...(args.ends_at !== undefined ? { endsAt: args.ends_at } : {}),
          });
          ctx.onEvent("tool", `Changed schedule #${updated.id} "${updated.name}"`);
          return ok(`Changed: ${summary(updated)}${!updated.enabled && updated.note ? ` (${updated.note})` : ""}`);
        })(),
    ),
    tool(
      "delete_schedule",
      "Delete one of your schedules for good, e.g. when the work it repeats is finished. To stop it for a while, use update_schedule with paused: true.",
      { id: z.number().int().positive().describe("The schedule's id (see list_schedules)") },
      (args) =>
        run((ctx) => {
          const schedule = own(args.id, "delete");
          if (typeof schedule === "string") return fail(schedule);
          removeSchedule(schedule.id);
          ctx.onEvent("tool", `Deleted schedule #${schedule.id} "${schedule.name}"`);
          return ok(`Deleted schedule #${schedule.id} "${schedule.name}". It won't run again.`);
        })(),
    ),
  ];
}
