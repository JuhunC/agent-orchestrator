import { useCallback, useEffect, useState } from "react";
import {
  AppShell,
  Badge,
  Button,
  Heading,
  HStack,
  Icon,
  Layout,
  LayoutContent,
  LayoutHeader,
  NavIcon,
  SideNav,
  SideNavHeading,
  SideNavItem,
  SideNavSection,
  StackItem,
  StatusDot,
  Text,
  VStack,
} from "@astryxdesign/core";
import { Bot, CalendarClock, History as HistoryIcon, LayoutDashboard, LibraryBig, ListTodo, Settings as SettingsIcon, SquareKanban, Users, Webhook } from "lucide-react";
import { api, connectStream, disconnectStream, onUnauthorized, useApi, useStreamStatus, type Overview, type Settings } from "./api.ts";
import { AgentDetail } from "./pages/AgentDetail.tsx";
import { Agents } from "./pages/Agents.tsx";
import { Library } from "./pages/Library.tsx";
import { BoardDetail, Boards } from "./pages/Boards.tsx";
import { GroupDetail, Groups } from "./pages/Groups.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { Deliveries } from "./pages/Deliveries.tsx";
import { History, ThreadDetail } from "./pages/History.tsx";
import { Login } from "./pages/Login.tsx";
import { Schedules } from "./pages/Schedules.tsx";
import { Settings as SettingsPage } from "./pages/Settings.tsx";
import { TaskDetail } from "./pages/TaskDetail.tsx";
import { Tasks } from "./pages/Tasks.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { Meta, Notice } from "./components/ui.tsx";
import { href, useRoute } from "./router.ts";

interface Me {
  login: string | null;
  /** admin: changes anything. operator: runs the queue. viewer: only looks. */
  role?: "admin" | "operator" | "viewer" | null;
  githubLogin: boolean;
  authDisabled: boolean;
  callbackUrl?: string;
  /** Why "Sign in with GitHub" will fail, when the server can tell. */
  signInProblem?: string | null;
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
  } else if (section === "boards" && rest[0]) {
    title = "Board";
    page = <BoardDetail key={rest[0]} name={rest[0]} />;
  } else if (section === "boards") {
    title = "Boards";
    page = <Boards />;
  } else if (section === "groups" && rest[0]) {
    title = "Group";
    page = <GroupDetail key={rest[0]} name={rest[0]} />;
  } else if (section === "groups") {
    title = "Groups";
    page = <Groups />;
  } else if (section === "schedules") {
    title = "Schedules";
    page = <Schedules />;
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
    { path: "/", key: "", label: "Dashboard", icon: LayoutDashboard, count: overview?.running.length || null },
    { path: "/tasks", key: "tasks", label: "Tasks", icon: ListTodo, count: overview?.queued.length || null },
    { path: "/agents", key: "agents", label: "Agents", icon: Bot, count: null },
    { path: "/groups", key: "groups", label: "Groups", icon: Users, count: null },
    { path: "/library", key: "library", label: "Library", icon: LibraryBig, count: null },
    { path: "/boards", key: "boards", label: "Boards", icon: SquareKanban, count: null },
    { path: "/schedules", key: "schedules", label: "Schedules", icon: CalendarClock, count: null },
    { path: "/history", key: "history", label: "History", icon: HistoryIcon, count: null },
    { path: "/deliveries", key: "deliveries", label: "Webhooks", icon: Webhook, count: null },
    { path: "/settings", key: "settings", label: "Settings", icon: SettingsIcon, count: null },
  ];

  const togglePause = async () => {
    if (settings) await api.put("/api/settings", { paused: !settings.paused });
  };

  const sideNav = (
    <SideNav
      header={<SideNavHeading heading="Orchestrator" headingHref={href("/")} icon={<NavIcon icon={<Icon icon={Bot} size="sm" />} />} />}
      footer={
        <VStack gap={2} padding={2}>
          <HStack gap={2} vAlign="center">
            <StatusDot variant={live ? "success" : "warning"} label={live ? "Live" : "Reconnecting"} isPulsing={!live} />
            <Text type="supporting">{live ? "Live" : "Reconnecting…"}</Text>
          </HStack>
          <Meta block>
            Signed in as {me.login}
            {me.role && me.role !== "admin" ? ` (${me.role})` : ""}
          </Meta>
          {!me.authDisabled && (
            <HStack>
              <Button label="Sign out" size="sm" onClick={onSignOut} />
            </HStack>
          )}
        </VStack>
      }
    >
      <SideNavSection title="Pages" isHeaderHidden>
        {nav.map((item) => (
          <SideNavItem
            key={item.key}
            label={item.label}
            icon={item.icon}
            href={href(item.path)}
            isSelected={section === item.key}
            endContent={item.count ? <Badge variant="neutral" label={String(item.count)} /> : undefined}
          />
        ))}
      </SideNavSection>
    </SideNav>
  );

  return (
    <AppShell sideNav={sideNav}>
      <Layout
        height="fill"
        header={
          <LayoutHeader hasDivider>
            <HStack gap={3} vAlign="center" wrap="wrap">
              <StackItem size="fill">
                <Heading level={1} maxLines={1}>
                  {title}
                </Heading>
              </StackItem>
              {settings && (
                <HStack gap={3} vAlign="center" wrap="wrap">
                  <Meta>
                    {settings.running}/{settings.effectiveConcurrent ?? settings.maxConcurrent} slots busy
                    {settings.effectiveConcurrent !== undefined && settings.effectiveConcurrent < settings.maxConcurrent ? ` (of ${settings.maxConcurrent}: the model service is rate limiting)` : ""}
                  </Meta>
                  <Button label={settings.paused ? "Resume queue" : "Pause queue"} variant={settings.paused ? "primary" : "secondary"} isDisabled={me.role === "viewer"} onClick={() => void togglePause()} />
                </HStack>
              )}
            </HStack>
          </LayoutHeader>
        }
        content={
          <LayoutContent padding={4}>
            <VStack gap={4}>
              {me.role === "viewer" && <Notice tone="info" title="You can look around, but not change anything: you're signed in as a viewer." />}
              {me.role === "operator" && section === "settings" && <Notice tone="info" title="As an operator you can pause the queue and run, stop and retry agents, but not change configuration." />}
              <ErrorBoundary resetKey={route.path}>{page}</ErrorBoundary>
            </VStack>
          </LayoutContent>
        }
      />
    </AppShell>
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
  if (!me.login) return <Login githubLogin={me.githubLogin} callbackUrl={me.callbackUrl ?? null} signInProblem={me.signInProblem ?? null} onSignedIn={() => void load()} />;
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
