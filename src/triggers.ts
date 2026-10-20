import { bus } from "./bus.ts";
import { config } from "./config.ts";
import { createTask, getAgentByHandle, listAgents, queuedTaskForThread, recentTaskForThread, recordDelivery, updateTask } from "./db.ts";
import { installationClient, type GitHubClient } from "./github/app.ts";
import { addEyesReaction, markAgentOnThread, permissionAtLeast, userPermission } from "./github/threads.ts";
import { errorMessage, log } from "./log.ts";
import { extractMentions } from "./mentions.ts";
import { scheduler } from "./runner/scheduler.ts";
import type { Agent, Delivery, ThreadKind, TriggerKind } from "./types.ts";

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

function agentsMentionedIn(...texts: (string | null | undefined)[]): Agent[] {
  const handles = new Set(texts.flatMap((text) => extractMentions(text)));
  return [...handles].map((handle) => getAgentByHandle(handle)).filter((agent): agent is Agent => agent !== null);
}

function agentForLogin(login: string | undefined): Agent[] {
  const agent = login ? getAgentByHandle(login) : null;
  return agent ? [agent] : [];
}

/** Maps a webhook to the agents it should start. Pure apart from agent lookups. */
export function intentsFor(event: string, payload: Payload): Intent[] {
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

export function repoAllowed(fullName: string): boolean {
  if (!config.allowedRepos.length) return true;
  const [owner] = fullName.toLowerCase().split("/");
  return config.allowedRepos.some((pattern) => pattern === fullName.toLowerCase() || pattern === `${owner}/*`);
}

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
export async function handleWebhook(event: string, deliveryId: string, payload: Payload): Promise<void> {
  try {
    if (event === "ping") return record(deliveryId, event, payload, "ignored", "Ping from GitHub — the webhook works");
    if (event === "installation" || event === "installation_repositories") {
      return record(deliveryId, event, payload, "ignored", `Installation ${payload.action ?? "changed"}`);
    }
    const repoFull = String(payload.repository?.full_name ?? "");
    const installationId = Number(payload.installation?.id ?? 0);
    if (!repoFull || !installationId) return record(deliveryId, event, payload, "ignored", "No repository or installation in payload");
    if (payload.sender?.type === "Bot") return record(deliveryId, event, payload, "ignored", "Sent by a bot");
    if (!listAgents().length) return record(deliveryId, event, payload, "ignored", "No agents configured");

    const intents = intentsFor(event, payload);
    if (!intents.length) return record(deliveryId, event, payload, "ignored", "No agent mentioned or assigned");
    if (!repoAllowed(repoFull)) return record(deliveryId, event, payload, "rejected", `${repoFull} is not in ALLOWED_REPOS`);

    const [owner, repo] = repoFull.split("/") as [string, string];
    const sender = String(payload.sender?.login ?? "");
    const gh = await installationClient(installationId);
    const permission = await userPermission(gh, owner, repo, sender);
    if (!permissionAtLeast(permission, config.triggerMinPermission)) {
      return record(deliveryId, event, payload, "rejected", `@${sender} has ${permission} access; ${config.triggerMinPermission} is required`);
    }

    const outcomes: string[] = [];
    for (const intent of intents) outcomes.push(await accept(gh, intent, { owner, repo, installationId, sender }));
    const started = outcomes.filter((outcome) => outcome.startsWith("Queued"));
    record(deliveryId, event, payload, started.length ? "triggered" : "ignored", outcomes.join("; "));
    scheduler.kick();
  } catch (error) {
    log.error("Webhook handling failed", { event, deliveryId, error: errorMessage(error) });
    record(deliveryId, event, payload, "error", errorMessage(error));
  }
}

async function accept(
  gh: GitHubClient,
  intent: Intent,
  context: { owner: string; repo: string; installationId: number; sender: string },
): Promise<string> {
  const { agent } = intent;
  const ref = { owner: context.owner, repo: context.repo, kind: intent.kind, number: intent.number };
  if (!agent.enabled) return `${agent.name} is turned off`;
  if (intent.dedupeWindow && recentTaskForThread(ref, agent.name, 120)) return `${agent.name} already started for this ${intent.kind}`;
  const queued = queuedTaskForThread(ref, agent.name);
  if (queued) {
    // The agent is busy here and already has a follow-up waiting: fold this request into it.
    const merged = updateTask(queued.id, {
      requestText: `${queued.requestText}\n\n---\n\n@${context.sender} also asked (${intent.requestUrl}):\n\n${intent.requestText}`,
    });
    bus.publish({ type: "task", task: merged });
    if (intent.reactTo) await addEyesReaction(gh, intent.reactTo).catch(() => undefined);
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
  });
  bus.publish({ type: "task", task });

  const label = config.labelPrefix && config.labelPrefix !== "none" ? `${config.labelPrefix}${agent.name}` : null;
  await Promise.all([
    intent.reactTo ? addEyesReaction(gh, intent.reactTo).catch(() => undefined) : undefined,
    intent.kind !== "discussion" && intent.trigger === "mention"
      ? markAgentOnThread(gh, context.owner, context.repo, intent.number, agent.handle, label)
      : undefined,
  ]);
  return `Queued task #${task.id} for ${agent.name}`;
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
}): Promise<number> {
  const agent = listAgents().find((candidate) => candidate.name === input.agentName);
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
  });
  bus.publish({ type: "task", task });
  scheduler.kick();
  return task.id;
}
