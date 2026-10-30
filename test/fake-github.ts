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
  pull?: { head: string; base: string; merged?: boolean; mergeableState?: string };
  labels?: string[];
  state?: "open" | "closed";
  stateReason?: string | null;
  /** Sub-issue of this issue number. */
  parent?: number;
  /** Issue numbers this one is blocked by. */
  blockedBy?: number[];
}

/**
 * A tiny stand-in for the GitHub REST/GraphQL API, served under /api/v3 like GitHub Enterprise.
 * It implements just the endpoints the orchestrator calls and records every request.
 */
export class FakeGitHub {
  server: Server;
  port = 0;
  requests: { method: string; path: string; body: any; actor: string }[] = [];
  /** Personal access tokens: who each belongs to. Requests with one act as that user. */
  userTokens = new Map<string, { login: string; id: number; name?: string; push?: boolean; expires?: string }>();
  /** The next this many comment writes get GitHub's "secondary rate limit" answer (retry after 1 s). */
  secondaryLimit = 0;
  /** Who added each 👀 reaction. */
  reactionsBy: string[] = [];
  issues = new Map<number, FakeIssue>();
  permissions = new Map<string, string>();
  labels: string[] = [];
  /** How the OAuth sign-in endpoints behave, and who signs in. */
  oauth: "ok" | "drop" | "bad_code" = "ok";
  oauthUser = "alice";
  /** The App's Homepage and webhook URLs on GitHub (PUBLIC_URL when it was created; the tests' default). */
  appHomepage = "http://localhost:3000";
  appWebhookUrl = "http://localhost:3000/api/github/webhooks";
  /** Labels defined in the repository (acme/widgets). */
  repoLabels = new Set<string>(["type:refactor"]);
  assignees: string[] = [];
  reactions = 0;
  reviews: { number: number; event: string; body: string }[] = [];
  prOpened?: (number: number) => void;
  /** The commit a branch points at in the test's git remote (set by the harness). */
  branchSha: (branch: string) => string = () => "";
  /** Deletes a branch in the test's git remote (set by the harness). */
  deleteBranch: (branch: string) => void = () => undefined;
  /** Merges `head` into `base` in the test's git remote with a merge commit: the new commit, or null if there was nothing to merge. */
  mergeBranches: (base: string, head: string, message: string) => string | null = () => null;
  /** One organization project (acme/1) with a Status field; items map node id → card. */
  project = {
    id: "PVT_acme_1",
    title: "Product",
    options: ["Backlog", "Ready", "In progress", "In review", "Done", "Needs human"].map((name) => ({ id: `opt_${name.replace(/\s+/g, "_")}`, name })),
  };
  /** The project's other fields: two dates and a number, like a roadmap setup. */
  fields = [
    { id: "F_start", name: "Start date", dataType: "DATE" },
    { id: "F_end", name: "End date", dataType: "DATE" },
    { id: "F_estimate", name: "Estimate", dataType: "NUMBER" },
  ];
  items = new Map<string, { id: string; number: number; status: string | null; history: string[]; values: Record<string, string | number> }>();
  private nextId = 1000;

  addItem(number: number, status: string | null = null): string {
    const id = `PVTI_${number}`;
    this.items.set(id, { id, number, status, history: status ? [status] : [], values: {} });
    return id;
  }

  private itemNode(item: { id: string; number: number; status: string | null; values: Record<string, string | number> }) {
    const issue = this.issues.get(item.number);
    return {
      id: item.id,
      start: item.values.F_start ? { date: item.values.F_start } : null,
      end: item.values.F_end ? { date: item.values.F_end } : null,
      estimate: item.values.F_estimate !== undefined ? { number: item.values.F_estimate } : null,
      project: { id: this.project.id },
      fieldValueByName: item.status ? { name: item.status, optionId: `opt_${item.status}` } : null,
      content: { __typename: issue?.pull ? "PullRequest" : "Issue", number: item.number, title: issue?.title ?? "", repository: { name: "widgets", owner: { login: "acme" } } },
    };
  }

  constructor() {
    this.server = createServer((req, res) => {
      // Like a server whose network can't reach GitHub: the connection just ends.
      if (this.oauth === "drop" && (req.url ?? "").startsWith("/login/oauth/access_token")) {
        req.socket.destroy();
        return;
      }
      void this.handle(req).then(
        ({ status, body, headers }) => {
          res.writeHead(status, { "content-type": "application/json", ...headers });
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

  /** Like GitHub's database ids, which the sub-issue and dependency endpoints take. */
  static idOf(number: number): number {
    return 100_000 + number;
  }

  private byId(id: number): FakeIssue | undefined {
    return this.issues.get(id - 100_000);
  }

  private issueJson(issue: FakeIssue) {
    const children = [...this.issues.values()].filter((candidate) => candidate.parent === issue.number);
    const blockedBy = issue.blockedBy ?? [];
    const blocking = [...this.issues.values()].filter((candidate) => candidate.blockedBy?.includes(issue.number));
    return {
      id: FakeGitHub.idOf(issue.number),
      repository_url: `${this.url}/api/v3/repos/acme/widgets`,
      state_reason: issue.stateReason ?? null,
      sub_issues_summary: { total: children.length, completed: children.filter((child) => child.state === "closed").length, percent_completed: 0 },
      issue_dependencies_summary: { blocked_by: blockedBy.length, total_blocked_by: blockedBy.length, blocking: blocking.length, total_blocking: blocking.length },
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state ?? "open",
      node_id: `I_${issue.number}`,
      html_url: `${this.url}/acme/widgets/issues/${issue.number}`,
      user: issue.user,
      comments: issue.comments.length,
      pull_request: issue.pull ? { url: "x" } : undefined,
      labels: (issue.labels ?? []).map((name) => ({ name })),
    };
  }

  private async handle(req: IncomingMessage): Promise<{ status: number; body: unknown; headers?: Record<string, string> }> {
    const url = new URL(req.url ?? "/", this.url);
    const path = url.pathname.replace(/^\/api\/v3/, "").replace(/^\/api\/graphql$/, "/graphql");
    const body = await this.readBody(req);
    // Like GitHub: a personal access token acts as its user; anything else here is the App.
    const token = String(req.headers.authorization ?? "").replace(/^(token|bearer)\s+/i, "");
    const user = this.userTokens.get(token);
    const actor = user ? { login: user.login, type: "User" } : { login: "test-orchestrator[bot]", type: "Bot" };
    this.requests.push({ method: req.method ?? "GET", path: path + url.search, body, actor: actor.login });
    const method = req.method ?? "GET";
    let match: RegExpMatchArray | null;
    if (!user && /^(ghp_|github_pat_)/.test(token)) return { status: 401, body: { message: "Bad credentials" } };
    if (this.secondaryLimit > 0 && method !== "GET" && /\/comments/.test(path)) {
      this.secondaryLimit--;
      return { status: 403, body: { message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." }, headers: { "retry-after": "1" } };
    }

    if (method === "POST" && (match = path.match(/^\/app\/installations\/(\d+)\/access_tokens$/))) {
      return { status: 201, body: { token: "ghs_faketoken", expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: {}, repository_selection: "all" } };
    }
    if (method === "POST" && path === "/login/oauth/access_token") {
      if (this.oauth === "bad_code") return { status: 200, body: { error: "bad_verification_code", error_description: "The code passed is incorrect or expired." } };
      return { status: 200, body: { access_token: `gho_${body.code}`, token_type: "bearer" } };
    }
    if (method === "GET" && path === "/user") {
      if (user) {
        return {
          status: 200,
          body: { login: user.login, id: user.id, name: user.name ?? null, avatar_url: `${this.url}/avatars/${user.login}`, type: "User" },
          headers: { "x-oauth-scopes": "repo, project", ...(user.expires ? { "github-authentication-token-expiration": user.expires } : {}) },
        };
      }
      return { status: 200, body: { login: this.oauthUser, id: 1 } };
    }
    if (method === "GET" && path === "/app") {
      return { status: 200, body: { slug: "test-orchestrator", html_url: `${this.url}/apps/test-orchestrator`, external_url: this.appHomepage, owner: { login: "acme", type: "Organization" } } };
    }
    if (method === "GET" && path === "/app/hook/config") return { status: 200, body: { url: this.appWebhookUrl, content_type: "json" } };
    if (method === "PATCH" && path === "/app/hook/config") {
      this.appWebhookUrl = body.url;
      return { status: 200, body: { url: this.appWebhookUrl, content_type: "json" } };
    }
    if (method === "GET" && (match = path.match(/^\/users\/(.+)$/))) return { status: 200, body: { id: 4242, login: decodeURIComponent(match[1]!) } };
    if (method === "GET" && (match = path.match(/^\/repos\/[^/]+\/[^/]+\/collaborators\/([^/]+)\/permission$/))) {
      const permission = this.permissions.get(match[1]!) ?? "none";
      return { status: 200, body: { permission, role_name: permission, user: { login: match[1] } } };
    }
    if (method === "GET" && /^\/repos\/[^/]+\/[^/]+$/.test(path)) {
      if (user && !path.startsWith("/repos/acme/widgets")) return { status: 404, body: { message: "Not Found" } };
      return { status: 200, body: { default_branch: "main", full_name: "acme/widgets", permissions: { push: user ? user.push !== false : true, pull: true, admin: false, maintain: false } } };
    }
    if (method === "GET" && (match = path.match(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/))) {
      const issue = this.issues.get(Number(match[1]));
      return issue ? { status: 200, body: this.issueJson(issue) } : { status: 404, body: { message: "Not Found" } };
    }
    if (method === "GET" && (match = path.match(/^\/repos\/acme\/widgets\/labels\/(.+)$/))) {
      const name = decodeURIComponent(match[1]!);
      const found = [...this.repoLabels].find((label) => label.toLowerCase() === name.toLowerCase());
      return found ? { status: 200, body: { name: found, color: "ededed" } } : { status: 404, body: { message: "Not Found" } };
    }
    if (method === "POST" && path === "/repos/acme/widgets/labels") {
      if ([...this.repoLabels].some((label) => label.toLowerCase() === String(body.name).toLowerCase())) return { status: 422, body: { message: "Validation Failed", errors: [{ code: "already_exists" }] } };
      this.repoLabels.add(body.name);
      return { status: 201, body: { name: body.name, color: body.color } };
    }
    if (method === "POST" && path === "/repos/acme/widgets/issues") {
      const number = Math.max(0, ...this.issues.keys()) + 1;
      const issue = this.addIssue({ number, title: body.title, body: body.body ?? "", user: { login: actor.login }, labels: body.labels ?? [] });
      return { status: 201, body: this.issueJson(issue) };
    }
    if ((match = path.match(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/(parent|sub_issues?|dependencies\/blocked_by|dependencies\/blocking)(?:\/(\d+))?$/))) {
      const issue = this.issues.get(Number(match[1]));
      if (!issue) return { status: 404, body: { message: "Not Found" } };
      const what = match[2]!;
      if (method === "GET" && what === "parent") {
        const parent = issue.parent ? this.issues.get(issue.parent) : undefined;
        return parent ? { status: 200, body: this.issueJson(parent) } : { status: 404, body: { message: "Not Found" } };
      }
      if (method === "GET" && what === "sub_issues") return { status: 200, body: [...this.issues.values()].filter((child) => child.parent === issue.number).map((child) => this.issueJson(child)) };
      if (method === "POST" && what === "sub_issues") {
        const child = this.byId(body.sub_issue_id);
        if (!child) return { status: 404, body: { message: "Not Found" } };
        if (child.parent && child.parent !== issue.number && !body.replace_parent) return { status: 422, body: { message: "Validation Failed: the issue already has a parent" } };
        child.parent = issue.number;
        return { status: 201, body: this.issueJson(issue) };
      }
      if (method === "DELETE" && what === "sub_issue") {
        const child = this.byId(body.sub_issue_id);
        if (child?.parent === issue.number) delete child.parent;
        return { status: 200, body: this.issueJson(issue) };
      }
      if (method === "GET" && what === "dependencies/blocked_by") return { status: 200, body: (issue.blockedBy ?? []).map((number) => this.issueJson(this.issues.get(number)!)) };
      if (method === "GET" && what === "dependencies/blocking") return { status: 200, body: [...this.issues.values()].filter((other) => other.blockedBy?.includes(issue.number)).map((other) => this.issueJson(other)) };
      if (method === "POST" && what === "dependencies/blocked_by") {
        const blocker = this.byId(body.issue_id);
        if (!blocker) return { status: 404, body: { message: "Not Found" } };
        issue.blockedBy = [...new Set([...(issue.blockedBy ?? []), blocker.number])];
        return { status: 201, body: this.issueJson(issue) };
      }
      if (method === "DELETE" && what === "dependencies/blocked_by" && match[3]) {
        const blocker = this.byId(Number(match[3]));
        issue.blockedBy = (issue.blockedBy ?? []).filter((number) => number !== blocker?.number);
        return { status: 200, body: this.issueJson(issue) };
      }
    }
    if (method === "PUT" && (match = path.match(/^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/merge$/))) {
      const pr = this.issues.get(Number(match[1]));
      if (!pr?.pull || pr.state === "closed") return { status: 405, body: { message: "Pull Request is not mergeable" } };
      const sha = this.mergeBranches(pr.pull.base, pr.pull.head, body.commit_title ?? `Merge pull request #${pr.number}`);
      pr.pull.merged = true;
      pr.state = "closed";
      return { status: 200, body: { merged: true, sha: sha ?? this.branchSha(pr.pull.base), message: "Pull Request successfully merged" } };
    }
    if (method === "POST" && path === "/repos/acme/widgets/merges") {
      const sha = this.mergeBranches(body.base, body.head, body.commit_message ?? `Merge ${body.head} into ${body.base}`);
      return sha ? { status: 201, body: { sha } } : { status: 204, body: null };
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
        user: actor,
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
    if (method === "POST" && (match = path.match(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/labels$/))) {
      this.labels.push(...body.labels);
      const issue = this.issues.get(Number(match[1]));
      if (issue) issue.labels = [...(issue.labels ?? []), ...body.labels];
      return { status: 200, body: [] };
    }
    if (method === "GET" && path === "/repos/acme/widgets/pulls") {
      const head = url.searchParams.get("head")?.split(":")[1];
      const base = url.searchParams.get("base");
      const open = [...this.issues.values()].filter((issue) => issue.pull && (head ? issue.pull.head === head : true) && (base ? issue.pull.base === base : Boolean(head)) && issue.state !== "closed");
      return {
        status: 200,
        body: open.map((issue) => ({ number: issue.number, html_url: `${this.url}/acme/widgets/pull/${issue.number}`, head: { ref: issue.pull!.head, sha: this.branchSha(issue.pull!.head) }, base: { ref: issue.pull!.base } })),
      };
    }
    if (method === "DELETE" && (match = path.match(/^\/repos\/acme\/widgets\/git\/refs\/(.+)$/))) {
      // Octokit sends the ref encoded (heads%2Fname), which GitHub accepts.
      const branch = decodeURIComponent(match[1]!).replace(/^heads\//, "");
      if (!this.branchSha(branch)) return { status: 422, body: { message: "Reference does not exist" } };
      this.deleteBranch(branch);
      return { status: 204, body: null };
    }
    if (method === "POST" && path === "/repos/acme/widgets/pulls") {
      const number = Math.max(0, ...this.issues.keys()) + 1;
      this.issues.set(number, { number, title: body.title, body: body.body, user: { login: actor.login }, comments: [], pull: { head: body.head, base: body.base } });
      this.prOpened?.(number);
      return { status: 201, body: { number, html_url: `${this.url}/acme/widgets/pull/${number}` } };
    }
    if (method === "GET" && path === "/repos/acme/widgets/installation") return { status: 200, body: { id: 77 } };
    if (method === "GET" && path === "/app/installations") return { status: 200, body: [{ id: 77, account: { login: "ACME", type: "Organization" } }] };
    if (method === "PATCH" && (match = path.match(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/))) {
      const issue = this.issues.get(Number(match[1]))!;
      if (body.title) issue.title = body.title;
      if (body.body !== undefined) issue.body = body.body;
      if (body.state) issue.state = body.state;
      if (body.state_reason !== undefined) issue.stateReason = body.state_reason;
      return { status: 200, body: this.issueJson(issue) };
    }
    if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/comments$/.test(path)) return { status: 200, body: [] };
    if (method === "GET" && (match = path.match(/^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/))) {
      const pr = this.issues.get(Number(match[1]));
      if (!pr?.pull) return { status: 404, body: { message: "Not Found" } };
      const closed = pr.state === "closed";
      return {
        status: 200,
        body: { number: pr.number, state: closed ? "closed" : "open", merged: Boolean(pr.pull.merged), merged_at: pr.pull.merged ? new Date().toISOString() : null, closed_at: closed ? new Date().toISOString() : null, mergeable_state: pr.pull.mergeableState ?? "clean", head: { ref: pr.pull.head, sha: this.branchSha(pr.pull.head), repo: { full_name: "acme/widgets" } }, base: { ref: pr.pull.base } },
      };
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
      if (pr?.user.login === actor.login && body.event !== "COMMENT") return { status: 422, body: { message: `Unprocessable Entity: "Can not ${body.event === "APPROVE" ? "approve" : "request changes on"} your own pull request"` } };
      this.reviews.push({ number: Number(match[1]), event: body.event, body: body.body });
      return { status: 200, body: { id: this.nextId++ } };
    }
    if (method === "POST" && path === "/graphql") {
      const query = String(body.query);
      const vars = body.variables ?? {};
      if (query.includes("addReaction")) {
        this.reactions++;
        this.reactionsBy.push(actor.login);
      }
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
      if (query.includes("query BoardFields")) {
        return { status: 200, body: { data: { node: { fields: { nodes: [{ id: "F_status", name: "Status", dataType: "SINGLE_SELECT" }, ...this.fields] } } } } };
      }
      if (query.includes("mutation SetBoardField")) {
        this.items.get(vars.item)!.values[vars.field] = vars.value;
        return { status: 200, body: { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: vars.item } } } } };
      }
      if (query.includes("mutation ClearBoardField")) {
        delete this.items.get(vars.item)!.values[vars.field];
        return { status: 200, body: { data: { clearProjectV2ItemFieldValue: { projectV2Item: { id: vars.item } } } } };
      }
      if (query.includes("mutation AddBoardItem")) {
        const number = Number(String(vars.content).replace(/^I_/, ""));
        const existing = [...this.items.values()].find((item) => item.number === number);
        const id = existing?.id ?? this.addItem(number);
        return { status: 200, body: { data: { addProjectV2ItemById: { item: { id } } } } };
      }
      if (query.includes("mutation ArchiveBoardItem")) {
        this.items.delete(vars.item);
        return { status: 200, body: { data: { archiveProjectV2Item: { item: { id: vars.item } } } } };
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
