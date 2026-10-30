import { execFile } from "node:child_process";
import { inWorkspaces } from "../runtime/isolation.ts";

export class GitError extends Error {
  stderr: string;
  constructor(message: string, stderr: string) {
    super(message);
    this.stderr = stderr;
  }
}

/**
 * Runs git. The token, when given, is passed as an HTTP auth header through GIT_CONFIG_*
 * environment variables, so it never lands in .git/config or the process list.
 */
export function git(cwd: string, args: string[], options: { token?: string; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo", LC_ALL: "C", ...options.env };
  if (options.token) {
    const basic = Buffer.from(`x-access-token:${options.token}`).toString("base64");
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.extraHeader";
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
  }
  return new Promise((resolve, reject) => {
    // In workspaces shared with the agent user, keep what git writes group-writable.
    const [command, argv] = inWorkspaces(cwd) ? ["/bin/sh", ["-c", 'umask 002; exec git "$@"', "git", ...args]] : ["git", args];
    execFile(command, argv, { cwd, env, timeout: options.timeoutMs ?? 10 * 60_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const scrubbed = String(stderr || error.message).replace(/x-access-token:[^@\s]+/g, "x-access-token:***");
        reject(new GitError(`git ${args[0]} failed: ${scrubbed.trim().split("\n").slice(-3).join(" ")}`, scrubbed));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

export async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}
