import { useEffect, useState } from "react";
import { Button, Code, Collapsible, Grid, Heading, HStack, StackItem, Switch as AstryxSwitch, Text, TextInput, VStack } from "@astryxdesign/core";
import { AuditLog } from "../components/AuditLog.tsx";
import { Backups } from "../components/Backups.tsx";
import { BaseBranches } from "../components/BaseBranches.tsx";
import { Guards } from "../components/Guards.tsx";
import { LiveActivityPanel } from "../components/LiveActivity.tsx";
import { api, useApi, type Installation, type ModelInfo, type Settings as SettingsData, type Setup } from "../api.ts";
import { A, Columns, Empty, ErrorText, KV, LinkButton, Meta, Notice, Panel, Tag } from "../components/ui.tsx";
import { useRoute } from "../router.ts";

function CreateApp({ setup }: { setup: Setup }) {
  const [name, setName] = useState("Agent Orchestrator");
  const [org, setOrg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const localOnly = /\/\/(localhost|127\.0\.0\.1)/.test(setup.publicUrl) && !setup.webhookProxy;
  // The App is created for PUBLIC_URL (its Callback and webhook URLs), not for the address in the browser.
  const elsewhere = new URL(setup.publicUrl).origin !== window.location.origin;

  const create = async () => {
    setError(null);
    try {
      const { action, manifest } = await api.post<{ action: string; manifest: string }>("/api/setup/manifest", { name, org });
      // GitHub's manifest flow needs a real form POST to its site.
      const form = document.createElement("form");
      form.method = "post";
      form.action = action;
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "manifest";
      input.value = manifest;
      form.appendChild(input);
      document.body.appendChild(form);
      form.submit();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <VStack gap={4}>
      <Text>
        Create the GitHub App in one step: GitHub shows you the app's settings, you confirm, and the credentials come back here automatically. Then install the app on the repositories the agents should work
        on.
      </Text>
      {elsewhere && (
        <Notice tone="error" title={`You opened this page at ${window.location.origin}, but PUBLIC_URL is ${setup.publicUrl}.`}>
          The App would be created for {setup.publicUrl}: its Callback URL (for "Sign in with GitHub") and webhooks would point there. Set PUBLIC_URL to the address people and GitHub use, restart the
          orchestrator, then create the App.
        </Notice>
      )}
      {localOnly && (
        <Notice title={`PUBLIC_URL is ${setup.publicUrl}, which GitHub can't reach.`}>
          Webhooks won't arrive unless you set PUBLIC_URL to this server's public address, or set WEBHOOK_PROXY_URL to a smee.io channel.
        </Notice>
      )}
      <Grid columns={{ minWidth: 240 }} gap={4}>
        <TextInput label="App name" value={name} onChange={setName} description={`Must be unique on ${new URL(setup.githubUrl).host}.`} />
        <TextInput label="Organization" isOptional value={org} placeholder="Leave empty for your account" onChange={setOrg} />
      </Grid>
      <KV
        items={[
          ["Webhook URL", <Code size="inherit">{setup.webhookUrl}</Code>],
          ["Permissions", "Contents, issues, pull requests, discussions, workflows: read & write · Metadata: read"],
          ["Events", "Issues, issue comments, pull requests, reviews, review comments, discussions, discussion comments"],
        ]}
      />
      <HStack>
        <Button label={`Create GitHub App on ${new URL(setup.githubUrl).host}`} variant="primary" isDisabled={!name.trim()} onClick={() => void create()} />
      </HStack>
      {error && <ErrorText>{error}</ErrorText>}
      <Meta block>
        Already have an app? Set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET (and GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET for GitHub sign-in) and restart.
      </Meta>
    </VStack>
  );
}

function Installations({ setup }: { setup: Setup }) {
  const { data, error } = useApi<Installation[]>("/api/installations");
  if (error) return <Notice tone="error" title={error} />;
  if (!data) return <Meta>Loading installations…</Meta>;
  return (
    <VStack gap={3}>
      {data.length === 0 && <Meta>The app isn't installed anywhere yet.</Meta>}
      {data.map((installation) => (
        <HStack key={installation.id} gap={3} vAlign="start" wrap="wrap">
          <Text weight="semibold">{installation.account}</Text>
          <StackItem size="fill">
            <Meta>
              {installation.selection === "all" ? "All repositories" : installation.repositories.join(", ") || "No repositories selected"}
              {installation.totalRepositories > installation.repositories.length && ` (+${installation.totalRepositories - installation.repositories.length} more)`}
            </Meta>
          </StackItem>
          <LinkButton to={installation.htmlUrl} label="Configure" external size="sm" />
        </HStack>
      ))}
      {setup.app?.installUrl && (
        <HStack>
          <LinkButton to={setup.app.installUrl} label="Install on repositories" external variant="primary" />
        </HStack>
      )}
    </VStack>
  );
}

const mb = (kb: number | null) => (kb === null ? "?" : kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GB` : `${Math.round(kb / 1024)} MB`);

/** Agents' checkouts: unused ones are removed after a while, unless they hold unpublished work. */
function Workspaces({ info, onDone }: { info: SettingsData["workspaces"]; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const report = info.lastCleanup;
  return (
    <Panel title="Workspaces" hint={info.retentionDays ? `unused ones are removed after ${info.retentionDays} days` : "kept forever (WORKSPACE_RETENTION_DAYS=0)"}>
      {report ? (
        <Meta block>
          {report.remaining} checkout{report.remaining === 1 ? "" : "s"}, {mb(report.remainingKb)}. Last cleanup {new Date(report.at).toLocaleString()}: removed {report.removed.length} ({mb(report.freedKb)}).
        </Meta>
      ) : (
        <Meta block>Not cleaned up yet.</Meta>
      )}
      {report?.kept.length ? (
        <Collapsible trigger={<Meta>{`Kept ${report.kept.length} unused checkout${report.kept.length === 1 ? "" : "s"} with work that isn't on GitHub`}</Meta>} defaultIsOpen={false}>
          <VStack gap={1}>
            {report.kept.map((entry) => (
              <Meta key={entry.path} block>
                <Code size="inherit">{entry.path}</Code>: {entry.reason}
              </Meta>
            ))}
          </VStack>
        </Collapsible>
      ) : null}
      <HStack>
        <Button
          label={busy ? "Cleaning up…" : "Clean up now"}
          isDisabled={busy || !info.retentionDays}
          onClick={async () => {
            setBusy(true);
            try {
              await api.post("/api/workspaces/cleanup");
              onDone();
            } finally {
              setBusy(false);
            }
          }}
        />
      </HStack>
      <Meta block>Each agent keeps a full clone per thread. The next task on a thread clones it again. History can remove one by hand.</Meta>
    </Panel>
  );
}

/** Spending limits for all agents together: new tasks wait once one is reached. */
function SpendLimits({ spend, blocked, onSave }: { spend: SettingsData["spend"]; blocked: string | null; onSave: (body: Partial<{ spendLimitDailyUsd: number | null; spendLimitMonthlyUsd: number | null }>) => void }) {
  const [daily, setDaily] = useState(spend.dailyUsd ? String(spend.dailyUsd) : "");
  const [monthly, setMonthly] = useState(spend.monthlyUsd ? String(spend.monthlyUsd) : "");
  const clean = (value: string) => value.replace(/[^\d.]/g, "");
  const same = (value: string, current: number | null) => (Number(value) || null) === current;
  return (
    <VStack gap={2}>
      <HStack gap={3} wrap="wrap" vAlign="end">
        <TextInput label="Daily limit (US$)" width={160} inputMode="decimal" placeholder="none" value={daily} onChange={(value) => setDaily(clean(value))} />
        <TextInput label="Monthly limit (US$)" width={160} inputMode="decimal" placeholder="none" value={monthly} onChange={(value) => setMonthly(clean(value))} />
        <Button
          label="Save limits"
          isDisabled={same(daily, spend.dailyUsd) && same(monthly, spend.monthlyUsd)}
          onClick={() => onSave({ spendLimitDailyUsd: Number(daily) || null, spendLimitMonthlyUsd: Number(monthly) || null })}
        />
      </HStack>
      <Meta block>
        Spent ${spend.today.toFixed(2)} today and ${spend.month.toFixed(2)} this month (UTC, Claude Code's estimates). When a limit is reached, new tasks wait until the next day or month; running ones finish.
      </Meta>
      {blocked && <Notice tone="error" title={blocked} />}
    </VStack>
  );
}

/** The App's settings on GitHub don't match PUBLIC_URL: say what to change, and fix the webhook URL for them. */
function AddressProblems({ setup, onFixed }: { setup: Setup; onFixed: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settingsUrl = setup.appAddresses?.settingsUrl;
  const fixWebhook = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/setup/webhook-url");
      onFixed();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Notice tone="error" title={`The GitHub App's settings don't match PUBLIC_URL (${setup.publicUrl})`}>
      <VStack gap={2}>
        {setup.callbackProblem && <Text display="block">{setup.callbackProblem}</Text>}
        {setup.webhookProblem && <Text display="block">{setup.webhookProblem}</Text>}
        <HStack gap={2} wrap="wrap">
          {settingsUrl && <LinkButton to={settingsUrl} label="Open the App's settings on GitHub" external size="sm" />}
          {setup.webhookProblem && <Button label={busy ? "Updating…" : `Send webhooks to ${setup.webhookUrl}`} size="sm" variant="primary" isDisabled={busy} onClick={() => void fixWebhook()} />}
        </HStack>
        {setup.callbackProblem && (
          <Meta block>GitHub doesn't let an app change its own Callback URL, so that one is a change on GitHub. This notice goes away once the Homepage URL matches too.</Meta>
        )}
        {error && <ErrorText>{error}</ErrorText>}
      </VStack>
    </Notice>
  );
}

export function Settings() {
  const route = useRoute();
  const { data, reload } = useApi<SettingsData & { setup: Setup }>("/api/settings", (message) => message.type === "settings");
  const [maxConcurrent, setMaxConcurrent] = useState("");
  useEffect(() => {
    if (data) setMaxConcurrent(String(data.maxConcurrent));
  }, [data?.maxConcurrent]);

  if (!data) return <Empty>Loading…</Empty>;
  const { setup } = data;
  const setupResult = route.query.get("setup");

  const update = async (body: Partial<SettingsData> | Partial<{ spendLimitDailyUsd: number | null; spendLimitMonthlyUsd: number | null }>) => {
    await api.put("/api/settings", body);
    void reload();
  };

  return (
    <VStack gap={4}>
      {setupResult === "created" && <Notice tone="success" title="The GitHub App was created. Install it on your repositories below to start." />}
      {setupResult === "expired" && <Notice tone="error" title="That setup link expired or was already used. Start again." />}
      {setupResult === "error" && <Notice tone="error" title={`GitHub App setup failed: ${route.query.get("message")}`} />}

      {setup.app && (setup.callbackProblem || setup.webhookProblem) && <AddressProblems setup={setup} onFixed={() => void reload()} />}

      {data.isolation.problem ? (
        <Notice tone="error" title={data.isolation.required ? "Agents won't run: they can't be isolated." : "Agents can read the orchestrator's secrets."}>
          {data.isolation.problem}
        </Notice>
      ) : data.isolation.mode !== "off" ? (
        <Notice
          tone="info"
          title={
            <>
              Agents run as the separate user <Code size="inherit">{data.isolation.user ?? ""}</Code>, which can't read the orchestrator's keys, tokens or database.
            </>
          }
        />
      ) : null}

      <Panel title="GitHub App" hint={setup.app ? (setup.app.source === "env" ? "from environment variables" : "created here") : "not connected"}>
        {setup.app ? (
          <VStack gap={4}>
            <KV
              items={[
                [
                  "App",
                  <>
                    {setup.app.htmlUrl ? (
                      <A to={setup.app.htmlUrl} external>
                        {setup.app.slug || `App ${setup.app.appId}`}
                      </A>
                    ) : (
                      setup.app.slug || `App ${setup.app.appId}`
                    )}{" "}
                    <Meta>id {setup.app.appId}</Meta>
                  </>,
                ],
                ["Bot user", setup.app.slug ? <Code size="inherit">{`${setup.app.slug}[bot]`}</Code> : "—"],
                ["Webhook URL", <Code size="inherit">{setup.webhookUrl}</Code>],
                ["Callback URL", <Code size="inherit">{setup.callbackUrl}</Code>],
                ["GitHub sign-in", setup.app.githubLogin ? `on, for ${[...setup.adminUsers, setup.app.ownerLogin].filter(Boolean).join(", ") || "nobody yet — set ADMIN_USERS"}` : "off (no client secret)"],
              ]}
            />
            <VStack gap={2}>
              <Heading level={3}>Installations</Heading>
              <Installations setup={setup} />
            </VStack>
          </VStack>
        ) : (
          <CreateApp setup={setup} />
        )}
      </Panel>

      <Columns>
        <Panel title="Queue">
          <VStack gap={4}>
            <AstryxSwitch
              label={data.paused ? "Paused — queued tasks wait" : "Running queued tasks"}
              value={!data.paused}
              onChange={(running) => void update({ paused: !running })}
            />
            <HStack gap={2} vAlign="end">
              <TextInput label="Agents running at once" width={200} inputMode="numeric" value={maxConcurrent} onChange={(value) => setMaxConcurrent(value.replace(/\D/g, ""))} />
              <Button label="Save" isDisabled={!maxConcurrent || Number(maxConcurrent) === data.maxConcurrent} onClick={() => void update({ maxConcurrent: Number(maxConcurrent) })} />
            </HStack>
            <SpendLimits spend={data.spend} blocked={data.spendBlocked} onSave={(body) => void update(body)} />
            <HStack>
              <Button
                label="Stop everything"
                variant="destructive"
                onClick={() => {
                  if (confirm("Stop every running agent and clear the queue?")) void api.post("/api/tasks/cancel-all");
                }}
              />
            </HStack>
          </VStack>
        </Panel>

        <ModelPanel />
      </Columns>

      <Columns>
        <LiveActivityPanel on={data.liveActivity} onChange={(on) => void update({ liveActivity: on })} />
        <LivePanel settings={data} onSave={update} />
        <BaseBranches />
        <Workspaces info={data.workspaces} onDone={() => void reload()} />
        <Guards />
        <Backups />
        <AuditLog />
        <Panel title="Environment" hint="set with environment variables">
          <KV
            items={[
              ["GITHUB_URL", <Code size="inherit">{setup.githubUrl}</Code>],
              ["API", <Code size="inherit">{setup.apiUrl}</Code>],
              ["PUBLIC_URL", <Code size="inherit">{setup.publicUrl}</Code>],
              ["Who can start agents", `${setup.triggerMinPermission} access or higher`],
              ["Repositories", setup.allowedRepos.length ? setup.allowedRepos.join(", ") : "any the app is installed on"],
              ["Label", setup.labelPrefix && setup.labelPrefix !== "none" ? <Code size="inherit">{`${setup.labelPrefix}<agent>`}</Code> : "off"],
              ["Timeout", `${setup.defaultTimeoutMinutes} min`],
              ["Profiles", <Code size="inherit">{setup.profilesDir}</Code>],
            ]}
          />
        </Panel>
      </Columns>
    </VStack>
  );
}

function ModelPanel() {
  const { data } = useApi<ModelInfo>("/api/model", (message) => message.type === "limits");
  return (
    <Panel title="Model service" hint="ANTHROPIC_* environment variables">
      {!data ? (
        <Empty>Loading…</Empty>
      ) : (
        <VStack gap={3}>
          <KV
            items={[
              [
                "Endpoint",
                <HStack gap={1.5} vAlign="center" wrap="wrap">
                  <Code size="inherit">{data.baseUrl}</Code>
                  {data.custom && <Tag accent>custom</Tag>}
                </HStack>,
              ],
              ["Model", <Code size="inherit">{data.model ?? "Claude Code default"}</Code>],
              ["Credential", data.credential ? <Code size="inherit">{data.credential}</Code> : <ErrorText>none set — agents can't run</ErrorText>],
              ["Usage limit", data.limit ? `reached; resets ${new Date(data.limit.until).toLocaleString()}` : "not limited"],
            ]}
          />
          {data.limit && (
            <HStack>
              <Button label="Clear limit and retry now" onClick={() => void api.del("/api/limit")} />
            </HStack>
          )}
        </VStack>
      )}
    </Panel>
  );
}

function LivePanel({ settings, onSave }: { settings: SettingsData; onSave: (body: Partial<SettingsData>) => Promise<void> }) {
  const [idle, setIdle] = useState(String(settings.liveIdleMinutes));
  const [max, setMax] = useState(String(settings.maxLiveSessions));
  const dirty = Number(idle) !== settings.liveIdleMinutes || Number(max) !== settings.maxLiveSessions;
  return (
    <Panel title="Agent sessions" hint="for agents with live: true">
      <Grid columns={{ minWidth: 200 }} gap={4}>
        <TextInput label="Keep a session open after its last task (minutes)" inputMode="numeric" value={idle} onChange={(value) => setIdle(value.replace(/\D/g, ""))} />
        <TextInput label="Open sessions at most" inputMode="numeric" value={max} onChange={(value) => setMax(value.replace(/\D/g, ""))} />
      </Grid>
      <HStack gap={3} vAlign="center" wrap="wrap">
        <Button label="Save" isDisabled={!dirty || !Number(idle) || !Number(max)} onClick={() => void onSave({ liveIdleMinutes: Number(idle), maxLiveSessions: Number(max) })} />
        <Meta>Closed sessions resume from their saved conversation next time.</Meta>
      </HStack>
    </Panel>
  );
}
