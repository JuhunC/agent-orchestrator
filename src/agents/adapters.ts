import type { EventKind, OutputFormat } from "../types.ts";

export interface AdapterEvent {
  kind: Extract<EventKind, "tool" | "text" | "system" | "error">;
  message: string;
}

export interface AdapterResult {
  /** The agent's final answer, posted back to GitHub. */
  result: string;
  sessionId: string | null;
  costUsd: number | null;
  isError: boolean;
}

export interface OutputAdapter {
  onLine(line: string): AdapterEvent[];
  finish(): AdapterResult;
}

const MAX_RESULT = 60_000;

function short(text: string, max = 160): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

function makeRelative(cwd: string) {
  return (path: unknown): string => {
    const value = String(path ?? "");
    if (cwd && value.startsWith(cwd)) return value.slice(cwd.length).replace(/^\/+/, "") || ".";
    return value;
  };
}

function tryJson(line: string): Record<string, any> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as Record<string, any>;
  } catch {
    return null;
  }
}

/** Human-readable one-liner for a tool call, shared by the Claude/Cursor/Gemini formats. */
export function describeTool(name: string, input: Record<string, any>, rel: (path: unknown) => string): string {
  const path = input.file_path ?? input.path ?? input.absolute_path ?? input.notebook_path ?? input.filePath;
  const command = input.command ?? input.cmd;
  switch (name.toLowerCase()) {
    case "bash":
    case "shell":
    case "run_shell_command":
    case "shelltoolcall":
      return `Ran \`${short(String(Array.isArray(command) ? command.join(" ") : command ?? ""), 120)}\``;
    case "read":
    case "read_file":
    case "readtoolcall":
    case "read_many_files":
      return `Read ${path ? `\`${rel(path)}\`` : "files"}`;
    case "write":
    case "write_file":
    case "writetoolcall":
      return `Wrote \`${rel(path)}\``;
    case "edit":
    case "multiedit":
    case "replace":
    case "edittoolcall":
    case "notebookedit":
      return `Edited \`${rel(path)}\``;
    case "deletetoolcall":
      return `Deleted \`${rel(path)}\``;
    case "grep":
    case "search_file_content":
    case "greptoolcall":
      return `Searched for \`${short(String(input.pattern ?? input.query ?? ""), 80)}\``;
    case "glob":
    case "globtoolcall":
    case "ls":
    case "list_directory":
    case "lstoolcall":
      return `Listed \`${short(String(input.pattern ?? (path ? rel(path) : ".")), 80)}\``;
    case "webfetch":
    case "web_fetch":
      return `Fetched ${short(String(input.url ?? input.prompt ?? ""), 100)}`;
    case "websearch":
    case "google_web_search":
      return `Searched the web for "${short(String(input.query ?? ""), 80)}"`;
    case "todowrite":
    case "todotoolcall":
    case "write_todos": {
      const todos = (input.todos ?? []) as { content?: string; status?: string }[];
      const active = todos.find((todo) => todo.status === "in_progress");
      return active?.content ? `Working on: ${short(active.content, 120)}` : `Updated plan (${todos.length} items)`;
    }
    case "task":
    case "agent":
      return `Started a sub-agent: ${short(String(input.description ?? input.prompt ?? ""), 100)}`;
    default:
      return `Used ${name}`;
  }
}

/** Claude Code `--output-format stream-json`; also understands Cursor CLI's `tool_call` events. */
function claudeAdapter(cwd: string): OutputAdapter {
  const rel = makeRelative(cwd);
  let sessionId: string | null = null;
  let result: string | null = null;
  let lastText = "";
  let costUsd: number | null = null;
  let isError = false;

  return {
    onLine(line) {
      const event = tryJson(line);
      if (!event) return line.trim() ? [{ kind: "text", message: short(line, 300) }] : [];
      if (event.session_id) sessionId = String(event.session_id);
      const events: AdapterEvent[] = [];

      if (event.type === "system" && event.subtype === "init") {
        events.push({ kind: "system", message: `Session started${event.model ? ` (${event.model})` : ""}` });
      } else if (event.type === "assistant" && event.message?.content) {
        const content = Array.isArray(event.message.content) ? event.message.content : [];
        for (const block of content) {
          if (block.type === "text" && block.text?.trim()) {
            lastText = block.text;
            events.push({ kind: "text", message: short(block.text, 300) });
          } else if (block.type === "tool_use") {
            events.push({ kind: "tool", message: describeTool(String(block.name), block.input ?? {}, rel) });
          }
        }
      } else if (event.type === "tool_call" && event.subtype === "started" && event.tool_call) {
        // Cursor CLI: { tool_call: { readToolCall: { args: {...} } } }
        const [key, value] = Object.entries(event.tool_call as Record<string, any>)[0] ?? [];
        if (key) {
          const name = key === "function" ? String(value?.name ?? "tool") : key;
          const args = key === "function" ? safeParse(value?.arguments) : (value?.args ?? {});
          events.push({ kind: "tool", message: describeTool(name, args, rel) });
        }
      } else if (event.type === "result") {
        if (typeof event.result === "string") result = event.result;
        if (typeof event.total_cost_usd === "number") costUsd = event.total_cost_usd;
        isError = event.is_error === true || (typeof event.subtype === "string" && event.subtype.startsWith("error"));
        if (isError) events.push({ kind: "error", message: short(String(event.result ?? event.subtype ?? "Agent reported an error"), 300) });
      }
      return events;
    },
    finish() {
      return { result: (result ?? lastText).slice(0, MAX_RESULT), sessionId, costUsd, isError };
    },
  };
}

function safeParse(value: unknown): Record<string, any> {
  if (typeof value !== "string") return (value as Record<string, any>) ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

/** OpenAI Codex `codex exec --json` (JSONL thread/turn/item events). */
function codexAdapter(cwd: string): OutputAdapter {
  const rel = makeRelative(cwd);
  let sessionId: string | null = null;
  let lastMessage = "";
  let isError = false;
  let errorText = "";

  return {
    onLine(line) {
      const event = tryJson(line);
      if (!event) return line.trim() ? [{ kind: "text", message: short(line, 300) }] : [];
      const item = event.item ?? {};
      switch (event.type) {
        case "thread.started":
          sessionId = event.thread_id ?? sessionId;
          return [{ kind: "system", message: "Session started" }];
        case "item.started":
          if (item.type === "command_execution") {
            const command = String(item.command ?? "").replace(/^(\/bin\/)?(ba)?sh -l?c\s+/, "").replace(/^['"]|['"]$/g, "");
            return [{ kind: "tool", message: `Ran \`${short(command, 120)}\`` }];
          }
          if (item.type === "mcp_tool_call") return [{ kind: "tool", message: `Used ${item.server ?? "mcp"}.${item.tool ?? "tool"}` }];
          if (item.type === "web_search") return [{ kind: "tool", message: `Searched the web for "${short(String(item.query ?? ""), 80)}"` }];
          return [];
        case "item.completed":
          if (item.type === "agent_message" && item.text) {
            lastMessage = item.text;
            return [{ kind: "text", message: short(item.text, 300) }];
          }
          if (item.type === "file_change" && Array.isArray(item.changes)) {
            const paths = item.changes.map((change: { path?: string }) => `\`${rel(change.path)}\``).join(", ");
            return [{ kind: "tool", message: `Edited ${paths}` }];
          }
          if (item.type === "error") return [{ kind: "error", message: short(String(item.message ?? "error"), 300) }];
          return [];
        case "turn.failed":
        case "error":
          isError = true;
          errorText = String(event.error?.message ?? event.message ?? "Codex failed");
          return [{ kind: "error", message: short(errorText, 300) }];
        default:
          return [];
      }
    },
    finish() {
      return { result: (lastMessage || errorText).slice(0, MAX_RESULT), sessionId, costUsd: null, isError };
    },
  };
}

/** Gemini CLI `--output-format stream-json`. */
function geminiAdapter(cwd: string): OutputAdapter {
  const rel = makeRelative(cwd);
  let sessionId: string | null = null;
  let all = "";
  let sinceLastTool = "";
  let isError = false;

  return {
    onLine(line) {
      const event = tryJson(line);
      if (!event) return line.trim() ? [{ kind: "text", message: short(line, 300) }] : [];
      switch (event.type) {
        case "init":
          sessionId = event.session_id ?? sessionId;
          return [{ kind: "system", message: `Session started${event.model ? ` (${event.model})` : ""}` }];
        case "message":
          if (event.role === "assistant" && typeof event.content === "string") {
            all += event.content;
            sinceLastTool += event.content;
          }
          return [];
        case "tool_use": {
          const events: AdapterEvent[] = [];
          if (sinceLastTool.trim()) events.push({ kind: "text", message: short(sinceLastTool, 300) });
          sinceLastTool = "";
          events.push({ kind: "tool", message: describeTool(String(event.tool_name), event.parameters ?? {}, rel) });
          return events;
        }
        case "tool_result":
          return event.status === "error" ? [{ kind: "error", message: short(String(event.error?.message ?? "Tool failed"), 200) }] : [];
        case "error":
          return [{ kind: "error", message: short(String(event.message ?? "error"), 300) }];
        case "result":
          isError = event.status === "error";
          return sinceLastTool.trim() ? [{ kind: "text", message: short(sinceLastTool, 300) }] : [];
        default:
          return [];
      }
    },
    finish() {
      return { result: (sinceLastTool.trim() ? sinceLastTool : all).trim().slice(0, MAX_RESULT), sessionId, costUsd: null, isError };
    },
  };
}

/**
 * Plain text: stdout is the answer. Lines starting with `::progress::` are shown as progress
 * steps (and left out of the answer), so custom agents can report what they're doing.
 */
function textAdapter(): OutputAdapter {
  const lines: string[] = [];
  return {
    onLine(line) {
      const progress = line.match(/^::progress::\s*(.*)$/);
      if (progress) return progress[1]!.trim() ? [{ kind: "tool", message: short(progress[1]!, 200) }] : [];
      lines.push(line);
      return line.trim() ? [{ kind: "text", message: short(line, 300) }] : [];
    },
    finish() {
      const text = lines.join("\n").trim();
      return { result: text.length > MAX_RESULT ? text.slice(-MAX_RESULT) : text, sessionId: null, costUsd: null, isError: false };
    },
  };
}

export function createAdapter(format: OutputFormat, cwd: string): OutputAdapter {
  switch (format) {
    case "claude-stream-json":
      return claudeAdapter(cwd);
    case "codex-json":
      return codexAdapter(cwd);
    case "gemini-stream-json":
      return geminiAdapter(cwd);
    default:
      return textAdapter();
  }
}
