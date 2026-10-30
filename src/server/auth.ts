import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.ts";
import { createSession, deleteSession, getSession } from "../db.ts";
import { addressCheck, appAddresses, ensureAppDetails, getCredentials } from "../github/app.ts";
import { errorMessage, log } from "../log.ts";
import { audit, roleOf } from "./roles.ts";
import { adminToken } from "./secrets.ts";

const COOKIE = "ao_session";
const STATE_COOKIE = "ao_oauth_state";
const SESSION_HOURS = 24 * 7;
export const TOKEN_LOGIN = "admin (token)";
// GitHub calls these itself; they're protected by the webhook signature and the setup state.
const PUBLIC_PATHS = new Set(["/api/github/webhooks", "/api/setup/callback", "/api/health"]);

declare module "fastify" {
  interface FastifyRequest {
    adminLogin?: string;
  }
}

function secureCookies(): boolean {
  return config.publicUrl.startsWith("https://");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function currentLogin(request: FastifyRequest): string | null {
  if (config.authDisabled) return "dev";
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ") && safeEqual(header.slice(7), adminToken)) return TOKEN_LOGIN;
  const raw = request.cookies[COOKIE];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;
  return getSession(unsigned.value)?.login ?? null;
}

function startSession(reply: FastifyReply, login: string): void {
  const id = randomBytes(24).toString("base64url");
  createSession(id, login, SESSION_HOURS);
  reply.setCookie(COOKIE, id, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies(),
    signed: true,
    maxAge: SESSION_HOURS * 3600,
  });
}

const GITHUB_TIMEOUT_MS = 15_000;

/**
 * A JSON request to GitHub from the server, with a time limit and an error that says what failed
 * (without one, a server that can't reach GitHub leaves the browser waiting for minutes).
 */
async function githubJson<T>(url: string, init: RequestInit, what: string): Promise<T> {
  const host = new URL(url).host;
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS) });
  } catch (error) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    const reason = (error as Error).name === "TimeoutError" ? `no answer within ${GITHUB_TIMEOUT_MS / 1000} seconds` : (cause?.code ?? cause?.message ?? errorMessage(error));
    throw new Error(`The orchestrator couldn't reach ${host} to ${what} (${reason}). Check that this server can make HTTPS requests to ${host}: its firewall, DNS, or a proxy.`);
  }
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${host} answered ${response.status} with something other than JSON while trying to ${what}: ${text.slice(0, 120)}`);
  }
}


export function registerAuth(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0]!;
    if (!path.startsWith("/api/") || path.startsWith("/api/auth/") || PUBLIC_PATHS.has(path)) return;
    const login = currentLogin(request);
    if (!login) return reply.code(401).send({ error: "Sign in required" });
    // Checked on every request, so taking someone off the lists signs them out.
    const role = roleOf(login, [TOKEN_LOGIN, "dev"]);
    if (!role) return reply.code(401).send({ error: `@${login} may no longer sign in here` });
    request.adminLogin = login;
    request.role = role;
  });

  app.get("/api/auth/me", async (request) => {
    const login = currentLogin(request);
    const credentials = getCredentials();
    const githubLogin = Boolean(credentials?.clientId && credentials.clientSecret);
    // Before sign-in, say when the App's Callback URL can't match PUBLIC_URL (GitHub only shows a generic error).
    const check = githubLogin && !login ? addressCheck(await appAddresses()) : null;
    return {
      login,
      role: roleOf(login, [TOKEN_LOGIN, "dev"]),
      githubLogin,
      authDisabled: config.authDisabled,
      callbackUrl: `${config.publicUrl}/api/auth/github/callback`,
      signInProblem: check?.callbackProblem ?? null,
    };
  });

  app.post<{ Body: { token?: string } }>("/api/auth/token", async (request, reply) => {
    const token = String(request.body?.token ?? "");
    if (!token || !safeEqual(token, adminToken)) return reply.code(401).send({ error: "That admin token is not right" });
    startSession(reply, TOKEN_LOGIN);
    audit({ adminLogin: TOKEN_LOGIN, role: "admin" }, "sign in", "with the admin token");
    return { login: TOKEN_LOGIN };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const raw = request.cookies[COOKIE];
    const unsigned = raw ? request.unsignCookie(raw) : null;
    if (unsigned?.valid && unsigned.value) deleteSession(unsigned.value);
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/github", async (_request, reply) => {
    const credentials = await ensureAppDetails();
    if (!credentials?.clientId) return reply.redirect("/#/login?error=github-login-not-configured");
    const state = randomBytes(16).toString("base64url");
    reply.setCookie(STATE_COOKIE, state, { path: "/", httpOnly: true, sameSite: "lax", secure: secureCookies(), maxAge: 600, signed: true });
    const url = new URL(`${config.github.url}/login/oauth/authorize`);
    url.searchParams.set("client_id", credentials.clientId);
    url.searchParams.set("redirect_uri", `${config.publicUrl}/api/auth/github/callback`);
    url.searchParams.set("state", state);
    return reply.redirect(url.toString());
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>("/api/auth/github/callback", async (request, reply) => {
    const fail = (reason: string) => {
      log.warn("GitHub sign-in failed", { reason });
      return reply.redirect(`/#/login?error=${encodeURIComponent(reason)}`);
    };
    const raw = request.cookies[STATE_COOKIE];
    const expected = raw ? request.unsignCookie(raw) : null;
    reply.clearCookie(STATE_COOKIE, { path: "/" });
    // GitHub sends people back with ?error= when they cancel or the App is misconfigured.
    if (request.query.error) return fail(`GitHub said: ${request.query.error_description ?? request.query.error}`);
    if (!request.query.code || !expected?.valid || expected.value !== request.query.state) {
      return fail(`Sign-in expired, or it was started at another address than PUBLIC_URL (${config.publicUrl}). Open ${config.publicUrl} and sign in from there.`);
    }
    const credentials = getCredentials();
    if (!credentials?.clientId || !credentials.clientSecret) return fail("GitHub sign-in is not configured");
    try {
      const tokenData = await githubJson<{ access_token?: string; error?: string; error_description?: string }>(
        `${config.github.url}/login/oauth/access_token`,
        {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json", "user-agent": "agent-orchestrator" },
          body: JSON.stringify({ client_id: credentials.clientId, client_secret: credentials.clientSecret, code: request.query.code }),
        },
        "finish signing you in",
      );
      if (!tokenData.access_token) {
        const why = tokenData.error_description ?? tokenData.error ?? "it didn't return a token";
        const hint = tokenData.error === "incorrect_client_credentials" ? " The App's client secret here doesn't match GitHub's (GITHUB_CLIENT_SECRET, or recreate the App)." : "";
        return fail(`GitHub didn't accept the sign-in: ${why}.${hint}`);
      }
      const user = await githubJson<{ login?: string; message?: string }>(
        `${config.github.apiUrl}/user`,
        { headers: { authorization: `Bearer ${tokenData.access_token}`, accept: "application/vnd.github+json", "user-agent": "agent-orchestrator" } },
        "look up who you are",
      );
      const login = user.login ?? "";
      if (!login) return fail(`GitHub didn't say who you are${user.message ? `: ${user.message}` : ""}.`);
      const role = roleOf(login);
      if (!role) {
        log.warn("Rejected admin sign-in", { login });
        audit({ adminLogin: login, role: "none" as never }, "sign in", "refused: not in ADMIN_USERS, OPERATOR_USERS or VIEWER_USERS", 403);
        return fail(`@${login} is not an admin. Add them to ADMIN_USERS (or OPERATOR_USERS, or VIEWER_USERS to only look).`);
      }
      startSession(reply, login);
      audit({ adminLogin: login, role }, "sign in", "with GitHub");
      log.info("Signed in with GitHub", { login });
      return reply.redirect("/#/");
    } catch (error) {
      return fail(errorMessage(error));
    }
  });
}
