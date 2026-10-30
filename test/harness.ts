import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FakeGitHub } from "./fake-github.ts";
import { FakeModel } from "./fake-model.ts";

/**
 * Boots the orchestrator in-process against a fake GitHub API, a fake model API (the real Agent
 * SDK and Claude Code run against it) and a local bare repo (acme/widgets). `profiles` maps
 * paths under PROFILES_DIR to file contents. Must run before anything imports src/.
 */
export async function startHarness(profiles: Record<string, string>, env: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "ao-test-"));
  const remotes = join(root, "remotes");
  const fake = new FakeGitHub();
  await fake.start();
  const model = new FakeModel();
  await model.start();

  const seed = join(root, "seed");
  mkdirSync(seed, { recursive: true });
  const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  run(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "README.md"), "# widgets\n");
  run(seed, "add", ".");
  run(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  mkdirSync(join(remotes, "acme"), { recursive: true });
  run(root, "clone", "-q", "--bare", seed, join(remotes, "acme", "widgets.git"));
  const showRemote = (ref: string) => run(root, "--git-dir", join(remotes, "acme", "widgets.git"), "show", ref);
  fake.branchSha = (branch) => {
    try {
      return run(root, "--git-dir", join(remotes, "acme", "widgets.git"), "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
    } catch {
      return "";
    }
  };

  fake.mergeBranches = (base, head, message) => {
    const work = mkdtempSync(join(root, "merge-"));
    run(root, "clone", "-q", join(remotes, "acme", "widgets.git"), work);
    run(work, "checkout", "-q", base);
    try {
      run(work, "merge-base", "--is-ancestor", `origin/${head}`, "HEAD");
      return null;
    } catch {
      // not merged yet
    }
    run(work, "-c", "user.name=GitHub", "-c", "user.email=noreply@github.com", "merge", "--no-ff", "-q", "-m", message, `origin/${head}`);
    run(work, "push", "-q", "origin", base);
    return run(work, "rev-parse", "HEAD");
  };

  const profilesDir = join(root, "profiles");
  for (const [path, content] of Object.entries(profiles)) {
    mkdirSync(dirname(join(profilesDir, path)), { recursive: true });
    writeFileSync(join(profilesDir, path), content);
  }
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  Object.assign(process.env, {
    DATA_DIR: join(root, "data"),
    PROFILES_DIR: profilesDir,
    ANTHROPIC_BASE_URL: model.url,
    ANTHROPIC_API_KEY: "test-model-key",
    ANTHROPIC_MODEL: "claude-opus-5-5",
    GITHUB_URL: fake.url,
    // GitHub Actions sets GITHUB_API_URL for every job; point it at the fake too.
    GITHUB_API_URL: `${fake.url}/api/v3`,
    GITHUB_APP_ID: "1",
    GITHUB_APP_SLUG: "test-orchestrator",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_WEBHOOK_SECRET: "whsec",
    GIT_REMOTE_TEMPLATE: `file://${remotes}/{owner}/{repo}.git`,
    AUTH_DISABLED: "true",
    PROGRESS_UPDATE_SECONDS: "5",
    WEB_DIST_DIR: join(root, "no-ui"),
    ...env,
  });

  const { buildServer } = await import("../src/server/http.ts");
  const { scheduler } = await import("../src/runner/scheduler.ts");
  const { sessions } = await import("../src/runtime/manager.ts");
  const db = await import("../src/db.ts");
  const app = await buildServer();

  let deliveryCounter = 0;
  async function sendWebhook(event: string, payload: Record<string, unknown>, deliveryId?: string) {
    const body = JSON.stringify({ installation: { id: 77 }, repository: { full_name: "acme/widgets" }, ...payload });
    const delivery = deliveryId ?? `d-${++deliveryCounter}`;
    const seen = db.listDeliveries(500).filter((entry) => entry.deliveryId === delivery).length;
    const response = await app.inject({
      method: "POST",
      url: "/api/github/webhooks",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": delivery,
        "x-hub-signature-256": `sha256=${createHmac("sha256", "whsec").update(body).digest("hex")}`,
      },
      payload: body,
    });
    assert.equal(response.statusCode, 202);
    // Webhooks are handled after the 202; wait for the decision to be recorded.
    for (let i = 0; i < 200; i++) {
      const found = db.listDeliveries(500).filter((entry) => entry.deliveryId === delivery);
      if (found.length > seen) return found[0]!;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("webhook was not processed");
  }

  async function waitForTask(id: number, statuses = ["succeeded", "failed", "cancelled"], predicate?: (task: ReturnType<typeof db.getTask>) => boolean) {
    for (let i = 0; i < 1200; i++) {
      const task = db.getTask(id)!;
      if (statuses.includes(task.status) && (!predicate || predicate(task))) {
        // The result comment is posted just after the status changes.
        if (statuses.includes("running") || statuses.includes("queued")) return task;
        await scheduler.idle();
        return db.getTask(id)!;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`task ${id} did not reach ${statuses.join("/")}: ${db.getTask(id)?.status}`);
  }

  /** Opens issue #number mentioning `handle`, and returns the finished task. */
  async function mentionOnNewIssue(number: number, handle: string, body = "please take this") {
    fake.addIssue({ number, title: `Issue ${number}`, body: `@${handle} ${body}`, user: { login: "alice" } });
    const delivery = await sendWebhook("issues", {
      action: "opened",
      sender: { login: "alice", type: "User" },
      issue: { number, title: `Issue ${number}`, body: `@${handle} ${body}`, html_url: `${fake.url}/acme/widgets/issues/${number}`, node_id: `I_${number}` },
    });
    assert.equal(delivery.decision, "triggered", delivery.detail);
    return db.listTasks({ limit: 1 })[0]!;
  }

  async function commentMention(number: number, body: string) {
    const delivery = await sendWebhook("issue_comment", {
      action: "created",
      sender: { login: "alice", type: "User" },
      issue: { number, title: `Issue ${number}`, html_url: `${fake.url}/acme/widgets/issues/${number}` },
      comment: { body, html_url: `${fake.url}/c/${Math.random()}`, node_id: "IC" },
    });
    assert.equal(delivery.decision, "triggered", delivery.detail);
    return db.listTasks({ limit: 1 })[0]!;
  }

  async function stop() {
    await scheduler.shutdown();
    sessions.closeAll();
    await app.close();
    await fake.stop();
    await model.stop();
  }

  fake.permissions.set("alice", "write");
  return { root, remotes, profilesDir, fake, model, app, db, scheduler, sessions, run, showRemote, sendWebhook, waitForTask, mentionOnNewIssue, commentMention, stop };
}
