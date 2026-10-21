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
  labels?: string[];
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
  reviews: { number: number; event: string; body: string }[] = [];
  prOpened?: (number: number) => void;
  /** One organization project (acme/1) with a Status field; items map node id → card. */
  project = {
    id: "PVT_acme_1",
    title: "Product",
    options: ["Backlog", "Ready", "In progress", "In review", "Done", "Needs human"].map((name) => ({ id: `opt_${name.replace(/\s+/g, "_")}`, name })),
  };
  items = new Map<string, { id: string; number: number; status: string | null; history: string[] }>();
  private nextId = 1000;

  addItem(number: number, status: string | null = null): string {
    const id = `PVTI_${number}`;
    this.items.set(id, { id, number, status, history: status ? [status] : [] });
    return id;
  }

  private itemNode(item: { id: string; number: number; status: string | null }) {
    const issue = this.issues.get(item.number);
    return {
      id: item.id,
      project: { id: this.project.id },
      fieldValueByName: item.status ? { name: item.status, optionId: `opt_${item.status}` } : null,
      content: { __typename: issue?.pull ? "PullRequest" : "Issue", number: item.number, title: issue?.title ?? "", repository: { name: "widgets", owner: { login: "acme" } } },
    };
  }

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

  addIssue(issue: Omit<FakeIssue, "comments"> & { labels?: string[] }): FakeIssue {
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
      labels: (issue.labels ?? []).map((name) => ({ name })),
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
      this.prOpened?.(number);
      return { status: 201, body: { number, html_url: `${this.url}/acme/widgets/pull/${number}` } };
    }
    if (method === "GET" && path === "/repos/acme/widgets/installation") return { status: 200, body: { id: 77 } };
    if (method === "GET" && path === "/app/installations") return { status: 200, body: [{ id: 77, account: { login: "ACME", type: "Organization" } }] };
    if (method === "PATCH" && (match = path.match(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/))) {
      const issue = this.issues.get(Number(match[1]))!;
      if (body.title) issue.title = body.title;
      if (body.body !== undefined) issue.body = body.body;
      return { status: 200, body: this.issueJson(issue) };
    }
    if (method === "PATCH" && (match = path.match(/^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/))) {
      const pr = this.issues.get(Number(match[1]))!;
      pr.title = body.title ?? pr.title;
      pr.body = body.body ?? pr.body;
      return { status: 200, body: { number: pr.number } };
    }
    if (method === "POST" && (match = path.match(/^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/reviews$/))) {
      const pr = this.issues.get(Number(match[1]));
      // Like GitHub: an app can't approve or block a PR it opened itself.
      if (pr?.user.login.endsWith("[bot]") && body.event !== "COMMENT") return { status: 422, body: { message: `Unprocessable Entity: "Can not ${body.event === "APPROVE" ? "approve" : "request changes on"} your own pull request"` } };
      this.reviews.push({ number: Number(match[1]), event: body.event, body: body.body });
      return { status: 200, body: { id: this.nextId++ } };
    }
    if (method === "POST" && path === "/graphql") {
      const query = String(body.query);
      const vars = body.variables ?? {};
      if (query.includes("addReaction")) this.reactions++;
      if (query.includes("query ResolveProject")) {
        if (vars.owner !== "acme" || vars.number !== 1) return { status: 200, body: { data: { organization: null } } };
        return { status: 200, body: { data: { organization: { projectV2: { id: this.project.id, title: this.project.title, url: `${this.url}/orgs/acme/projects/1`, field: { id: "F_status", name: vars.field, options: this.project.options } } } } } };
      }
      if (query.includes("query BoardItems")) {
        return { status: 200, body: { data: { node: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [...this.items.values()].map((item) => this.itemNode(item)) } } } } };
      }
      if (query.includes("query BoardItem")) {
        const item = this.items.get(vars.id);
        return { status: 200, body: { data: { node: item ? this.itemNode(item) : null } } };
      }
      if (query.includes("mutation MoveBoardItem")) {
        const item = this.items.get(vars.item)!;
        const option = this.project.options.find((candidate) => candidate.id === vars.option)!;
        item.status = option.name;
        item.history.push(option.name);
        return { status: 200, body: { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: item.id } } } } };
      }
      return { status: 200, body: { data: {} } };
    }
    return { status: 404, body: { message: `Fake GitHub has no route for ${method} ${path}` } };
  }
}
