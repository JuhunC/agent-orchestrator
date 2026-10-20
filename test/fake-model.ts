import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

export interface ModelRequest {
  body: any;
  /** The text of the task prompt this request is answering. */
  prompt: string;
  /** Tool calls already made since that prompt. */
  step: number;
  isAgentLoop: boolean;
}

/** Decides what the "model" answers. Return blocks; tool_use blocks make Claude Code run tools. */
export type Script = (request: ModelRequest) => Block[] | { status: number; error: { type: string; message: string } };

/**
 * A stand-in for the Anthropic Messages API (ANTHROPIC_BASE_URL). The real Agent SDK and Claude
 * Code run against it, so tests exercise the actual agent loop, tools and sessions.
 */
export class FakeModel {
  server: Server;
  port = 0;
  requests: ModelRequest[] = [];
  script: Script = () => [{ type: "text", text: "OK" }];
  private nextId = 1;

  constructor() {
    this.server = createServer((req, res) => void this.handle(req, res).catch((error) => {
      res.writeHead(500);
      res.end(String(error));
    }));
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(host = "127.0.0.1"): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, host, resolve));
    this.port = (this.server.address() as { port: number }).port;
  }

  stop(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  /** Requests from the main agent loop (they offer the orchestrator's github tools). */
  agentRequests(): ModelRequest[] {
    return this.requests.filter((request) => request.isAgentLoop);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "POST" && path === "/v1/messages/count_tokens") return this.json(res, 200, { input_tokens: 100 });
    if (req.method !== "POST" || path !== "/v1/messages") return this.json(res, 404, { type: "error", error: { type: "not_found_error", message: "Not found" } });

    const body = JSON.parse(text);
    // The main agent loop is the one offered the orchestrator's github tools.
    const isAgentLoop = Array.isArray(body.tools) && body.tools.some((tool: { name?: string }) => tool.name?.startsWith("mcp__github__"));
    const { prompt, step } = analyse(body.messages ?? []);
    const request: ModelRequest = { body, prompt, step, isAgentLoop };
    this.requests.push(request);
    const answer = isAgentLoop ? this.script(request) : [{ type: "text" as const, text: "OK" }];
    if (!Array.isArray(answer)) return this.json(res, answer.status, { type: "error", error: answer.error });

    const content = answer.map((block) => (block.type === "tool_use" ? { ...block, id: block.id || `toolu_${this.nextId++}` } : block));
    const stopReason = content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn";
    const message = { id: `msg_${this.nextId++}`, type: "message", role: "assistant", model: body.model, stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 } };
    if (!body.stream) return this.json(res, 200, { ...message, content });

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send("message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 1 } } });
    content.forEach((block, index) => {
      if (block.type === "text") {
        send("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
        send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
      } else {
        send("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
        send("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
      }
      send("content_block_stop", { type: "content_block_stop", index });
    });
    send("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } });
    send("message_stop", { type: "message_stop" });
    res.end();
  }

  private json(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  }
}

/** Finds the latest real user prompt and how many tool calls have happened since. */
function analyse(messages: { role: string; content: unknown }[]): { prompt: string; step: number } {
  let step = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : (message.content as { type: string; text?: string }[]);
    // Claude Code adds mid-conversation system messages; they aren't the user's prompt.
    if (message.role === "system") continue;
    if (message.role === "assistant") {
      step += blocks.filter((block) => block.type === "tool_use").length;
      continue;
    }
    const texts = blocks.filter((block) => block.type === "text" && block.text && !block.text.startsWith("<system-reminder>")).map((block) => block.text!);
    if (texts.length && !blocks.some((block) => block.type === "tool_result")) return { prompt: texts.join("\n"), step };
  }
  return { prompt: "", step };
}
