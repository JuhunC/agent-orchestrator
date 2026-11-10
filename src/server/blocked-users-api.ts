import type { FastifyInstance } from "fastify";
import { BlockedUserError, blockUser, setBlockedUsers, unblockUser } from "../blocked-users.ts";
import { bus } from "../bus.ts";
import { listBlockedUsers } from "../db.ts";

/** Settings → Blocked users: the GitHub accounts agents don't take requests from. Admins only. */
export function registerBlockedUserRoutes(app: FastifyInstance): void {
  app.get("/api/blocked-users", async () => ({ users: listBlockedUsers() }));

  /** Adds one account: { login }. */
  app.post<{ Body: { login?: string } }>("/api/blocked-users", async (request, reply) => {
    try {
      const users = blockUser(request.body?.login, request.adminLogin ?? "admin");
      bus.publish({ type: "settings" });
      return { users };
    } catch (error) {
      if (error instanceof BlockedUserError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });

  /** Replaces the whole list: { users: ["login", …] } (an empty list unblocks everyone). */
  app.put<{ Body: { users?: unknown } }>("/api/blocked-users", async (request, reply) => {
    try {
      const users = setBlockedUsers(request.body?.users, request.adminLogin ?? "admin");
      bus.publish({ type: "settings" });
      return { users };
    } catch (error) {
      if (error instanceof BlockedUserError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });

  app.delete<{ Params: { login: string } }>("/api/blocked-users/:login", async (request, reply) => {
    try {
      if (!unblockUser(request.params.login)) return reply.code(404).send({ error: `${request.params.login} isn't blocked` });
      bus.publish({ type: "settings" });
      return { users: listBlockedUsers() };
    } catch (error) {
      if (error instanceof BlockedUserError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });
}
