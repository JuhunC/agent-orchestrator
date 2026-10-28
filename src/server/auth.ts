import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.ts";
import { createSession, deleteSession, getSession } from "../db.ts";
import { addressCheck, appAddresses, ensureAppDetails, getCredentials } from "../github/app.ts";
import { errorMessage, log } from "../log.ts";
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

/** Who may sign in with GitHub: ADMIN_USERS, plus the account that created the app via setup. */
function allowedLogins(): string[] {
  const credentials = getCredentials();
  const owner = credentials?.source === "setup" && credentials.ownerLogin ? [credentials.ownerLogin.toLowerCase()] : [];
  return [...new Set([...config.adminUsers, ...owner])];
}

export function registerAuth(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0]!;
    if (!path.startsWith("/api/") || path.startsWith("/api/auth/") || PUBLIC_PATHS.has(path)) return;
    const login = currentLogin(request);
    if (!login) return reply.code(401).send({ error: "Sign in required" });
    request.adminLogin = login;
  });

  app.get("/api/auth/me", async (request) => {
    const login = currentLogin(request);
    const credentials = getCredentials();
    const githubLogin = Boolean(credentials?.clientId && credentials.clientSecret);
    // Before sign-in, say when the App's Callback URL can't match PUBLIC_URL (GitHub only shows a generic error).
    const check = githubLogin && !login ? addressCheck(await appAddresses()) : null;
    return {
      login,
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

  app.get<{ Querystring: { code?: string; state?: string } }>("/api/auth/github/callback", async (request, reply) => {
    const fail = (reason: string) => reply.redirect(`/#/login?error=${encodeURIComponent(reason)}`);
    const raw = request.cookies[STATE_COOKIE];
    const expected = raw ? request.unsignCookie(raw) : null;
    reply.clearCookie(STATE_COOKIE, { path: "/" });
    if (!request.query.code || !expected?.valid || expected.value !== request.query.state) return fail("Sign-in expired. Try again.");
    const credentials = getCredentials();
    if (!credentials?.clientId || !credentials.clientSecret) return fail("GitHub sign-in is not configured");
    try {
      const response = await fetch(`${config.github.url}/login/oauth/access_token`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ client_id: credentials.clientId, client_secret: credentials.clientSecret, code: request.query.code }),
      });
      const tokenData = (await response.json()) as { access_token?: string; error_description?: string };
      if (!tokenData.access_token) return fail(tokenData.error_description ?? "GitHub did not return a token");
      const userResponse = await fetch(`${config.github.apiUrl}/user`, {
        headers: { authorization: `Bearer ${tokenData.access_token}`, accept: "application/vnd.github+json", "user-agent": "agent-orchestrator" },
      });
      const user = (await userResponse.json()) as { login?: string };
      const login = user.login ?? "";
      if (!allowedLogins().includes(login.toLowerCase())) {
        log.warn("Rejected admin sign-in", { login });
        return fail(`@${login} is not an admin. Add them to ADMIN_USERS.`);
      }
      startSession(reply, login);
      return reply.redirect("/#/");
    } catch (error) {
      return fail(errorMessage(error));
    }
  });
}
