import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { config } from "../config.ts";
import { getCredentials } from "../github/app.ts";
import { log } from "../log.ts";
import { handleWebhook } from "../triggers.ts";
import { registerApi } from "./api.ts";
import { registerAuth } from "./auth.ts";
import { sessionSecret } from "./secrets.ts";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export function verifySignature(secret: string, body: Buffer, signature: string | undefined): boolean {
  if (!secret || !signature?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 26 * 1024 * 1024, trustProxy: true });

  // Keep the raw bytes: the webhook signature is computed over them.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    request.rawBody = body as Buffer;
    try {
      done(null, body.length ? JSON.parse(body.toString("utf8")) : {});
    } catch (error) {
      done(error as Error, undefined);
    }
  });
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "buffer" }, (request, body, done) => {
    request.rawBody = body as Buffer;
    const params = new URLSearchParams(body.toString("utf8"));
    try {
      done(null, params.has("payload") ? JSON.parse(params.get("payload")!) : Object.fromEntries(params));
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  await app.register(cookie, { secret: sessionSecret });
  registerAuth(app);

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/api/health", async () => ({ ok: true, configured: Boolean(getCredentials()) }));

  app.post("/api/github/webhooks", async (request, reply) => {
    const credentials = getCredentials();
    if (!credentials) return reply.code(503).send({ error: "GitHub App not configured" });
    const signature = request.headers["x-hub-signature-256"] as string | undefined;
    if (!verifySignature(credentials.webhookSecret, request.rawBody ?? Buffer.alloc(0), signature)) {
      log.warn("Rejected webhook with a bad signature", { delivery: request.headers["x-github-delivery"] });
      return reply.code(401).send({ error: "Bad signature" });
    }
    const event = String(request.headers["x-github-event"] ?? "");
    const delivery = String(request.headers["x-github-delivery"] ?? "");
    void handleWebhook(event, delivery, request.body as Record<string, unknown>);
    return reply.code(202).send({ ok: true });
  });

  registerApi(app);

  if (existsSync(config.webDistDir)) {
    await app.register(fastifyStatic, { root: config.webDistDir, prefix: "/", index: ["index.html"] });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
      return reply.sendFile("index.html");
    });
  } else {
    log.warn("Admin UI is not built; run `npm run build`", { dir: config.webDistDir });
  }

  return app;
}
