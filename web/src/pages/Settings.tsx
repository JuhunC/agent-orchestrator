import { useEffect, useState } from "react";
import { api, useApi, type Installation, type Settings as SettingsData, type Setup } from "../api.ts";
import { Empty, Panel, Switch } from "../components/ui.tsx";
import { useRoute } from "../router.ts";

function CreateApp({ setup }: { setup: Setup }) {
  const [name, setName] = useState("Agent Orchestrator");
  const [org, setOrg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const localOnly = /\/\/(localhost|127\.0\.0\.1)/.test(setup.publicUrl) && !setup.webhookProxy;

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

  const update = async (body: Partial<SettingsData>) => {
    await api.put("/api/settings", body);
    void reload();
  };

  return (
    <div className="stack">
      {setupResult === "created" && <div className="banner info">The GitHub App was created. Install it on your repositories below to start.</div>}
      {setupResult === "expired" && <div className="banner error">That setup link expired or was already used. Start again.</div>}
      {setupResult === "error" && <div className="banner error">GitHub App setup failed: {route.query.get("message")}</div>}

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
            <dt>Agents file</dt>
            <dd className="mono">{setup.agentsConfigPath}</dd>
          </dl>
        </Panel>
      </div>
    </div>
  );
}
