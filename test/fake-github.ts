import { createServer, type IncomingMessage, type Server } from "node:http";

export interface FakeComment {
  id: number;
  body: string;
  user: { login: string; type: string };
  created_at: string;
  html_url: string;
  edits: number;
}

export interface FakeIssue {
  number: number;
  title: string;
  body: string;
  user: { login: string };
  comments: FakeComment[];
  pull?: { head: string; base: string };
}

/**
 * A tiny stand-in for the GitHub REST/GraphQL API, served under /api/v3 like GitHub Enterprise.
 * It implements just the endpoints the orchestrator calls and records every request.
 */
export class FakeGitHub {
  server: Server;
  port = 0;
  requests: { method: string; path: string; body: any }[] = [];
  issues = new Map<number, FakeIssue>();
  permissions = new Map<string, string>();
  labels: string[] = [];
  assignees: string[] = [];
  reactions = 0;
  private nextId = 1000;

  constructor() {
    this.server = createServer((req, res) => {
      void this.handle(req).then(
        ({ status, body }) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        },
        (error) => {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ message: String(error) }));
        },
      );
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as { port: number }).port;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  addIssue(issue: Omit<FakeIssue, "comments">): FakeIssue {
    const full = { ...issue, comments: [] };
    this.issues.set(issue.number, full);
    return full;
  }

  allComments(): FakeComment[] {
    return [...this.issues.values()].flatMap((issue) => issue.comments);
  }

  private async readBody(req: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    return text ? JSON.parse(text) : null;
  }

  private issueJson(issue: FakeIssue) {
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: "open",
      node_id: `I_${issue.number}`,
      html_url: `${this.url}/acme/widgets/issues/${issue.number}`,
      user: issue.user,
      comments: issue.comments.length,
      pull_request: issue.pull ? { url: "x" } : undefined,
    };
  }

  private async handle(req: IncomingMessage): Promise<{ status: number; body: unknown }> {
    const url = new URL(req.url ?? "/", this.url);
    const path = url.pathname.replace(/^\/api\/v3/, "").replace(/^\/api\/graphql$/, "/graphql");
    const body = await this.readBody(req);
    this.requests.push({ method: req.method ?? "GET", path: path + url.search, body });
    const method = req.method ?? "GET";
    let match: RegExpMatchArray | null;

    if (method === "POST" && (match = path.match(/^\/app\/installations\/(\d+)\/access_tokens$/))) {
      return { status: 201, body: { token: "ghs_faketoken", expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: {}, repository_selection: "all" } };
    }
    if (method === "GET" && path === "/app") return { status: 200, body: { slug: "test-orchestrator", html_url: `${this.url}/apps/test-orchestrator`, owner: { login: "acme" } } };
    if (method === "GET" && (match = path.match(/^\/users\/(.+)$/))) return { status: 200, body: { id: 4242, login: decodeURIComponent(match[1]!) } };
    if (method === "GET" && (match = path.match(/^\/repos\/[^/]+\/[^/]+\/collaborators\/([^/]+)\/permission$/))) {
      const permission = this.permissions.get(match[1]!) ?? "none";
      return { status: 200, body: { permission, role_name: permission, user: { login: match[1] } } };
    }
    if (method === "GET" && /^\/repos\/[^/]+\/[^/]+$/.test(path)) return { status: 200, body: { default_branch: "main", full_name: "acme/widgets" } };
    if (method === "GET" && (match = path.match(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/))) {
      const issue = this.issues.get(Number(match[1]));
      return issue ? { status: 200, body: this.issueJson(issue) } : { status: 404, body: { message: "Not Found" } };
    }
    if (method === "GET" && (match = path.match(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/))) {
      const issue = this.issues.get(Number(match[1]));
      return { status: 200, body: issue?.comments ?? [] };
    }
    if (method === "POST" && (match = path.match(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/))) {
      const issue = this.issues.get(Number(match[1]))!;
      const comment: FakeComment = {
        id: this.nextId++,
        body: body.body,
        user: { login: "test-orchestrator[bot]", type: "Bot" },
        created_at: new Date().toISOString(),
        html_url: `${this.url}/acme/widgets/issues/${issue.number}#comment`,
        edits: 0,
      };
      issue.comments.push(comment);
      return { status: 201, body: comment };
    }
    if (method === "PATCH" && (match = path.match(/^\/repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/))) {
      const comment = this.allComments().find((candidate) => candidate.id === Number(match![1]));
      if (!comment) return { status: 404, body: { message: "Not Found" } };
      comment.body = body.body;
      comment.edits++;
      return { status: 200, body: comment };
    }
    if (method === "POST" && path.match(/^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/assignees$/)) {
      this.assignees.push(...body.assignees);
      return { status: 201, body: {} };
    }
    if (method === "POST" && path.match(/^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/labels$/)) {
      this.labels.push(...body.labels);
      return { status: 200, body: [] };
    }
    if (method === "GET" && path === "/repos/acme/widgets/pulls") {
      const head = url.searchParams.get("head")?.split(":")[1];
      const open = [...this.issues.values()].filter((issue) => issue.pull && issue.pull.head === head);
      return { status: 200, body: open.map((issue) => ({ number: issue.number, html_url: `${this.url}/acme/widgets/pull/${issue.number}` })) };
    }
    if (method === "POST" && path === "/repos/acme/widgets/pulls") {
      const number = Math.max(0, ...this.issues.keys()) + 1;
      this.issues.set(number, { number, title: body.title, body: body.body, user: { login: "test-orchestrator[bot]" }, comments: [], pull: { head: body.head, base: body.base } });
      return { status: 201, body: { number, html_url: `${this.url}/acme/widgets/pull/${number}` } };
    }
    if (method === "POST" && path === "/graphql") {
      if (String(body.query).includes("addReaction")) this.reactions++;
      return { status: 200, body: { data: {} } };
    }
    return { status: 404, body: { message: `Fake GitHub has no route for ${method} ${path}` } };
  }
}
