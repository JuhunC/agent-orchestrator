import { randomBytes } from "node:crypto";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { config } from "../config.ts";
import { errorMessage, log } from "../log.ts";

/**
 * Agents talk to the model service through the orchestrator, with a credential of their own that
 * is only good while their session runs. The real API key (or auth or OAuth token) stays in the
 * orchestrator, so an agent that's been talked into leaking its environment leaks nothing that
 * outlives it. A local-only HTTP listener swaps the agent's credential for the real one and passes
 * everything else (streaming included) through unchanged.
 */

const CREDENTIALS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] as const;
const CLOUD = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];
const HOP_BY_HOP = ["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-authorization", "proxy-authenticate", "proxy-connection", "te", "trailer"];

/** Credentials agents' sessions present, and which session each belongs to. */
const grants = new Map<string, string>();
let server: Server | null = null;
let listening: Promise<number> | null = null;
let port = 0;

const truthy = (value: string | undefined) => Boolean(value && !["0", "false", "no", ""].includes(value.toLowerCase()));

/** Is the proxy in use? Not for Bedrock, Vertex or Foundry (cloud credentials), or with MODEL_PROXY=off. */
export function modelProxyEnabled(): boolean {
  if (config.modelProxy === "off") return false;
  if (CLOUD.some((name) => truthy(process.env[name]))) return false;
  return CREDENTIALS.some((name) => Boolean(process.env[name]));
}

/** Starts the local listener once (127.0.0.1, a free port). */
export function startModelProxy(): Promise<number> {
  if (!modelProxyEnabled()) return Promise.resolve(0);
  listening ??= new Promise<number>((resolve, reject) => {
    server = createServer((req, res) => handle(req, res));
    server.on("error", reject);
    server.unref(); // never what keeps the process running
    server.listen(0, "127.0.0.1", () => {
      port = (server!.address() as { port: number }).port;
      log.info("Agents reach the model service through the orchestrator", { port });
      resolve(port);
    });
  });
  return listening;
}

export function stopModelProxy(): void {
  server?.closeAllConnections();
  server?.close();
  server = null;
  listening = null;
  grants.clear();
}

/**
 * What a new agent session gets instead of the real credentials: the proxy's address and a
 * credential of its own, for each credential variable that's set. Null when the proxy isn't used.
 */
export function modelAccess(sessionKey: string): { env: Record<string, string>; token: string } | null {
  if (!modelProxyEnabled() || !port) return null;
  const token = `ao-session-${randomBytes(24).toString("base64url")}`;
  grants.set(token, sessionKey);
  const env: Record<string, string> = { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` };
  for (const name of CREDENTIALS) if (process.env[name]) env[name] = token;
  return { env, token };
}

/** The session ended: its credential stops working. */
export function revokeModelAccess(token: string | null | undefined): void {
  if (token) grants.delete(token);
}

function presented(headers: IncomingHttpHeaders): { token: string | null; header: "x-api-key" | "authorization" | null } {
  const key = headers["x-api-key"];
  if (typeof key === "string" && key) return { token: key, header: "x-api-key" };
  const auth = headers.authorization;
  if (typeof auth === "string" && /^bearer\s+/i.test(auth)) return { token: auth.replace(/^bearer\s+/i, ""), header: "authorization" };
  return { token: null, header: null };
}

function fail(res: ServerResponse, status: number, type: string, message: string): void {
  if (res.headersSent) return void res.destroy();
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const { token, header } = presented(req.headers);
  if (!token || !grants.has(token)) return fail(res, 401, "authentication_error", "This credential only works for a running agent session of the orchestrator.");
  const base = new URL(process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com");
  const target = new URL(`${base.pathname.replace(/\/+$/, "")}${req.url ?? "/"}`, base.origin);

  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name === "host" || name === "x-api-key" || name === "authorization" || HOP_BY_HOP.includes(name)) continue;
    headers[name] = value;
  }
  // The real credential, in the header the agent used.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const bearer = process.env.ANTHROPIC_AUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (header === "x-api-key" && apiKey) headers["x-api-key"] = apiKey;
  else if (header === "authorization" && bearer) headers.authorization = `Bearer ${bearer}`;
  else if (apiKey) headers["x-api-key"] = apiKey;
  else if (bearer) headers.authorization = `Bearer ${bearer}`;

  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  const upstream = send(target, { method: req.method, headers }, (response) => {
    const out: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(response.headers)) if (value !== undefined && !HOP_BY_HOP.includes(name)) out[name] = value;
    res.writeHead(response.statusCode ?? 502, out);
    response.pipe(res);
    response.on("error", () => res.destroy());
  });
  upstream.on("error", (error) => fail(res, 502, "api_error", `The orchestrator couldn't reach the model service at ${target.origin}: ${errorMessage(error)}`));
  // The agent hung up (cancelled, timed out): stop the upstream request too.
  res.on("close", () => {
    if (!res.writableFinished) upstream.destroy();
  });
  req.pipe(upstream);
}
