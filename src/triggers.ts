import { answerBlocked } from "./blocked-users.ts";
import { bus } from "./bus.ts";
import { config, repoAllowed } from "./config.ts";
import { addEvent, createTask, deliveryActedOn, isBlockedUser, queuedTaskForThread, queuedTasksOnThread, recentTaskForThread, recordDelivery, runningTasksForThread, updateTask } from "./db.ts";
import { loadProfiles, profileByHandle } from "./profiles/loader.ts";
import type { Profile } from "./profiles/types.ts";
import { accountLogins, agentAccount, agentForLogin as agentOfAccount, clientFor, isRecentOwnWrite } from "./github/accounts.ts";
import { installationClient, type GitHubClient } from "./github/app.ts";
import { addEyesReaction, markAgentOnThread, permissionAtLeast, userPermission, writtenByOrchestrator } from "./github/threads.ts";
import { errorMessage, log } from "./log.ts";
import { extractMentions } from "./mentions.ts";
import { handleProjectItemWebhook } from "./boards/engine.ts";
import { activityFor, deliver } from "./runner/inbox.ts";
import { scheduler } from "./runner/scheduler.ts";
import { triageAgentFor } from "./routing.ts";
import { priorityFromLabels } from "./runner/queue-order.ts";
import { notePullEvent } from "./runner/outcomes.ts";
import { noteWaitEvent, wakeTask } from "./runner/waits.ts";
import type { Delivery, TaskPriority, ThreadKind, TriggerKind } from "./types.ts";

type Agent = Profile;

/** One "please run agent X on thread Y" derived from a webhook. */
interface Intent {
  agent: Agent;
  trigger: TriggerKind;
  kind: ThreadKind;
  number: number;
  title: string;
  url: string;
  requestText: string;
  requestUrl: string;
  /** GraphQL node id of the thing to react 👀 to. */
  reactTo: string | null;
  /** Assignment and "opened" events often arrive together; dedupe those within a short window. */
  dedupeWindow: boolean;
}

type Payload = Record<string, any>;

/** GitHub logins that also name agents: their accounts (login, lower case → agents). */
type Aliases = Map<string, Agent[]>;

/** Maps a webhook to the agents it should start. Pure apart from agent lookups. */
export function intentsFor(event: string, payload: Payload, aliases: Aliases = new Map()): Intent[] {
  // An agent is named by its handle, or by the GitHub account it acts as.
  const byName = (name: string): Agent[] => {
    const agent = profileByHandle(name);
    return agent ? [agent] : (aliases.get(name.toLowerCase()) ?? []);
  };
  const unique = (agents: Agent[]) => [...new Map(agents.map((agent) => [agent.name, agent])).values()];
  const agentsMentionedIn = (...texts: (string | null | undefined)[]): Agent[] => unique([...new Set(texts.flatMap((text) => extractMentions(text)))].flatMap(byName));
  const agentForLogin = (login: string | undefined): Agent[] => (login ? unique(byName(login)) : []);
  const action = String(payload.action ?? "");
  const intents: Intent[] = [];
  const add = (agents: Agent[], base: Omit<Intent, "agent">) => {
    for (const agent of agents) intents.push({ ...base, agent });
  };

  if (event === "issues" && payload.issue) {
    const issue = payload.issue;
    const base = {
      kind: "issue" as const,
      number: issue.number,
      title: issue.title,
      url: issue.html_url,
      requestText: [issue.title, issue.body ?? ""].join("\n\n").trim(),
      requestUrl: issue.html_url,
      reactTo: issue.node_id,
      dedupeWindow: true,
    };
    if (action === "opened") add(agentsMentionedIn(issue.title, issue.body), { ...base, trigger: "mention" });
    if (action === "assigned") add(agentForLogin(payload.assignee?.login), { ...base, trigger: "assignment" });
  }

  if (event === "pull_request" && payload.pull_request) {
    const pr = payload.pull_request;
    const base = {
      kind: "pull" as const,
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      requestText: [pr.title, pr.body ?? ""].join("\n\n").trim(),
      requestUrl: pr.html_url,
      reactTo: pr.node_id,
      dedupeWindow: true,
    };
    if (action === "opened") add(agentsMentionedIn(pr.title, pr.body), { ...base, trigger: "mention" });
    if (action === "assigned") add(agentForLogin(payload.assignee?.login), { ...base, trigger: "assignment" });
    if (action === "review_requested") add(agentForLogin(payload.requested_reviewer?.login), { ...base, trigger: "assignment" });
  }

  if (event === "issue_comment" && action === "created" && payload.comment && payload.issue) {
    const issue = payload.issue;
    add(agentsMentionedIn(payload.comment.body), {
      trigger: "mention",
      kind: issue.pull_request ? "pull" : "issue",
      number: issue.number,
      title: issue.title,
      url: issue.html_url,
      requestText: payload.comment.body,
      requestUrl: payload.comment.html_url,
      reactTo: payload.comment.node_id,
      dedupeWindow: false,
    });
  }

  if (event === "pull_request_review_comment" && action === "created" && payload.comment && payload.pull_request) {
    const comment = payload.comment;
    const where = `On \`${comment.path}${comment.line ? `:${comment.line}` : ""}\`:\n\`\`\`diff\n${String(comment.diff_hunk ?? "").slice(-1500)}\n\`\`\`\n\n`;
    add(agentsMentionedIn(comment.body), {
      trigger: "mention",
      kind: "pull",
      number: payload.pull_request.number,
      title: payload.pull_request.title,
      url: payload.pull_request.html_url,
      requestText: where + comment.body,
      requestUrl: comment.html_url,
      reactTo: comment.node_id,
      dedupeWindow: false,
    });
  }

  if (event === "pull_request_review" && action === "submitted" && payload.review?.body && payload.pull_request) {
    add(agentsMentionedIn(payload.review.body), {
      trigger: "mention",
      kind: "pull",
      number: payload.pull_request.number,
      title: payload.pull_request.title,
      url: payload.pull_request.html_url,
      requestText: payload.review.body,
      requestUrl: payload.review.html_url,
      reactTo: payload.review.node_id,
      dedupeWindow: false,
    });
  }

  if (event === "discussion" && action === "created" && payload.discussion) {
    const discussion = payload.discussion;
    add(agentsMentionedIn(discussion.title, discussion.body), {
      trigger: "mention",
      kind: "discussion",
      number: discussion.number,
      title: discussion.title,
      url: discussion.html_url,
      requestText: [discussion.title, discussion.body ?? ""].join("\n\n").trim(),
      requestUrl: discussion.html_url,
      reactTo: discussion.node_id,
      dedupeWindow: false,
    });
  }

  if (event === "discussion_comment" && action === "created" && payload.comment && payload.discussion) {
    add(agentsMentionedIn(payload.comment.body), {
      trigger: "mention",
      kind: "discussion",
      number: payload.discussion.number,
      title: payload.discussion.title,
      url: payload.discussion.html_url,
      requestText: payload.comment.body,
      requestUrl: payload.comment.html_url,
      reactTo: payload.comment.node_id,
      dedupeWindow: false,
    });
  }

  return intents;
}

export { repoAllowed };

function record(deliveryId: string, event: string, payload: Payload, decision: Delivery["decision"], detail: string): void {
  const delivery = recordDelivery({
    deliveryId,
    event,
    action: String(payload.action ?? ""),
    repo: String(payload.repository?.full_name ?? ""),
    sender: String(payload.sender?.login ?? ""),
    decision,
    detail,
  });
  bus.publish({ type: "delivery", delivery });
}

/** Entry point for verified webhooks. */
/** Agents named by their GitHub accounts (unless they turned that off with github.account_mentions). */
async function accountAliases(): Promise<Map<string, Profile[]>> {
  const agents = loadProfiles().agents;
  const aliases = new Map<string, Profile[]>();
  for (const [login, names] of await accountLogins()) {
    const named = names.map((name) => agents.find((agent) => agent.name === name)).filter((agent): agent is Profile => Boolean(agent?.github.accountMentions));
    if (named.length) aliases.set(login, named);
  }
  return aliases;
}

/**
 * Is this webhook (sent by an agent's account) something the orchestrator itself did? Its comments,
 * reviews, issues and pull requests carry its mark; other changes it made to an issue or pull
 * request (labels, edits, assignments, closing, pushes) are in the recent-writes record.
 */
function ownAction(event: string, payload: Payload): boolean {
  const action = String(payload.action ?? "");
  const opened = action === "opened" || action === "created";
  const texts = [payload.comment?.body, payload.review?.body, opened ? (payload.issue?.body ?? payload.pull_request?.body ?? payload.discussion?.body) : null];
  if (texts.some(writtenByOrchestrator)) return true;
  // A comment or review without the mark was written by a person using the account.
  if (["issue_comment", "pull_request_review_comment", "pull_request_review", "discussion_comment"].includes(event)) return false;
  const repo = String(payload.repository?.full_name ?? "");
  const number = payload.issue?.number ?? payload.pull_request?.number ?? payload.discussion?.number;
  if (number && isRecentOwnWrite(`${repo}#${number}`)) return true;
  const head = payload.pull_request?.head?.ref;
  return Boolean(head && isRecentOwnWrite(`${repo}@${head}`));
}

/** Deliveries being handled right now, so one sent twice at once runs once. */
const inFlight = new Set<string>();

export async function handleWebhook(event: string, deliveryId: string, payload: Payload): Promise<void> {
  // GitHub redelivers with the same id (the Redeliver button, or a retry after a timeout). One that
  // already started or reached an agent isn't acted on again; one that failed or was ignored is.
  if (inFlight.has(deliveryId) || deliveryActedOn(deliveryId)) {
    return record(deliveryId, event, payload, "ignored", "Already handled: GitHub sent this delivery again");
  }
  inFlight.add(deliveryId);
  try {
    await handleDelivery(event, deliveryId, payload);
  } finally {
    inFlight.delete(deliveryId);
  }
}

async function handleDelivery(event: string, deliveryId: string, payload: Payload): Promise<void> {
  try {
    if (event === "projects_v2_item") {
      // Board moves, including the orchestrator's own (they start the next column's agent).
      const detail = await handleProjectItemWebhook(payload);
      return record(deliveryId, event, payload, /started|card in/.test(detail) ? "triggered" : "ignored", detail);
    }
    if (event === "ping") return record(deliveryId, event, payload, "ignored", "Ping from GitHub — the webhook works");
    if (event === "installation" || event === "installation_repositories") {
      return record(deliveryId, event, payload, "ignored", `Installation ${payload.action ?? "changed"}`);
    }
    // What became of agents' pull requests (merged, closed), whoever closed them.
    if (event === "pull_request") notePullEvent(payload);
    // An issue closing, a merge or a review may be what a paused task waits for.
    noteWaitEvent(event, payload);
    notePriorityLabel(event, payload);
    const repoFull = String(payload.repository?.full_name ?? "");
    const installationId = Number(payload.installation?.id ?? 0);
    if (!repoFull || !installationId) return record(deliveryId, event, payload, "ignored", "No repository or installation in payload");
    if (payload.sender?.type === "Bot") return record(deliveryId, event, payload, "ignored", "Sent by a bot");
    // What the orchestrator did as an agent's GitHub account is the agent's own work, like the
    // App's. What a person does with that account (it may be theirs) counts like anyone's.
    const senderLogin = String(payload.sender?.login ?? "");
    const ownAgent = await agentOfAccount(senderLogin);
    if (ownAgent && ownAction(event, payload)) return record(deliveryId, event, payload, "ignored", `Made by agent ${ownAgent} as @${senderLogin}`);
    if (!loadProfiles().agents.length) return record(deliveryId, event, payload, "ignored", "No agents configured");

    const aliases = await accountAliases();
    const intents = intentsFor(event, payload, aliases);
    // A new issue that names no agent goes to the triage agent, which passes it to the agent that fits.
    const triage = intents.length ? null : triageIntent(event, payload, aliases);
    if (triage) intents.push(triage);
    // Agents already working on this thread hear about what people do there.
    const activity = activityFor(event, payload);
    const working = activity ? runningTasksForThread(activity.ref) : [];
    if (!intents.length && !working.length) return record(deliveryId, event, payload, "ignored", "No agent mentioned or assigned, and none working here");
    if (!repoAllowed(repoFull)) return record(deliveryId, event, payload, "rejected", `${repoFull} is not in ALLOWED_REPOS`);

    const [owner, repo] = repoFull.split("/") as [string, string];
    const sender = String(payload.sender?.login ?? "");
    // A blocked account (Settings → Blocked users) can't start agents or reach working ones. Each
    // agent it called says so once per thread, without mentioning it, so bots can't keep chatting.
    if (isBlockedUser(sender)) {
      const outcomes: string[] = [];
      for (const [, group] of Map.groupBy(intents, (intent) => `${intent.kind}#${intent.number}`)) {
        const thread = { owner, repo, kind: group[0]!.kind, number: group[0]!.number, threadNodeId: payload.discussion?.node_id };
        outcomes.push(...(await answerBlocked(sender, group.map((intent) => intent.agent), thread, installationId)));
      }
      if (working.length) outcomes.push(`not passed to ${working.map((task) => `${task.agent} (task #${task.id})`).join(", ")}`);
      return record(deliveryId, event, payload, "rejected", [`${sender} is blocked`, ...outcomes].join("; "));
    }
    const gh = await installationClient(installationId);
    const permission = await userPermission(gh, owner, repo, sender);
    const trusted = permissionAtLeast(permission, config.triggerMinPermission);

    const outcomes: string[] = [];
    const told = new Set<string>();
    for (const task of working) {
      // Mentioning an agent that's already on this thread: tell it now instead of queueing another run.
      const onThread = task.threadKind === activity!.ref.kind && task.threadNumber === activity!.ref.number;
      const mention = trusted && onThread && intents.some((intent) => intent.agent.name === task.agent);
      deliver(task, activity!, { trusted, mention });
      if (mention) told.add(task.agent);
      outcomes.push(`Passed to ${task.agent} (task #${task.id})`);
    }
    if (intents.length && !trusted) {
      // Nobody was turned away when no agent was asked for: the issue just isn't triaged.
      outcomes.push(triage ? `No agent named, and @${sender} has ${permission} access; ${config.triggerMinPermission} is required for ${triage.agent.name} to triage it` : `@${sender} has ${permission} access; ${config.triggerMinPermission} is required to start agents`);
      return record(deliveryId, event, payload, working.length ? "forwarded" : triage ? "ignored" : "rejected", outcomes.join("; "));
    }
    for (const intent of intents) {
      if (told.has(intent.agent.name)) {
        const as = await clientFor({ agent: intent.agent.name, installationId }).catch(() => null);
        if (intent.reactTo && as) await addEyesReaction(as, intent.reactTo).catch(() => undefined);
        continue;
      }
      // Labels such as "urgent" on the issue or pull request move its tasks up (or down) the queue.
      const priority = priorityFromLabels((payload.issue ?? payload.pull_request ?? payload.discussion)?.labels);
      outcomes.push(await accept(gh, intent, { owner, repo, installationId, sender, priority }));
    }
    const started = outcomes.filter((outcome) => outcome.startsWith("Queued"));
    const passedOn = working.length > 0 || outcomes.some((outcome) => outcome.startsWith("Woke"));
    record(deliveryId, event, payload, started.length ? "triggered" : passedOn ? "forwarded" : "ignored", outcomes.join("; "));
    scheduler.kick();
  } catch (error) {
    log.error("Webhook handling failed", { event, deliveryId, error: errorMessage(error) });
    record(deliveryId, event, payload, "error", errorMessage(error));
  }
}

/**
 * A new issue that names no agent: the triage agent's to route (Settings → Routing), when one is
 * set for the repository. Not one a blocked user opened, nor one assigned to an agent as it was
 * opened (the assignment starts that agent).
 */
function triageIntent(event: string, payload: Payload, aliases: Aliases): Intent | null {
  if (event !== "issues" || payload.action !== "opened" || !payload.issue) return null;
  const issue = payload.issue;
  const agent = triageAgentFor(String(payload.repository?.full_name ?? ""));
  if (!agent || isBlockedUser(String(payload.sender?.login ?? ""))) return null;
  const assignees = (issue.assignees ?? []) as { login?: string }[];
  if (assignees.some(({ login }) => login && (profileByHandle(login) || aliases.has(login.toLowerCase())))) return null;
  return {
    agent,
    trigger: "triage",
    kind: "issue",
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    requestText: [issue.title, issue.body ?? ""].join("\n\n").trim(),
    requestUrl: issue.html_url,
    reactTo: issue.node_id,
    dedupeWindow: true,
  };
}

/**
 * Someone put a priority label (HIGH_PRIORITY_LABELS, LOW_PRIORITY_LABELS) on an issue or pull
 * request, or took one off: what's queued for it moves up or down the queue with it.
 */
function notePriorityLabel(event: string, payload: Payload): void {
  if ((event !== "issues" && event !== "pull_request") || (payload.action !== "labeled" && payload.action !== "unlabeled")) return;
  const label = String(payload.label?.name ?? "");
  if (!config.highPriorityLabels.includes(label.toLowerCase()) && !config.lowPriorityLabels.includes(label.toLowerCase())) return;
  const thread = payload.issue ?? payload.pull_request;
  const [owner, repo] = String(payload.repository?.full_name ?? "").split("/");
  if (!thread || !owner || !repo) return;
  const priority = priorityFromLabels(thread.labels);
  const kind: ThreadKind = event === "pull_request" ? "pull" : "issue";
  const changed = queuedTasksOnThread({ owner, repo, kind, number: Number(thread.number) }).filter((task) => task.priority !== priority);
  for (const task of changed) {
    const verb = payload.action === "labeled" ? "added" : "removed";
    bus.publish({ type: "event", event: addEvent(task.id, "system", `Priority is now ${priority}: @${payload.sender?.login ?? "someone"} ${verb} the label ${label}`) });
    bus.publish({ type: "task", task: updateTask(task.id, { priority }) });
  }
  if (changed.length) scheduler.kick();
}

async function accept(
  gh: GitHubClient,
  intent: Intent,
  context: { owner: string; repo: string; installationId: number; sender: string; priority?: TaskPriority },
): Promise<string> {
  const { agent } = intent;
  const ref = { owner: context.owner, repo: context.repo, kind: intent.kind, number: intent.number };
  if (!agent.enabled) return `${agent.name} is turned off`;
  if (intent.dedupeWindow && recentTaskForThread(ref, agent.name, 120)) return `${agent.name} already started for this ${intent.kind}`;
  const queued = queuedTaskForThread(ref, agent.name);
  if (queued?.waitReason === "wake") {
    // The agent paused its task here until other work is done: this wakes it, and it reads the request when it resumes.
    const summary = intent.trigger === "assignment" ? "assigned this to you" : "wrote to you";
    deliver(queued, { ref, author: context.sender, summary, body: intent.requestText, url: intent.requestUrl }, { trusted: true, mention: true });
    wakeTask(queued.id, `@${context.sender} ${summary} on the thread`);
    const as = await clientFor({ agent: agent.name, installationId: context.installationId }).catch(() => null);
    if (intent.reactTo && as) await addEyesReaction(as, intent.reactTo).catch(() => undefined);
    return `Woke ${agent.name} (task #${queued.id}), which had paused`;
  }
  if (queued) {
    // The agent is busy here and already has a follow-up waiting: fold this request into it.
    const merged = updateTask(queued.id, {
      requestText: `${queued.requestText}\n\n---\n\n@${context.sender} also asked (${intent.requestUrl}):\n\n${intent.requestText}`,
      ...(context.priority === "high" ? { priority: "high" as const } : {}),
    });
    bus.publish({ type: "task", task: merged });
    const as = await clientFor({ agent: agent.name, installationId: context.installationId }).catch(() => null);
    if (intent.reactTo && as) await addEyesReaction(as, intent.reactTo).catch(() => undefined);
    return `Queued: added to task #${queued.id} for ${agent.name}`;
  }

  const task = createTask({
    agent: agent.name,
    installationId: context.installationId,
    owner: context.owner,
    repo: context.repo,
    threadKind: intent.kind,
    threadNumber: intent.number,
    threadTitle: intent.title,
    threadUrl: intent.url,
    triggerKind: intent.trigger,
    requestedBy: context.sender,
    requestText: intent.requestText,
    requestUrl: intent.requestUrl,
    priority: context.priority,
  });
  bus.publish({ type: "task", task });

  const label = config.labelPrefix && config.labelPrefix !== "none" ? `${config.labelPrefix}${agent.name}` : null;
  // The agent acknowledges as itself: its GitHub account if it has one, otherwise the App.
  // (If its account's token is unusable, the task says so when it runs; nothing is done as the App.)
  const as = await clientFor({ agent: agent.name, installationId: context.installationId }).catch(() => null);
  await Promise.all([
    intent.reactTo && as ? addEyesReaction(as, intent.reactTo).catch(() => undefined) : undefined,
    as && intent.kind !== "discussion" && intent.trigger === "mention"
      ? markAgentOnThread(as, context.owner, context.repo, intent.number, (await agentAccount(agent).catch(() => null))?.login || agent.handle, label)
      : undefined,
  ]);
  return intent.trigger === "triage" ? `Queued task #${task.id} for ${agent.name} to route: no agent was named` : `Queued task #${task.id} for ${agent.name}`;
}

/** Starts an agent from the admin UI as if it had been mentioned. */
export async function startManualTask(input: {
  agentName: string;
  owner: string;
  repo: string;
  kind: ThreadKind;
  number: number;
  instruction: string;
  requestedBy: string;
  installationId: number;
  /** Base branch for this run's pull request; null: the usual one (see runtime/base-branch.ts). */
  baseBranch?: string | null;
  priority?: TaskPriority;
}): Promise<number> {
  const agent = loadProfiles().agents.find((candidate) => candidate.name === input.agentName);
  if (!agent) throw new Error(`Unknown agent ${input.agentName}`);
  const task = createTask({
    agent: agent.name,
    installationId: input.installationId,
    owner: input.owner,
    repo: input.repo,
    threadKind: input.kind,
    threadNumber: input.number,
    threadTitle: "",
    threadUrl: "",
    triggerKind: "manual",
    requestedBy: input.requestedBy,
    requestText: input.instruction,
    requestUrl: "",
    requestedBase: input.baseBranch ?? null,
    priority: input.priority,
  });
  bus.publish({ type: "task", task });
  scheduler.kick();
  return task.id;
}
