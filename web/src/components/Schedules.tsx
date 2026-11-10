import { useEffect, useState } from "react";
import { Button, Code, DateInput, Divider, Field, Grid, GridSpan, HStack, Selector, StackItem, Text, TextArea, TextInput, VStack, type ISODateString } from "@astryxdesign/core";
import { api, useApi, type AgentsResponse, type BaseChoice, type Installation, type ScheduleView, type SchedulesResponse } from "../api.ts";
import { href } from "../router.ts";
import { A, Dialog, Empty, ErrorText, LinkButton, Meta, Notice, Panel, Pill, SuggestInput, Switch, Tag, who } from "./ui.tsx";

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
    <Panel title="Schedules" hint="times in your time zone" actions={<Button label="New schedule" size="sm" variant="primary" onClick={() => setEditing("new")} />} tight={schedules.length > 0}>
      {(error || notice) && (
        <VStack gap={2} padding={schedules.length ? 4 : 0} paddingBlockEnd={0}>
          {error && <Notice tone="error" title={error} />}
          {notice && <Notice tone="info" title={notice} />}
        </VStack>
      )}
      {!data ? (
        <Empty>Loading…</Empty>
      ) : !schedules.length ? (
        <Empty>
          No schedules yet. Make one here, list them under <Code size="inherit">schedules:</Code> in {agent ? "this agent's" : "an agent's"} agent.md, or ask {agent ? "the agent" : "an agent"} on GitHub, e.g. "every Monday at 9, check for
          outdated dependencies".
        </Empty>
      ) : (
        <VStack gap={0}>
          {schedules.map((schedule, index) => (
            <VStack key={schedule.id} gap={0}>
              {index > 0 && <Divider />}
              <HStack gap={4} padding={4} wrap="wrap" vAlign="start">
                <StackItem size="fill">
                  <VStack gap={1}>
                    <HStack gap={2} vAlign="center" wrap="wrap">
                      <Text weight="semibold" color={schedule.enabled ? undefined : "secondary"}>
                        {schedule.name}
                      </Text>
                      <Tag>{SOURCE[schedule.source]}</Tag>
                      {!schedule.enabled && <Pill tone="off">paused</Pill>}
                    </HStack>
                    <Meta block>
                      Runs {schedule.description}
                      {schedule.maxRuns ? ` · ${schedule.runs} of ${schedule.maxRuns} runs` : schedule.runs ? ` · ${schedule.runs} run${schedule.runs === 1 ? "" : "s"} so far` : ""}
                      {schedule.endsAt ? ` · until ${new Date(schedule.endsAt).toLocaleDateString(undefined, { timeZone: "UTC" })}` : ""}
                    </Meta>
                    <Meta block>
                      On {target(schedule)} {schedule.threadNumber ? `(${schedule.threadKind === "pull" ? "pull request" : (schedule.threadKind ?? "issue or pull request")})` : "(the first run opens an issue)"}
                      {schedule.baseBranch && (
                        <>
                          {" · pull requests into "}
                          <Code size="inherit">{schedule.baseBranch}</Code>
                        </>
                      )}
                      {schedule.enabled && schedule.nextRunAt ? ` · next ${localTime(schedule.nextRunAt)}, ${fromNow(schedule.nextRunAt)}` : ""}
                    </Meta>
                    <Meta block>
                      {!agent && (
                        <>
                          <A to={`/agents/${schedule.agent}`}>{schedule.agent}</A>
                          {" · "}
                        </>
                      )}
                      {schedule.source === "file" ? "written in agent.md" : <>set up by {who(schedule.createdBy)}</>}
                      {schedule.createdByTask && (
                        <>
                          {" in "}
                          <A to={`/tasks/${schedule.createdByTask}`}>task #{schedule.createdByTask}</A>
                        </>
                      )}
                    </Meta>
                    {schedule.agentMissing && <ErrorText>There's no agent called {schedule.agent} any more.</ErrorText>}
                    {schedule.error && <ErrorText>{schedule.error}</ErrorText>}
                    {schedule.note &&
                      (schedule.enabled ? (
                        <Meta block>{schedule.note}</Meta>
                      ) : (
                        <Text display="block" className="ao-warn-text">
                          {schedule.note}
                        </Text>
                      ))}
                  </VStack>
                </StackItem>
                <VStack gap={2} hAlign="end">
                  <HStack gap={1.5} vAlign="center" aria-label="Recent runs, newest first">
                    {schedule.recent.length ? (
                      <>
                        <Meta>Recent:</Meta>
                        {schedule.recent.map((run) => (
                          <a
                            key={run.id}
                            className={`ao-run-dot ${run.status}`}
                            href={href(`/tasks/${run.id}`)}
                            title={`Task #${run.id}: ${run.status}, ${new Date(run.createdAt).toLocaleString()}`}
                            aria-label={`Task #${run.id}, ${run.status}`}
                          />
                        ))}
                      </>
                    ) : (
                      <Meta>No runs yet</Meta>
                    )}
                  </HStack>
                  <HStack gap={2} vAlign="center" wrap="wrap" hAlign="end">
                    <Switch
                      label={schedule.enabled ? `Pause ${schedule.name}` : `Resume ${schedule.name}`}
                      checked={schedule.enabled}
                      onChange={(enabled) => void act(() => api.patch(`/api/schedules/${schedule.id}`, { enabled }))}
                    />
                    <Button
                      label="Run now"
                      size="sm"
                      onClick={() =>
                        void act(async () => {
                          const result = await api.post<{ task: number }>(`/api/schedules/${schedule.id}/run`);
                          setNotice(`Started task #${result.task}.`);
                        })
                      }
                    />
                    {schedule.source !== "file" ? (
                      <>
                        <Button label="Edit" size="sm" onClick={() => setEditing(schedule)} />
                        <Button
                          label="Delete"
                          size="sm"
                          variant="destructive"
                          onClick={() => {
                            if (window.confirm(`Delete the schedule "${schedule.name}"? It won't run again.`)) void act(() => api.del(`/api/schedules/${schedule.id}`), `Deleted "${schedule.name}".`);
                          }}
                        />
                      </>
                    ) : (
                      <span title="Schedules from agent.md are changed in the file">
                        <LinkButton to={`/agents/${schedule.agent}`} label="Edit agent.md" size="sm" />
                      </span>
                    )}
                  </HStack>
                </VStack>
              </HStack>
            </VStack>
          ))}
        </VStack>
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
    baseBranch: schedule?.baseBranch ?? "",
  });
  const [usual, setUsual] = useState<BaseChoice | null>(null);
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

  // What the runs' pull requests go into when the schedule doesn't name a base branch.
  useEffect(() => {
    if (!form.agent || !/^[^/\s]+\/[^/\s]+$/.test(form.repo)) return setUsual(null);
    let current = true;
    api
      .get<BaseChoice>(`/api/base-branches/resolve?agent=${encodeURIComponent(form.agent)}&repo=${encodeURIComponent(form.repo)}`)
      .then((choice) => current && setUsual(choice))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [form.agent, form.repo]);

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
      baseBranch: form.baseBranch.trim() || null,
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
  const pickAgent = !agent && !schedule;
  return (
    <Dialog
      title={schedule ? `Edit "${schedule.name}"` : "New schedule"}
      width={680}
      onClose={onClose}
      footer={
        <>
          <Button label="Cancel" onClick={onClose} />
          <Button label={busy ? "Saving…" : schedule ? "Save" : "Create schedule"} variant="primary" isDisabled={!valid || busy} onClick={() => void save()} />
        </>
      }
    >
      <Grid columns={{ minWidth: 240 }} gap={4}>
        {pickAgent && (
          <Selector
            label="Agent"
            options={agents.map((candidate) => ({ value: candidate.name, label: `${candidate.name} (@${candidate.handle})` }))}
            value={form.agent}
            onChange={(value) => set("agent")(value ?? "")}
          />
        )}
        <GridSpan columns={pickAgent ? 1 : "full"}>
          <TextInput label="Name" placeholder="Weekly dependency check" value={form.name} onChange={set("name")} />
        </GridSpan>
        <GridSpan columns="full">
          <VStack gap={2}>
            <TextInput label="When" value={form.when} onChange={set("when")} placeholder='0 9 * * 1-5, @daily or "every 6h"' />
            <HStack gap={1.5} wrap="wrap">
              {PRESETS.map((preset) => (
                <Button key={preset.when} label={preset.label} size="sm" variant={form.when === preset.when ? "primary" : "secondary"} onClick={() => set("when")(preset.when)} />
              ))}
            </HStack>
            {preview?.error ? (
              <ErrorText>{preview.error}</ErrorText>
            ) : preview?.description ? (
              <Meta block>
                Runs {preview.description}. Next: {preview.upcoming.map(localTime).join(", ")} (your time).
              </Meta>
            ) : (
              <Meta block>A cron expression (minute hour day month weekday), a shortcut like @daily, or an interval like every 6h.</Meta>
            )}
          </VStack>
        </GridSpan>
        <VStack gap={1}>
          <TextInput label="Time zone" placeholder={defaultTimezone} value={form.timezone} onChange={set("timezone")} description={`For cron times. Empty: ${defaultTimezone}.`} />
          {browserZone && browserZone !== zone && (
            <HStack>
              <Button label={`Use ${browserZone}`} size="sm" variant="ghost" onClick={() => set("timezone")(browserZone)} />
            </HStack>
          )}
        </VStack>
        <SuggestInput label="Repository" placeholder="owner/repo" suggestions={repos} value={form.repo} onChange={(value) => set("repo")(value.trim())} />
        <TextInput
          label="Issue or PR number"
          placeholder="optional"
          value={form.number}
          onChange={(value) => set("number")(value.replace(/\D/g, ""))}
          description="Each run works and replies there. Empty: the first run opens an issue for this schedule."
        />
        <Field label="Stop after" inputID="schedule-max" description="Optional: a number of runs, an end date, or both.">
          <HStack gap={2} vAlign="start">
            <TextInput label="Runs" isLabelHidden placeholder="runs" width={90} value={form.maxRuns} onChange={(value) => set("maxRuns")(value.replace(/\D/g, ""))} id="schedule-max" />
            <DateInput label="End date" isLabelHidden hasClear value={(form.endsAt || undefined) as ISODateString | undefined} onChange={(value) => set("endsAt")(value ?? "")} placeholder="end date" />
          </HStack>
        </Field>
        <GridSpan columns="full">
          <VStack gap={1}>
            <TextInput label="Base branch" placeholder={usual?.branch ?? "default branch"} value={form.baseBranch} onChange={(value) => set("baseBranch")(value.trim())} />
            <Meta block>
              Where the runs' pull requests go. Empty:{" "}
              {usual?.branch ? (
                <>
                  <Code size="inherit">{usual.branch}</Code> (set {usual.from})
                </>
              ) : (
                "the repository's default branch"
              )}
              .
            </Meta>
          </VStack>
        </GridSpan>
        <GridSpan columns="full">
          <TextArea
            label="What to do each run"
            rows={5}
            placeholder="Check for outdated dependencies. Open one pull request updating the ones that are safe to update, and list the rest."
            value={form.prompt}
            onChange={set("prompt")}
            description="The same request every run, so write it to make sense on its own. The agent sees its earlier runs on the thread."
          />
        </GridSpan>
      </Grid>
      {error && <ErrorText>{error}</ErrorText>}
    </Dialog>
  );
}
