import { useCallback, useEffect, useState } from "react";
import { api, connectStream, disconnectStream, onUnauthorized, useApi, useStreamStatus, type Overview, type Settings } from "./api.ts";
import { AgentDetail } from "./pages/AgentDetail.tsx";
import { Agents } from "./pages/Agents.tsx";
import { Library } from "./pages/Library.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { Deliveries } from "./pages/Deliveries.tsx";
import { History, ThreadDetail } from "./pages/History.tsx";
import { Login } from "./pages/Login.tsx";
import { Settings as SettingsPage } from "./pages/Settings.tsx";
import { TaskDetail } from "./pages/TaskDetail.tsx";
import { Tasks } from "./pages/Tasks.tsx";
import { href, useRoute } from "./router.ts";

interface Me {
  login: string | null;
  githubLogin: boolean;
  authDisabled: boolean;
}

function Shell({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const route = useRoute();
  const live = useStreamStatus();
  const { data: overview } = useApi<Overview>("/api/overview", (message) => message.type === "task" || message.type === "settings");
  const settings: Settings | undefined = overview?.settings;
  const [section = "", ...rest] = route.parts;

  useEffect(() => {
    connectStream();
    return () => disconnectStream();
  }, []);

  let title = "Dashboard";
  let page = <Dashboard />;
  if (section === "tasks" && rest[0]) {
    title = `Task #${rest[0]}`;
    page = <TaskDetail key={rest[0]} id={Number(rest[0])} />;
  } else if (section === "tasks") {
    title = "Tasks";
    page = <Tasks />;
  } else if (section === "agents" && rest[0]) {
    title = "Agent";
    page = <AgentDetail key={rest[0]} name={rest[0]} />;
  } else if (section === "agents") {
    title = "Agents";
    page = <Agents />;
  } else if (section === "library") {
    title = "Library";
    page = <Library />;
  } else if (section === "history" && rest.length === 4) {
    title = "Thread history";
    page = <ThreadDetail key={rest.join("/")} owner={rest[0]!} repo={rest[1]!} kind={rest[2]!} number={rest[3]!} />;
  } else if (section === "history") {
    title = "History";
    page = <History />;
  } else if (section === "deliveries") {
    title = "Webhooks";
    page = <Deliveries />;
  } else if (section === "settings") {
    title = "Settings";
    page = <SettingsPage />;
  }

  const nav = [
    { path: "/", key: "", label: "Dashboard", count: overview?.running.length || null },
    { path: "/tasks", key: "tasks", label: "Tasks", count: overview?.queued.length || null },
    { path: "/agents", key: "agents", label: "Agents", count: null },
    { path: "/library", key: "library", label: "Library", count: null },
    { path: "/history", key: "history", label: "History", count: null },
    { path: "/deliveries", key: "deliveries", label: "Webhooks", count: null },
    { path: "/settings", key: "settings", label: "Settings", count: null },
  ];

  const togglePause = async () => {
    if (settings) await api.put("/api/settings", { paused: !settings.paused });
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            ◉
          </span>
          Orchestrator
        </div>
        <nav className="nav">
          {nav.map((item) => (
            <a key={item.key} href={href(item.path)} className={section === item.key ? "active" : ""}>
              {item.label}
              {item.count ? <span className="count">{item.count}</span> : null}
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className={`live${live ? " on" : ""}`}>{live ? "Live" : "Reconnecting…"}</span>
          <span>Signed in as {me.login}</span>
          {!me.authDisabled && (
            <button className="small" onClick={onSignOut}>
              Sign out
            </button>
          )}
        </div>
      </aside>
      <main className="main">
        <div className="page-head">
          <h1>{title}</h1>
          <span className="spacer" />
          {settings && (
            <>
              <span className="meta">
                {settings.running}/{settings.maxConcurrent} slots busy
              </span>
              <button className={settings.paused ? "primary" : ""} onClick={togglePause}>
                {settings.paused ? "Resume queue" : "Pause queue"}
              </button>
            </>
          )}
        </div>
        {page}
      </main>
    </div>
  );
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);

  const load = useCallback(async () => {
    setMe(await api.get<Me>("/api/auth/me"));
  }, []);

  useEffect(() => {
    void load();
    return onUnauthorized(() => setMe((current) => (current ? { ...current, login: null } : current)));
  }, [load]);

  if (!me) return null;
  if (!me.login) return <Login githubLogin={me.githubLogin} onSignedIn={() => void load()} />;
  return (
    <Shell
      me={me}
      onSignOut={async () => {
        await api.post("/api/auth/logout");
        disconnectStream();
        void load();
      }}
    />
  );
}
