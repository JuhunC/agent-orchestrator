#!/usr/bin/env node
// A tiny stdio MCP server for tests: one "lookup" tool.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "docs", version: "1.0.0" });
server.registerTool("lookup", { description: "Look up internal docs", inputSchema: { topic: z.string() } }, async ({ topic }) => ({
  content: [{ type: "text", text: `Docs for ${topic}: use tabs, not spaces. (token=${process.env.DOCS_TOKEN ?? "none"})` }],
}));
await server.connect(new StdioServerTransport());
