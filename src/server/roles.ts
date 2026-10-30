import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../config.ts";
import { addAudit, listAudit } from "../db.ts";
import { getCredentials } from "../github/app.ts";

/**
 * Who may do what in the admin UI. Admins (ADMIN_USERS, the account that created the App, the
 * admin token) change anything. Operators (OPERATOR_USERS) run the queue: pause it, run, cancel,
 * retry and turn agents on and off, but don't change configuration, prompts or credentials.
 * Viewers (VIEWER_USERS) only look. Every change, and every refused attempt, goes in the audit log.
 */

export type Role = "admin" | "operator" | "viewer";

/** Logins that are always admins: ADMIN_USERS and the account that created the App here. */
export function adminLogins(): string[] {
  const credentials = getCredentials();
  const owner = credentials?.source === "setup" && credentials.ownerLogin ? [credentials.ownerLogin.toLowerCase()] : [];
  return [...new Set([...config.adminUsers, ...owner])];
}

export function roleOf(login: string | null, special: string[] = []): Role | null {
  if (!login) return null;
  if (special.includes(login)) return "admin";
  const lower = login.toLowerCase();
  if (adminLogins().includes(lower)) return "admin";
  if (config.operatorUsers.includes(lower)) return "operator";
  if (config.viewerUsers.includes(lower)) return "viewer";
  return null;
}

/** Changes operators may make: running the queue, not configuring it. */
const OPERATOR_WRITES: [string, RegExp][] = [
  ["POST", /^\/api\/tasks$/],
  ["POST", /^\/api\/tasks\/\d+\/(cancel|retry|run-now|replay)$/],
  ["POST", /^\/api\/tasks\/cancel-all$/],
  ["POST", /^\/api\/agents\/[^/]+\/enabled$/],
  ["POST", /^\/api\/agents\/[^/]+\/github-account\/check$/],
  ["POST", /^\/api\/boards\/[^/]+\/sync$/],
  ["DELETE", /^\/api\/sessions\/[^/]+$/],
  ["DELETE", /^\/api\/limit$/],
  ["POST", /^\/api\/workspaces\/cleanup$/],
  ["POST", /^\/api\/schedules\/\d+\/run$/],
];

const READS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Why this role may not make this request, or null when it may. */
export function refusal(role: Role, method: string, path: string, body: unknown): string | null {
  if (role === "admin" || READS.has(method)) return null;
  if (role === "viewer") return "Viewers can look but not change anything. Ask an admin to add you to OPERATOR_USERS or ADMIN_USERS.";
  if (OPERATOR_WRITES.some(([verb, pattern]) => verb === method && pattern.test(path))) return null;
  // Operators may pause and resume the queue, nothing else in Settings.
  if (method === "PUT" && path === "/api/settings" && body && typeof body === "object" && Object.keys(body).every((key) => key === "paused")) return null;
  // ... and pause and resume schedules.
  if (method === "PATCH" && /^\/api\/schedules\/\d+$/.test(path) && body && typeof body === "object" && Object.keys(body).every((key) => key === "enabled")) return null;
  return "Operators can run, stop and retry agents, pause the queue and pause schedules, but not change configuration. Ask an admin.";
}

const SECRET = /token|secret|password|private|key$/i;

/** What a change was, for the audit log: the request's fields, with secrets and long text left out. */
export function summarize(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  return Object.entries(body as Record<string, unknown>)
    .map(([key, value]) => {
      if (SECRET.test(key)) return `${key}: (hidden)`;
      if (typeof value === "string") return `${key}: ${value.length > 80 ? `(${value.length} characters)` : JSON.stringify(value)}`;
      const text = JSON.stringify(value);
      return `${key}: ${text && text.length > 80 ? `${text.slice(0, 77)}…` : text}`;
    })
    .join(", ");
}

declare module "fastify" {
  interface FastifyRequest {
    role?: Role;
  }
}

export function audit(request: Pick<FastifyRequest, "adminLogin" | "role">, action: string, detail = "", status = 200): void {
  addAudit({ login: request.adminLogin ?? "?", role: request.role ?? "?", action, detail, status });
}

/** Checks each change against the signed-in role, and records it. */
export function registerRoles(app: FastifyInstance): void {
  app.addHook("preHandler", async (request, reply) => {
    if (!request.role || !request.url.startsWith("/api/")) return;
    const path = request.url.split("?")[0]!;
    const why = refusal(request.role, request.method, path, request.body);
    if (why) {
      audit(request, `${request.method} ${path}`, `refused: ${summarize(request.body)}`, 403);
      return reply.code(403).send({ error: why });
    }
  });
  app.addHook("onResponse", async (request, reply) => {
    if (!request.role || READS.has(request.method) || reply.statusCode === 403) return;
    const path = request.url.split("?")[0]!;
    if (!path.startsWith("/api/") || path.startsWith("/api/auth/")) return;
    audit(request, `${request.method} ${path}`, summarize(request.body), reply.statusCode);
  });
  app.get<{ Querystring: { limit?: string } }>("/api/audit", async (request) => listAudit(Math.min(1000, Number(request.query.limit) || 100)));
}
