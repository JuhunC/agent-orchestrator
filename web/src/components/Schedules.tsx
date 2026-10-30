import { useEffect, useState } from "react";
import { api, useApi, type AgentsResponse, type Installation, type ScheduleView, type SchedulesResponse } from "../api.ts";
import { href } from "../router.ts";
import { Dialog, Empty, Panel, Pill, Switch, who } from "./ui.tsx";

const PRESETS: { label: string; when: string }[] = [
  { label: "Every hour", when: "@hourly" },
  { label: "Every 6 hours", when: "every 6h" },
  { label: "Every day at 09:00", when: "0 9 * * *" },
  { label: "Weekdays at 09:00", when: "0 9 * * 1-5" },
  { label: "Mondays at 09:00", when: "0 9 * * 1" },
  { label: "1st of the month", when: "0 9 1 * *" },
];

const SOURCE: Record<ScheduleView["source"], string> = { ui: "made here", agent: "made by the agent", file: "agent.md" };

function localTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function fromNow(iso: string): string {
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60_000);
  if (minutes < 1) return "any moment";
  if (minutes < 60) return `in ${minutes} min`;
  if (minutes < 48 * 60) return `in ${Math.round(minutes / 60)} h`;
  return `in ${Math.round(minutes / 1440)} days`;
}

function target(schedule: ScheduleView): string {
  return schedule.threadNumber ? `${schedule.owner}/${schedule.repo}#${schedule.threadNumber}` : `${schedule.owner}/${schedule.repo}`;
}

/**
 * An agent's schedules (or every agent's, without `agent`): each runs the agent on its thread with
 * the same request, on a timetable.
 */
export function Schedules({ agent }: { agent?: string }) {
  const { data, reload } = useApi<SchedulesResponse>(`/api/schedules${agent ? `?agent=${encodeURIComponent(agent)}` : ""}`, (message) => message.type === "schedules" || message.type === "task");
  const [editing, setEditing] = useState<ScheduleView | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const act = async (work: () => Promise<unknown>, done?: string) => {
    setError(null);
    setNotice(null);
    try {
      await work();
      if (done) setNotice(done);
      void reload();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  const schedules = data?.schedules ?? [];
  return (
    <Panel
      title="Schedules"
      hint="times in your time zone"
      actions={
        <button className="small primary" onClick={() => setEditing("new")}>
          New schedule
        </button>
      }
      tight={schedules.length > 0}
    >
      {(error || notice) && (
        <div className={schedules.length ? "schedule-banners" : undefined}>
          {error && <div className="banner error">{error}</div>}
          {notice && <div className="banner info">{notice}</div>}
        </div>
      )}
      {!data ? (
        <Empty>Loading…</Empty>
      ) : !schedules.length ? (
        <Empty>
          No schedules yet. Make one here, list them under <code>schedules:</code> in {agent ? "this agent's" : "an agent's"} agent.md, or ask {agent ? "the agent" : "an agent"} on GitHub, e.g. "every Monday at 9, check
          for outdated dependencies".
        </Empty>
      ) : (
        <div className="schedule-list">
          {schedules.map((schedule) => (
            <div key={schedule.id} className={`schedule-item${schedule.enabled ? "" : " paused"}`}>
              <div className="schedule-main">
                <div className="row" style={{ gap: 8 }}>
                  <span className="title">{schedule.name}</span>
                  <span className="badge">{SOURCE[schedule.source]}</span>
                  {!schedule.enabled && <Pill tone="off">paused</Pill>}
                </div>
                <div className="meta">
                  Runs {schedule.description}
                  {schedule.maxRuns ? ` · ${schedule.runs} of ${schedule.maxRuns} runs` : schedule.runs ? ` · ${schedule.runs} run${schedule.runs === 1 ? "" : "s"} so far` : ""}
                  {schedule.endsAt ? ` · until ${new Date(schedule.endsAt).toLocaleDateString(undefined, { timeZone: "UTC" })}` : ""}
                </div>
                <div className="meta">
                  On {target(schedule)} {schedule.threadNumber ? `(${schedule.threadKind === "pull" ? "pull request" : schedule.threadKind ?? "issue or pull request"})` : "(the first run opens an issue)"}
                  {schedule.enabled && schedule.nextRunAt ? ` · next ${localTime(schedule.nextRunAt)}, ${fromNow(schedule.nextRunAt)}` : ""}
                </div>
                <div className="meta">
                  {!agent && (
                    <>
                      <a href={href(`/agents/${schedule.agent}`)}>{schedule.agent}</a>
                      {" · "}
                    </>
                  )}
                  {schedule.source === "file" ? "written in agent.md" : <>set up by {who(schedule.createdBy)}</>}
                  {schedule.createdByTask && (
                    <>
                      {" in "}
                      <a href={href(`/tasks/${schedule.createdByTask}`)}>task #{schedule.createdByTask}</a>
                    </>
                  )}
                </div>
                {schedule.agentMissing && <div className="error-text">There's no agent called {schedule.agent} any more.</div>}
                {schedule.error && <div className="error-text">{schedule.error}</div>}
                {schedule.note && <div className={schedule.enabled ? "meta" : "warn-text"}>{schedule.note}</div>}
              </div>
              <div className="schedule-side">
                <div className="row" style={{ gap: 5 }} aria-label="Recent runs, newest first">
                  {schedule.recent.length ? (
                    <>
                      <span className="meta">Recent:</span>
                      {schedule.recent.map((run) => (
                        <a
                          key={run.id}
                          className={`run-dot ${run.status}`}
                          href={href(`/tasks/${run.id}`)}
                          title={`Task #${run.id}: ${run.status}, ${new Date(run.createdAt).toLocaleString()}`}
                          aria-label={`Task #${run.id}, ${run.status}`}
                        />
                      ))}
                    </>
                  ) : (
                    <span className="meta">No runs yet</span>
                  )}
                </div>
                <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                  <Switch
                    label={schedule.enabled ? `Pause ${schedule.name}` : `Resume ${schedule.name}`}
                    checked={schedule.enabled}
                    onChange={(enabled) => void act(() => api.patch(`/api/schedules/${schedule.id}`, { enabled }))}
                  />
                  <button
                    className="small"
                    onClick={() =>
                      void act(async () => {
                        const result = await api.post<{ task: number }>(`/api/schedules/${schedule.id}/run`);
                        setNotice(`Started task #${result.task}.`);
                      })
                    }
                  >
                    Run now
                  </button>
                  {schedule.source !== "file" ? (
                    <>
                      <button className="small" onClick={() => setEditing(schedule)}>
                        Edit
                      </button>
                      <button
                        className="small danger"
                        onClick={() => {
                          if (window.confirm(`Delete the schedule "${schedule.name}"? It won't run again.`)) void act(() => api.del(`/api/schedules/${schedule.id}`), `Deleted "${schedule.name}".`);
                        }}
                      >
                        Delete
                      </button>
                    </>
                  ) : (
                    <a className="button small" href={href(`/agents/${schedule.agent}`)} title="Schedules from agent.md are changed in the file">
                      Edit agent.md
                    </a>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {editing && data && (
        <ScheduleDialog
          schedule={editing === "new" ? null : editing}
          agent={agent}
          defaultTimezone={data.timezone}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            setNotice(`Saved "${saved.name}".${saved.nextRunAt ? ` Next run ${localTime(saved.nextRunAt)}.` : ""}`);
            void reload();
          }}
        />
      )}
    </Panel>
  );
}

interface Preview {
  description: string | null;
  upcoming: string[];
  error: string | null;
}

function ScheduleDialog({ schedule, agent, defaultTimezone, onClose, onSaved }: { schedule: ScheduleView | null; agent?: string; defaultTimezone: string; onClose: () => void; onSaved: (schedule: ScheduleView) => void }) {
  const agents = useApi<AgentsResponse>(agent ? null : "/api/agents").data?.agents ?? [];
  const [form, setForm] = useState({
    agent: schedule?.agent ?? agent ?? "",
    name: schedule?.name ?? "",
    when: schedule?.when ?? "0 9 * * 1-5",
    timezone: schedule?.timezone ?? "",
    repo: schedule ? `${schedule.owner}/${schedule.repo}` : "",
    number: schedule?.threadNumber ? String(schedule.threadNumber) : "",
    prompt: schedule?.prompt ?? "",
    maxRuns: schedule?.maxRuns ? String(schedule.maxRuns) : "",
    endsAt: schedule?.endsAt ? schedule.endsAt.slice(0, 10) : "",
  });
  const [repos, setRepos] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (value: string) => setForm((current) => ({ ...current, [key]: value }));
  const zone = form.timezone.trim() || defaultTimezone;
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  useEffect(() => {
    if (!agent && !form.agent && agents[0]) setForm((current) => ({ ...current, agent: agents[0]!.name }));
  }, [agents, agent, form.agent]);

  useEffect(() => {
    api
      .get<Installation[]>("/api/installations")
      .then((installations) => {
        const all = installations.flatMap((installation) => installation.repositories).sort();
        setRepos(all);
        if (all.length === 1) setForm((current) => (current.repo ? current : { ...current, repo: all[0]! }));
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!form.when.trim()) return setPreview(null);
    const timer = setTimeout(() => {
      api
        .get<Preview>(`/api/schedules/preview?when=${encodeURIComponent(form.when)}&timezone=${encodeURIComponent(zone)}`)
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 250);
    return () => clearTimeout(timer);
  }, [form.when, zone]);

  const save = async () => {
    setBusy(true);
    setError(null);
    const body = {
      ...(schedule ? {} : { agent: form.agent }),
      name: form.name,
      when: form.when,
      timezone: form.timezone.trim() || null,
      repo: form.repo,
      number: form.number ? Number(form.number) : null,
      prompt: form.prompt,
      maxRuns: form.maxRuns ? Number(form.maxRuns) : null,
      endsAt: form.endsAt || null,
    };
    try {
      onSaved(schedule ? await api.patch<ScheduleView>(`/api/schedules/${schedule.id}`, body) : await api.post<ScheduleView>("/api/schedules", body));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const valid = form.agent && form.name.trim() && form.when.trim() && /^[^/\s]+\/[^/\s]+$/.test(form.repo) && form.prompt.trim() && !preview?.error;
  return (
    <Dialog
      title={schedule ? `Edit "${schedule.name}"` : "New schedule"}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!valid || busy} onClick={() => void save()}>
            {busy ? "Saving…" : schedule ? "Save" : "Create schedule"}
          </button>
        </>
      }
    >
      <div className="form-grid">
        {!agent && !schedule && (
          <div className="field">
            <label htmlFor="schedule-agent">Agent</label>
            <select id="schedule-agent" value={form.agent} onChange={(event) => set("agent")(event.target.value)}>
              {agents.map((candidate) => (
                <option key={candidate.name} value={candidate.name}>
                  {candidate.name} (@{candidate.handle})
                </option>
              ))}
            </select>
          </div>
        )}
        <div className={`field${!agent && !schedule ? "" : " full"}`}>
          <label htmlFor="schedule-name">Name</label>
          <input id="schedule-name" placeholder="Weekly dependency check" value={form.name} onChange={(event) => set("name")(event.target.value)} />
        </div>
        <div className="field full">
          <label htmlFor="schedule-when">When</label>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {PRESETS.map((preset) => (
              <button key={preset.when} type="button" className={`small${form.when === preset.when ? " primary" : ""}`} onClick={() => set("when")(preset.when)}>
                {preset.label}
              </button>
            ))}
          </div>
          <input id="schedule-when" value={form.when} onChange={(event) => set("when")(event.target.value)} placeholder='0 9 * * 1-5, @daily or "every 6h"' />
          <span className="help">
            {preview?.error ? (
              <span className="error-text">{preview.error}</span>
            ) : preview?.description ? (
              <>
                Runs {preview.description}. Next: {preview.upcoming.map(localTime).join(", ")} (your time).
              </>
            ) : (
              "A cron expression (minute hour day month weekday), a shortcut like @daily, or an interval like every 6h."
            )}
          </span>
        </div>
        <div className="field">
          <label htmlFor="schedule-timezone">Time zone</label>
          <input id="schedule-timezone" placeholder={defaultTimezone} value={form.timezone} onChange={(event) => set("timezone")(event.target.value)} />
          <span className="help">
            For cron times. Empty: {defaultTimezone}.{" "}
            {browserZone && browserZone !== zone && (
              <button type="button" className="link" onClick={() => set("timezone")(browserZone)}>
                Use {browserZone}
              </button>
            )}
          </span>
        </div>
        <div className="field">
          <label htmlFor="schedule-repo">Repository</label>
          <input id="schedule-repo" list="schedule-repos" placeholder="owner/repo" value={form.repo} onChange={(event) => set("repo")(event.target.value.trim())} />
          <datalist id="schedule-repos">
            {repos.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>
        <div className="field">
          <label htmlFor="schedule-number">Issue or PR number</label>
          <input id="schedule-number" inputMode="numeric" placeholder="optional" value={form.number} onChange={(event) => set("number")(event.target.value.replace(/\D/g, ""))} />
          <span className="help">Each run works and replies there. Empty: the first run opens an issue for this schedule.</span>
        </div>
        <div className="field">
          <label htmlFor="schedule-max">Stop after</label>
          <div className="row" style={{ gap: 6 }}>
            <input id="schedule-max" inputMode="numeric" placeholder="runs" value={form.maxRuns} onChange={(event) => set("maxRuns")(event.target.value.replace(/\D/g, ""))} style={{ width: 80 }} />
            <input type="date" aria-label="End date" value={form.endsAt} onChange={(event) => set("endsAt")(event.target.value)} />
          </div>
          <span className="help">Optional: a number of runs, an end date, or both.</span>
        </div>
        <div className="field full">
          <label htmlFor="schedule-prompt">What to do each run</label>
          <textarea id="schedule-prompt" rows={5} placeholder="Check for outdated dependencies. Open one pull request updating the ones that are safe to update, and list the rest." value={form.prompt} onChange={(event) => set("prompt")(event.target.value)} />
          <span className="help">The same request every run, so write it to make sense on its own. The agent sees its earlier runs on the thread.</span>
        </div>
      </div>
      {error && <p className="error-text">{error}</p>}
    </Dialog>
  );
}
