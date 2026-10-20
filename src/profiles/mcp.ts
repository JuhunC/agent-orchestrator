import type { McpServer, McpServers } from "./types.ts";

const NAME = /^[A-Za-z0-9_-]{1,64}$/;

function stringMap(value: unknown, where: string): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be a map of strings`);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, String(item)]));
}

/** Validates MCP server definitions. Accepts `{ "mcpServers": {...} }` or the bare map. */
export function normaliseMcpServers(raw: unknown, where = "mcp.json"): McpServers {
  if (raw === undefined || raw === null || raw === "") return {};
  let value: unknown = raw;
  if (typeof value === "string") value = JSON.parse(value) as unknown;
  if (value && typeof value === "object" && "mcpServers" in value) value = (value as { mcpServers: unknown }).mcpServers;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must map server names to definitions`);
  const servers: McpServers = {};
  for (const [name, definition] of Object.entries(value as Record<string, Record<string, unknown>>)) {
    if (!NAME.test(name)) throw new Error(`${where}: server name "${name}" may only use letters, digits, - and _`);
    if (name === "github") throw new Error(`${where}: "github" is reserved for the orchestrator's GitHub tools`);
    if (!definition || typeof definition !== "object") throw new Error(`${where}.${name} must be an object`);
    const url = definition.url ?? definition.httpUrl;
    if (url) {
      const type: McpServer["type"] = definition.type === "sse" ? "sse" : "http";
      servers[name] = { type, url: String(url), headers: stringMap(definition.headers, `${where}.${name}.headers`) };
      if (definition.alwaysLoad === true) servers[name]!.alwaysLoad = true;
    } else if (definition.command) {
      const args = definition.args ?? [];
      if (!Array.isArray(args)) throw new Error(`${where}.${name}.args must be a list`);
      servers[name] = { type: "stdio", command: String(definition.command), args: args.map(String), env: stringMap(definition.env, `${where}.${name}.env`) };
      if (definition.alwaysLoad === true) servers[name]!.alwaysLoad = true;
    } else {
      throw new Error(`${where}.${name} needs a "command" (local server) or a "url" (remote server)`);
    }
  }
  return servers;
}

/** Replaces ${VAR} with values from `vars`; unknown variables become empty. */
export function expandVars(text: string, vars: Record<string, string | undefined>): string {
  return text.replace(/\$\{(\w+)\}/g, (_, name: string) => vars[name] ?? "");
}

export function expandMcpServers(servers: McpServers, vars: Record<string, string | undefined>): McpServers {
  const sub = (text: string) => expandVars(text, vars);
  const map = (input?: Record<string, string>) => (input ? Object.fromEntries(Object.entries(input).map(([key, value]) => [key, sub(value)])) : undefined);
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      { ...server, command: server.command && sub(server.command), args: server.args?.map(sub), env: map(server.env), url: server.url && sub(server.url), headers: map(server.headers) },
    ]),
  );
}
