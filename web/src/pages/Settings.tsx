import { useEffect, useState } from "react";
import { api, useApi, type Installation, type ModelInfo, type Settings as SettingsData, type Setup } from "../api.ts";
import { Empty, Panel, Switch } from "../components/ui.tsx";
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
    <div className="stack" style={{ gap: 14 }}>
      <p style={{ margin: 0 }}>
        Create the GitHub App in one step: GitHub shows you the app's settings, you confirm, and the credentials come back here automatically. Then install the
        app on the repositories the agents should work on.
      </p>
      {elsewhere && (
        <div className="banner error">
          <span>
            You opened this page at {window.location.origin}, but PUBLIC_URL is {setup.publicUrl}. The App would be created for {setup.publicUrl}: its Callback URL (for
            "Sign in with GitHub") and webhooks would point there. Set PUBLIC_URL to the address people and GitHub use, restart the orchestrator, then create the App.
          </span>
        </div>
      )}
      {localOnly && (
        <div className="banner">
          PUBLIC_URL is {setup.publicUrl}, which GitHub can't reach. Webhooks won't arrive unless you set PUBLIC_URL to this server's public address, or set
          WEBHOOK_PROXY_URL to a smee.io channel.
        </div>
      )}
      <div className="form-grid">
        <div className="field">
          <label htmlFor="app-name">App name</label>
          <input id="app-name" value={name} onChange={(event) => setName(event.target.value)} />
          <span className="help">Must be unique on {new URL(setup.githubUrl).host}.</span>
        </div>
        <div className="field">
          <label htmlFor="app-org">Organization (optional)</label>
          <input id="app-org" value={org} placeholder="Leave empty for your account" onChange={(event) => setOrg(event.target.value)} />
        </div>
      </div>
      <dl className="kv">
        <dt>Webhook URL</dt>
        <dd className="mono">{setup.webhookUrl}</dd>
        <dt>Permissions</dt>
        <dd>Contents, issues, pull requests, discussions, workflows: read &amp; write · Metadata: read</dd>
        <dt>Events</dt>
        <dd>Issues, issue comments, pull requests, reviews, review comments, discussions, discussion comments</dd>
      </dl>
      <div className="row">
        <button className="primary" disabled={!name.trim()} onClick={create}>
          Create GitHub App on {new URL(setup.githubUrl).host}
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
      <p className="meta" style={{ margin: 0 }}>
        Already have an app? Set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET (and GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET for GitHub sign-in)
        and restart.
      </p>
    </div>
  );
}

function Installations({ setup }: { setup: Setup }) {
  const { data, error } = useApi<Installation[]>("/api/installations");
  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <Empty>Loading installations…</Empty>;
  return (
    <div className="stack" style={{ gap: 10 }}>
      {data.length === 0 && <span className="meta">The app isn't installed anywhere yet.</span>}
      {data.map((installation) => (
        <div key={installation.id} className="row" style={{ alignItems: "flex-start" }}>
          <b style={{ minWidth: 140 }}>{installation.account}</b>
          <span className="grow meta">
            {installation.selection === "all" ? "All repositories" : installation.repositories.join(", ") || "No repositories selected"}
            {installation.totalRepositories > installation.repositories.length && ` (+${installation.totalRepositories - installation.repositories.length} more)`}
          </span>
          <a className="button small" href={installation.htmlUrl} target="_blank" rel="noreferrer">
            Configure ↗
          </a>
        </div>
      ))}
      {setup.app?.installUrl && (
        <div>
          <a className="button primary" href={setup.app.installUrl} target="_blank" rel="noreferrer">
            Install on repositories ↗
          </a>
        </div>
      )}
    </div>
  );
}

/** The App's settings on GitHub don't match PUBLIC_URL: say what to change, and fix the webhook URL for them. */
const mb = (kb: number | null) => (kb === null ? "?" : kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GB` : `${Math.round(kb / 1024)} MB`);

/** Agents' checkouts: unused ones are removed after a while, unless they hold unpublished work. */
function Workspaces({ info, onDone }: { info: SettingsData["workspaces"]; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const report = info.lastCleanup;
  return (
    <Panel title="Workspaces" hint={info.retentionDays ? `unused ones are removed after ${info.retentionDays} days` : "kept forever (WORKSPACE_RETENTION_DAYS=0)"}>
      <div className="stack" style={{ gap: 8 }}>
        {report ? (
          <div className="meta">
            {report.remaining} checkout{report.remaining === 1 ? "" : "s"}, {mb(report.remainingKb)}. Last cleanup {new Date(report.at).toLocaleString()}: removed {report.removed.length} ({mb(report.freedKb)}).
          </div>
        ) : (
          <div className="meta">Not cleaned up yet.</div>
        )}
        {report?.kept.length ? (
          <details>
            <summary className="meta">Kept {report.kept.length} unused checkout{report.kept.length === 1 ? "" : "s"} with work that isn't on GitHub</summary>
            {report.kept.map((entry) => (
              <div key={entry.path} className="meta">
                <code>{entry.path}</code>: {entry.reason}
              </div>
            ))}
          </details>
        ) : null}
        <div>
          <button
            disabled={busy || !info.retentionDays}
            onClick={async () => {
              setBusy(true);
              try {
                await api.post("/api/workspaces/cleanup");
                onDone();
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Cleaning up…" : "Clean up now"}
          </button>
        </div>
        <div className="meta">Each agent keeps a full clone per thread. The next task on a thread clones it again. History can remove one by hand.</div>
      </div>
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
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div className="field" style={{ maxWidth: 160 }}>
          <label htmlFor="spend-daily">Daily limit (US$)</label>
          <input id="spend-daily" inputMode="decimal" placeholder="none" value={daily} onChange={(event) => setDaily(clean(event.target.value))} />
        </div>
        <div className="field" style={{ maxWidth: 160 }}>
          <label htmlFor="spend-monthly">Monthly limit (US$)</label>
          <input id="spend-monthly" inputMode="decimal" placeholder="none" value={monthly} onChange={(event) => setMonthly(clean(event.target.value))} />
        </div>
        <button disabled={same(daily, spend.dailyUsd) && same(monthly, spend.monthlyUsd)} onClick={() => onSave({ spendLimitDailyUsd: Number(daily) || null, spendLimitMonthlyUsd: Number(monthly) || null })}>
          Save limits
        </button>
      </div>
      <div className="meta">
        Spent ${spend.today.toFixed(2)} today and ${spend.month.toFixed(2)} this month (UTC, Claude Code's estimates). When a limit is reached, new tasks wait until the next day or month; running ones finish.
      </div>
      {blocked && <div className="banner error">{blocked}</div>}
    </div>
  );
}

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
    <div className="banner error">
      <div className="stack" style={{ gap: 8 }}>
        <b>The GitHub App's settings don't match PUBLIC_URL ({setup.publicUrl})</b>
        {setup.callbackProblem && <span>{setup.callbackProblem}</span>}
        {setup.webhookProblem && <span>{setup.webhookProblem}</span>}
        <div className="row">
          {settingsUrl && (
            <a className="button small" href={settingsUrl} target="_blank" rel="noreferrer">
              Open the App's settings on GitHub ↗
            </a>
          )}
          {setup.webhookProblem && (
            <button className="small primary" disabled={busy} onClick={fixWebhook}>
              {busy ? "Updating…" : `Send webhooks to ${setup.webhookUrl}`}
            </button>
          )}
        </div>
        {setup.callbackProblem && <span className="meta">GitHub doesn't let an app change its own Callback URL, so that one is a change on GitHub. This notice goes away once the Homepage URL matches too.</span>}
        {error && <span className="error-text">{error}</span>}
      </div>
    </div>
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
    <div className="stack">
      {setupResult === "created" && <div className="banner info">The GitHub App was created. Install it on your repositories below to start.</div>}
      {setupResult === "expired" && <div className="banner error">That setup link expired or was already used. Start again.</div>}
      {setupResult === "error" && <div className="banner error">GitHub App setup failed: {route.query.get("message")}</div>}

      {setup.app && (setup.callbackProblem || setup.webhookProblem) && <AddressProblems setup={setup} onFixed={() => void reload()} />}

      {data.isolation.problem ? (
        <div className="banner error">
          <span>
            <b>{data.isolation.required ? "Agents won't run: they can't be isolated." : "Agents can read the orchestrator's secrets."}</b> {data.isolation.problem}
          </span>
        </div>
      ) : data.isolation.mode !== "off" ? (
        <div className="banner info">
          Agents run as the separate user <code>{data.isolation.user}</code>, which can't read the orchestrator's keys, tokens or database.
        </div>
      ) : null}

      <Panel title="GitHub App" hint={setup.app ? (setup.app.source === "env" ? "from environment variables" : "created here") : "not connected"}>
        {setup.app ? (
          <div className="stack" style={{ gap: 16 }}>
            <dl className="kv">
              <dt>App</dt>
              <dd>
                {setup.app.htmlUrl ? (
                  <a href={setup.app.htmlUrl} target="_blank" rel="noreferrer">
                    {setup.app.slug || `App ${setup.app.appId}`} ↗
                  </a>
                ) : (
                  setup.app.slug || `App ${setup.app.appId}`
                )}{" "}
                <span className="meta">id {setup.app.appId}</span>
              </dd>
              <dt>Bot user</dt>
              <dd className="mono">{setup.app.slug ? `${setup.app.slug}[bot]` : "—"}</dd>
              <dt>Webhook URL</dt>
              <dd className="mono">{setup.webhookUrl}</dd>
              <dt>Callback URL</dt>
              <dd className="mono">{setup.callbackUrl}</dd>
              <dt>GitHub sign-in</dt>
              <dd>{setup.app.githubLogin ? `on, for ${[...setup.adminUsers, setup.app.ownerLogin].filter(Boolean).join(", ") || "nobody yet — set ADMIN_USERS"}` : "off (no client secret)"}</dd>
            </dl>
            <div>
              <h3 style={{ marginBottom: 8 }}>Installations</h3>
              <Installations setup={setup} />
            </div>
          </div>
        ) : (
          <CreateApp setup={setup} />
        )}
      </Panel>

      <div className="grid-2">
        <Panel title="Queue">
          <div className="stack" style={{ gap: 14 }}>
            <div className="check">
              <Switch checked={!data.paused} onChange={(running) => void update({ paused: !running })} label="Run queued tasks" />
              {data.paused ? "Paused — queued tasks wait" : "Running queued tasks"}
            </div>
            <div className="field" style={{ maxWidth: 260 }}>
              <label htmlFor="max-concurrent">Agents running at once</label>
              <div className="row" style={{ flexWrap: "nowrap" }}>
                <input id="max-concurrent" inputMode="numeric" value={maxConcurrent} onChange={(event) => setMaxConcurrent(event.target.value.replace(/\D/g, ""))} />
                <button disabled={!maxConcurrent || Number(maxConcurrent) === data.maxConcurrent} onClick={() => void update({ maxConcurrent: Number(maxConcurrent) })}>
                  Save
                </button>
              </div>
            </div>
            <SpendLimits spend={data.spend} blocked={data.spendBlocked} onSave={(body) => void update(body)} />
            <div>
              <button
                className="danger"
                onClick={() => {
                  if (confirm("Stop every running agent and clear the queue?")) void api.post("/api/tasks/cancel-all");
                }}
              >
                Stop everything
              </button>
            </div>
          </div>
        </Panel>

        <ModelPanel />
      </div>

      <div className="grid-2">
        <LivePanel settings={data} onSave={update} />
        <Workspaces info={data.workspaces} onDone={() => void reload()} />
        <Panel title="Environment" hint="set with environment variables">
          <dl className="kv">
            <dt>GITHUB_URL</dt>
            <dd className="mono">{setup.githubUrl}</dd>
            <dt>API</dt>
            <dd className="mono">{setup.apiUrl}</dd>
            <dt>PUBLIC_URL</dt>
            <dd className="mono">{setup.publicUrl}</dd>
            <dt>Who can start agents</dt>
            <dd>{setup.triggerMinPermission} access or higher</dd>
            <dt>Repositories</dt>
            <dd>{setup.allowedRepos.length ? setup.allowedRepos.join(", ") : "any the app is installed on"}</dd>
            <dt>Label</dt>
            <dd className="mono">{setup.labelPrefix && setup.labelPrefix !== "none" ? `${setup.labelPrefix}<agent>` : "off"}</dd>
            <dt>Timeout</dt>
            <dd>{setup.defaultTimeoutMinutes} min</dd>
            <dt>Profiles</dt>
            <dd className="mono">{setup.profilesDir}</dd>
          </dl>
        </Panel>
      </div>
    </div>
  );
}

function ModelPanel() {
  const { data } = useApi<ModelInfo>("/api/model", (message) => message.type === "limits");
  return (
    <Panel title="Model service" hint="ANTHROPIC_* environment variables">
      {!data ? (
        <Empty>Loading…</Empty>
      ) : (
        <div className="stack" style={{ gap: 12 }}>
          <dl className="kv">
            <dt>Endpoint</dt>
            <dd className="mono">
              {data.baseUrl} {data.custom && <span className="badge accent">custom</span>}
            </dd>
            <dt>Model</dt>
            <dd className="mono">{data.model ?? "Claude Code default"}</dd>
            <dt>Credential</dt>
            <dd>{data.credential ? <code>{data.credential}</code> : <span className="error-text">none set — agents can't run</span>}</dd>
            <dt>Usage limit</dt>
            <dd>{data.limit ? `reached; resets ${new Date(data.limit.until).toLocaleString()}` : "not limited"}</dd>
          </dl>
          {data.limit && (
            <div>
              <button onClick={() => void api.del("/api/limit")}>Clear limit and retry now</button>
            </div>
          )}
        </div>
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
      <div className="form-grid">
        <div className="field">
          <label htmlFor="live-idle">Keep a session open after its last task (minutes)</label>
          <input id="live-idle" inputMode="numeric" value={idle} onChange={(event) => setIdle(event.target.value.replace(/\D/g, ""))} />
        </div>
        <div className="field">
          <label htmlFor="live-max">Open sessions at most</label>
          <input id="live-max" inputMode="numeric" value={max} onChange={(event) => setMax(event.target.value.replace(/\D/g, ""))} />
        </div>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button disabled={!dirty || !Number(idle) || !Number(max)} onClick={() => void onSave({ liveIdleMinutes: Number(idle), maxLiveSessions: Number(max) })}>
          Save
        </button>
        <span className="meta">Closed sessions resume from their saved conversation next time.</span>
      </div>
    </Panel>
  );
}
