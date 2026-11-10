import { addBlockedUsers, claimBlockedReply, listBlockedUsers, releaseBlockedReply, removeBlockedUser, replaceBlockedUsers, type BlockedUser } from "./db.ts";
import { clientFor } from "./github/accounts.ts";
import { postComment } from "./github/threads.ts";
import { errorMessage, log } from "./log.ts";
import type { Profile } from "./profiles/types.ts";
import type { ThreadKind } from "./types.ts";

/**
 * Settings → Blocked users: GitHub accounts agents don't take requests from, such as another
 * team's bots, so agents don't keep talking to each other. When one calls an agent, the agent says
 * it's blocked (once per thread, without @-mentioning it) and doesn't start; what it does on a
 * thread doesn't reach agents already working there either.
 */

export class BlockedUserError extends Error {}

const LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

/** A GitHub login from what someone typed ("@Other-Bot" → "Other-Bot"). */
export function parseLogin(input: unknown): string {
  const login = String(input ?? "")
    .trim()
    .replace(/^@/, "");
  if (!LOGIN.test(login)) throw new BlockedUserError(`"${String(input ?? "")}" isn't a GitHub login`);
  return login;
}

export function blockUser(input: unknown, by: string): BlockedUser[] {
  addBlockedUsers([parseLogin(input)], by);
  return listBlockedUsers();
}

export function unblockUser(input: unknown): boolean {
  return removeBlockedUser(parseLogin(input));
}

/** Makes the list exactly these logins (all checked before anything changes). */
export function setBlockedUsers(input: unknown, by: string): BlockedUser[] {
  if (!Array.isArray(input)) throw new BlockedUserError("Send users as a list of GitHub logins");
  const logins = [...new Map(input.map(parseLogin).map((login) => [login.toLowerCase(), login])).values()];
  replaceBlockedUsers(logins, by);
  return listBlockedUsers();
}

/** The reply: names the account in code so GitHub doesn't notify it (it may be another agent). */
export function blockedMessage(agent: string, login: string): string {
  return `🚫 **${agent}** won't respond: \`${login}\` is blocked from calling agents here, so its requests are ignored.`;
}

/**
 * Each agent a blocked account called says so on the thread, once per thread. Returns what
 * happened, for Deliveries.
 */
export async function answerBlocked(
  login: string,
  agents: Profile[],
  thread: { owner: string; repo: string; kind: ThreadKind; number: number; threadNodeId?: string },
  installationId: number,
): Promise<string[]> {
  const outcomes: string[] = [];
  const key = `${thread.owner}/${thread.repo}/${thread.kind}/${thread.number}`.toLowerCase();
  for (const agent of new Map(agents.map((candidate) => [candidate.name, candidate])).values()) {
    if (!agent.enabled) {
      outcomes.push(`${agent.name} is turned off`);
      continue;
    }
    if (!claimBlockedReply(login, agent.name, key)) {
      outcomes.push(`${agent.name} already said so here`);
      continue;
    }
    try {
      const gh = await clientFor({ agent: agent.name, installationId });
      await postComment(gh, thread, blockedMessage(agent.name, login));
      outcomes.push(`${agent.name} replied that it's blocked`);
    } catch (error) {
      releaseBlockedReply(login, agent.name, key);
      log.warn("Could not tell a blocked account it's blocked", { agent: agent.name, login, thread: key, error: errorMessage(error) });
      outcomes.push(`${agent.name} couldn't reply: ${errorMessage(error)}`);
    }
  }
  return outcomes;
}
