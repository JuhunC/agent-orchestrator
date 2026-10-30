import { execFileSync, spawn } from "node:child_process";
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.ts";
import { errorMessage, log } from "../log.ts";
import { recordIncident } from "../runner/incidents.ts";

/**
 * Runs agents as a separate OS user (AGENT_USER) that can't read the orchestrator's own data: the
 * GitHub App key, admin token, database, data-key and agents' GitHub tokens. Agents run with
 * permission prompts off, and what they read on GitHub may be a prompt injection, so their shell
 * must not reach those. They share only these folders with the orchestrator, through the agent
 * user's group: workspaces and the agent's home (read and write), and session state such as
 * skills (read only). Everything else in DATA_DIR is private to the orchestrator.
 */

export interface IsolationStatus {
  /** off: agents run as the orchestrator's user. sudo: as AGENT_USER through sudo. direct: the orchestrator is root and switches user itself. */
  mode: "off" | "sudo" | "direct";
  user: string | null;
  required: boolean;
  /** What's wrong: agents aren't isolated, or the check failed. Null when isolated (or turned off on purpose). */
  problem: string | null;
}

/** Folders agents share with the orchestrator, and whether agents may write in them. */
export function sharedRoots(): { path: string; writable: boolean }[] {
  return [
    { path: join(config.dataDir, "workspaces"), writable: true },
    { path: config.agentHome, writable: true },
    { path: join(config.dataDir, "sessions"), writable: false },
    // Shared history the agent's git reads through its checkout's alternates.
    { path: join(config.dataDir, "mirrors"), writable: false },
  ];
}

let status: IsolationStatus | null = null;
let ids: { uid: number; gid: number } | null = null;
let setup: Promise<IsolationStatus> | null = null;

export function isolationStatus(): IsolationStatus {
  return status ?? { mode: "off", user: config.agentUser || null, required: config.agentIsolation === "required", problem: config.agentIsolation === "off" ? null : "Not checked yet." };
}

/** Are agents running as the separate user? */
export function isolated(): boolean {
  return status !== null && status.mode !== "off";
}

const run = (command: string, args: string[]) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 }).trim();

/** Runs a command as the agent user, for checks and setup. */
function runAsAgent(args: string[]): string {
  if (!status || status.mode === "off" || !ids) throw new Error("Agents aren't isolated");
  if (status.mode === "direct") return execFileSync(args[0]!, args.slice(1), { encoding: "utf8", uid: ids.uid, gid: ids.gid, timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  return run("sudo", ["-n", "-u", config.agentUser, "--", ...args]);
}

/** Gives the agent group a folder tree: group-owned, setgid folders, group read (and write). */
function shareTree(path: string, writable: boolean): void {
  if (!ids || !existsSync(path)) return;
  const walk = (target: string) => {
    const info = lstatSync(target);
    if (info.isSymbolicLink()) return;
    try {
      if (info.gid !== ids!.gid) chownSync(target, -1, ids!.gid);
      const keep = info.mode & 0o700;
      if (info.isDirectory()) chmodSync(target, keep | 0o2000 | (writable ? 0o070 : 0o050));
      else chmodSync(target, keep | ((info.mode & 0o100 ? 0o010 : 0) | (writable ? 0o060 : 0o040)));
    } catch {
      // Owned by the agent user (it made it): already shared.
    }
    if (info.isDirectory()) for (const entry of readdirSync(target)) walk(join(target, entry));
  };
  walk(path);
}

/** Creates a folder under a shared root (and its parents up to the root), shared with the agent group. */
export function makeSharedDir(path: string): void {
  mkdirSync(path, { recursive: true });
  if (!isolated() || !ids) return;
  const root = sharedRoots().find((candidate) => resolve(path) === candidate.path || resolve(path).startsWith(candidate.path + sep));
  if (!root) return;
  let current = resolve(path);
  while (current !== root.path && current.startsWith(root.path)) {
    try {
      chownSync(current, -1, ids.gid);
      chmodSync(current, root.writable ? 0o2770 : 0o2750);
    } catch {
      // The agent made it.
    }
    current = dirname(current);
  }
}

/** Shares a file or folder the orchestrator wrote under a shared root (e.g. a session's skills). */
export function shareWritten(path: string): void {
  if (!isolated()) return;
  const root = sharedRoots().find((candidate) => resolve(path).startsWith(candidate.path + sep));
  if (root) shareTree(path, root.writable);
}

/** Is this path in a folder shared with the agent user (workspaces, mirrors)? The orchestrator's git there keeps files group-readable and writable. */
export function inWorkspaces(path: string): boolean {
  if (!config.agentUser || config.agentIsolation === "off") return false;
  const target = resolve(path);
  return [join(config.dataDir, "workspaces"), join(config.dataDir, "mirrors")].some((root) => target === root || target.startsWith(root + sep));
}

/** Makes DATA_DIR private to the orchestrator, apart from the shared folders. */
function lockDown(): void {
  const data = resolve(config.dataDir);
  chmodSync(data, 0o711); // the agent may pass through to its folders, not list or read the rest
  const shared = new Set(sharedRoots().map((root) => root.path));
  for (const entry of readdirSync(data)) {
    const path = join(data, entry);
    if (shared.has(path)) continue;
    const info = lstatSync(path);
    if (info.isSymbolicLink()) continue;
    chmodSync(path, info.isDirectory() ? 0o700 : 0o600);
  }
}

/** Checks and prepares isolation once: finds the user, locks DATA_DIR down, shares folders, and tests it. */
export function setupIsolation(): Promise<IsolationStatus> {
  setup ??= Promise.resolve().then(() => {
    status = check();
    if (status.problem && config.agentIsolation !== "off") {
      log.warn("Agents aren't isolated from the orchestrator's data", { problem: status.problem });
      recordIncident("isolation", status.required ? "critical" : "warning", `${status.required ? "Agents won't run" : "Agents can read the orchestrator's secrets"}: ${status.problem}`);
    }
    else if (status.mode !== "off") log.info("Agents run as a separate user", { user: status.user, mode: status.mode });
    return status;
  });
  return setup;
}

function check(): IsolationStatus {
  const required = config.agentIsolation === "required";
  const off = (problem: string | null): IsolationStatus => ({ mode: "off", user: config.agentUser || null, required, problem });
  if (config.agentIsolation === "off") return off(null);
  if (!config.agentUser) return off("AGENT_USER isn't set, so agents run as the orchestrator's own user and can read its data: the GitHub App key, admin token, database and agents' GitHub tokens. The Docker image sets it up; see the README.");
  if (process.platform === "win32") return off("Running agents as another user isn't supported on Windows.");
  try {
    ids = { uid: Number(run("id", ["-u", config.agentUser])), gid: Number(run("id", ["-g", config.agentUser])) };
  } catch {
    return off(`There's no user called ${config.agentUser} (AGENT_USER).`);
  }
  if (ids.uid === process.getuid?.()) return off(`AGENT_USER (${config.agentUser}) is the user the orchestrator runs as; use a separate user.`);
  const mode: IsolationStatus["mode"] = process.getuid?.() === 0 ? "direct" : "sudo";
  status = { mode, user: config.agentUser, required, problem: null };
  if (mode === "sudo") {
    try {
      runAsAgent(["true"]);
    } catch (error) {
      const me = run("id", ["-un"]);
      status = null;
      return off(`The orchestrator can't run commands as ${config.agentUser}: ${errorMessage(error).split("\n").at(-1)}. Allow it with a sudoers rule like "${me} ALL=(${config.agentUser}) NOPASSWD:SETENV: ALL".`);
    }
    if (!process.getgroups?.().includes(ids.gid)) {
      status = null;
      return off(`The orchestrator's user must be in ${config.agentUser}'s group (gid ${ids.gid}) to share workspaces with it.`);
    }
  }
  try {
    for (const root of sharedRoots()) mkdirSync(root.path, { recursive: true });
    lockDown();
    for (const root of sharedRoots()) {
      // Once per folder (an upgrade, or a new DATA_DIR); what's made later is shared as it's made.
      const marker = join(root.path, ".shared-with-agents");
      if (!existsSync(marker) || lstatSync(marker).gid !== ids.gid) {
        shareTree(root.path, root.writable);
        writeFileSync(marker, `${config.agentUser}\n`);
        shareTree(marker, false);
      }
      chownSync(root.path, -1, ids.gid);
      chmodSync(root.path, root.writable ? 0o2770 : 0o2750);
    }
    // The agent's git works in checkouts the orchestrator made, so it must trust them.
    const gitconfig = join(config.agentHome, ".gitconfig");
    if (!existsSync(gitconfig)) writeFileSync(gitconfig, "[safe]\n\tdirectory = *\n");
    shareTree(gitconfig, true);
  } catch (error) {
    status = null;
    return off(`Couldn't prepare DATA_DIR for the agent user: ${errorMessage(error)}`);
  }
  // Test it as the agent: it can work in its folders but not read the orchestrator's files.
  const secret = join(config.dataDir, "orchestrator.db");
  try {
    runAsAgent(["test", "-w", join(config.dataDir, "workspaces")]);
    runAsAgent(["test", "-w", config.agentHome]);
  } catch {
    status = null;
    return off(`${config.agentUser} can't write to ${join(config.dataDir, "workspaces")} or ${config.agentHome}. Check that every folder above DATA_DIR lets it through (x permission).`);
  }
  let readable = false;
  try {
    runAsAgent(["test", "-r", secret]);
    readable = true;
  } catch {
    // Good: it can't.
  }
  if (readable) {
    status = null;
    return off(`${config.agentUser} can still read ${secret}.`);
  }
  return { mode, user: config.agentUser, required, problem: null };
}

const WRAP = 'umask 002; exec "$0" "$@"';

/**
 * Starts Claude Code as the agent user (the SDK's spawnClaudeCodeProcess). Files it creates stay
 * group-writable so the orchestrator can commit them; its stderr goes to `onStderr`.
 */
export function spawnAsAgent(options: SpawnOptions, onStderr: (data: string) => void): SpawnedProcess {
  if (!status || status.mode === "off" || !ids) throw new Error("Agents aren't isolated");
  const inner = ["/bin/sh", "-c", WRAP, options.command, ...options.args];
  const child =
    status.mode === "direct"
      ? spawn(inner[0]!, inner.slice(1), { cwd: options.cwd, env: options.env, uid: ids.uid, gid: ids.gid, stdio: ["pipe", "pipe", "pipe"], signal: options.signal })
      : spawn("sudo", ["-n", "-u", config.agentUser, "--preserve-env", "--", ...inner], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], signal: options.signal });
  child.stderr?.on("data", (data: Buffer) => onStderr(data.toString()));
  child.on("error", (error) => onStderr(`Couldn't start the agent as ${config.agentUser}: ${errorMessage(error)}`));
  return child as unknown as SpawnedProcess;
}
