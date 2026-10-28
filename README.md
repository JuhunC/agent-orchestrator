# Agent Orchestrator

AI agents that take GitHub issues and pull requests from request to merged-ready PR. Mention an agent on an issue (`@aorch-coder please add rate limiting`) and the orchestrator starts a [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) session for it. The agent:

1. works in a checkout of the repo on its own branch,
2. uses the skills, MCP servers and subagents in its profile,
3. reports progress in one live comment,
4. commits, pushes and opens the PR with the orchestrator's GitHub tools,
5. replies with a summary, and remembers the thread next time.

An admin UI shows every agent working live, lets you stop or start them, and edits their profiles.

```
GitHub ──webhook──▶ orchestrator ──▶ Claude Agent SDK session ──▶ your model API
   ▲                 │  profiles: role, skills, MCP, subagents            (ANTHROPIC_BASE_URL)
   └─ push, PR, comments ◀── GitHub tools (token stays in the orchestrator)
```

## Quick start

```bash
cp .env.example .env     # set PUBLIC_URL and your model service (ANTHROPIC_*)
mkdir -p profiles
docker compose up -d
docker compose logs orchestrator | grep adminToken
```

Open `PUBLIC_URL`, sign in with the token, then **Settings → Create GitHub App**, confirm on GitHub, and **Install on repositories**. Mention `@aorch-coder` on an issue in one of them.

GitHub must reach `PUBLIC_URL/api/github/webhooks`. On a laptop, set `WEBHOOK_PROXY_URL` to a channel from <https://smee.io>.

Set `PUBLIC_URL` to the address you'll use (on a server without a domain, e.g. `http://203.0.113.7:3000`) **before** creating the App: the App's Callback URL (for **Sign in with GitHub**), webhook URL and Homepage URL are made from it. If you change `PUBLIC_URL` later, GitHub sign-in fails with "The redirect_uri is not associated with this application". Settings and the sign-in page then show the URLs to set: on GitHub, open the App's settings (Settings → Developer settings → GitHub Apps, or the organization's) and set the **Callback URL** to `PUBLIC_URL/api/auth/github/callback` and the **Homepage URL** to `PUBLIC_URL`. The webhook URL can be updated from Settings with one click. Until then, sign in with the admin token.

### The model service

Agents run Claude Code through the Agent SDK, so they use whatever the `ANTHROPIC_*` variables point at:

| You have | Set |
| --- | --- |
| An Anthropic API key | `ANTHROPIC_API_KEY` |
| An Anthropic-compatible service (gateway, proxy, other provider) | `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_MODEL` if it needs specific model names |
| A Claude subscription | `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` |
| Bedrock / Vertex / Foundry | `CLAUDE_CODE_USE_BEDROCK=1` etc. and the cloud's credentials |

To run your own build of Claude Code instead of the one bundled with the SDK, set `CLAUDE_CODE_EXECUTABLE` to its path (or a command on `PATH`). The SDK starts it with the same flags it gives Claude Code (`--output-format stream-json --input-format stream-json`, `--resume`, `--mcp-config` and so on), so it must accept them and speak the same protocol on stdin/stdout. Paths ending in `.js`/`.mjs` run with Node; anything else (a binary, a script with a `#!` line) runs directly. In Docker, mount it into the container or add it to an image built on this one.

When the service reports a usage limit, tasks pause and continue automatically when it resets (Settings shows the limit and can clear it). When it fails to answer (server errors, overloads, dropped connections), requests are retried, and a task that still fails is retried with the same session (`MODEL_ERROR_RETRIES`, default 3). Client errors such as a bad key or invalid request aren't retried.

## Agent profiles

Profiles are files, in `profiles/` (a git repository: every edit from the admin UI is a commit). Next to every file editor in the admin UI, **Options** lists what that kind of file can contain: each setting with its type, allowed values, default, an example to copy, and the skills, agents and roles that exist right now.

```
profiles/
  agents/
    coder/
      agent.md          # settings + role prompt
      skills/<name>/    # skills only this agent has (SKILL.md + files)
      mcp.json          # MCP servers only this agent has
  library/
    skills/<name>/      # shared skills
    roles/<name>.md     # shared subagents
    mcp.json            # shared MCP servers
```

`agents/coder/agent.md`:

```markdown
---
handle: aorch-coder            # the GitHub login people mention (pick one nobody owns)
description: Implements issues end to end
model: sonnet                  # optional; defaults to ANTHROPIC_MODEL (also set in the UI)
effort: high                   # low | medium | high | xhigh | max (also set in the UI)
skills: [shipping-changes]     # from library/skills
mcp: [linear]                  # from library/mcp.json
subagents: [test-writer]       # from library/roles
tools:
  deny: [WebSearch]            # or allow: [...] to offer only some built-in tools
github:
  push: true                   # commit_and_push
  pull_request: true           # open_pull_request
  comment: true                # post_comment
  clone: true                  # clone_repository (read-only extra repos)
  update_issue: true           # update_issue (title, description, labels)
  review: true                 # submit_review
  finalize: true               # push and open the PR if the agent forgot
  wiki: write                  # wiki pages: write, read or none (true/false work too)
  sub_issues: none             # none | read (list_sub_issues) | write (also create_sub_issue, move_sub_issue)
  relations: false             # link_issue: blocked-by, blocking, parent and sub-issue links
  merge_into_parent: false     # merge_into_parent: merge a sub-issue into its parent's branch
  parent_branch: true          # a sub-issue branches from and merges into its parent's branch
max_turns: 300
max_budget_usd: 20
timeout_minutes: 90
live: true                     # keep the session open between tasks on a thread
replicas: 3                    # optional: identical copies; works up to 3 cards at once
env:
  SOME_TOOL_TOKEN: ${SOME_TOOL_TOKEN}
---
You are a careful senior engineer on this repository. …
```

- **Role**: the text under the frontmatter is added to Claude Code's system prompt. The repository's own `CLAUDE.md` and `.claude/` settings load too.
- **Skills** are standard `SKILL.md` folders. For each run the agent's skills are packaged as a plugin outside the repo, so they're never committed.
- **MCP servers** use Claude Code's `.mcp.json` format (`command`/`args`/`env`, or `url`/`headers`). `${NAME}` is filled from the server's environment, so secrets stay out of the files. Add `"alwaysLoad": true` to always show a server's tools instead of behind tool search.
- **Subagents** (`library/roles/<name>.md`) have a `description` (when to use them), optional `tools`, `model`, `skills` and `mcp`, and their prompt.
- **Duplicate** an agent from the admin UI: one copy under a new name and handle to customise, or several identical copies (`coder-2`, `coder-3`, … with handles to match), optionally added to a group. For identical workers without separate folders, set `replicas: N`.

### Groups

`profiles/groups/<name>.yaml` (or **Groups** in the admin UI) bundles agents:

```yaml
description: Developers
members: [coder, coder-2, coder-3]
defaults:                      # members inherit these; an agent's own settings win
  model: sonnet
  effort: high
  skills: [shipping-changes]
  mcp: [linear]
  subagents: [test-writer]
```

Use a whole group in a board column (`agents: [group:developers]`), and change every member at once from its page: model, effort, or on/off.

### GitHub tools

Every agent gets a `github` MCP server that runs inside the orchestrator. The installation token never reaches the agent or the model:

| Tool | |
| --- | --- |
| `get_thread` | the issue/PR/discussion and its latest comments |
| `post_comment` | ask a question or share something mid-task |
| `commit_and_push` | commit and push the task's branch (rebases once if the branch moved) |
| `open_pull_request` | open or update the PR (`Closes #n` added) |
| `get_ci_status` | check runs and statuses for the pushed commit |
| `fetch_from_github` | `git fetch` with the orchestrator's credentials (the agent's shell has none), to pick up commits pushed mid-task |
| `clone_repository` | read-only clone of another repo into `.deps/` |
| `update_issue` | edit the issue's title, description and labels (labels the repo doesn't have are created), and close or reopen it (`state`, `state_reason`; applied when the task finishes) |
| `submit_review` | approve, comment on or request changes to the PR (never merges) |
| `move_to_column` | board tasks: move the card on, with a handoff note for the next stage |
| `list_wiki_pages`, `read_wiki_page` | the GitHub wiki of this repo, or of another repo the App can access |
| `write_wiki_page`, `delete_wiki_page` | create, replace or delete a page in this repo's wiki, committed as the App |
| `list_sub_issues` | `sub_issues: read`: the issue's sub-issues, and whether each one's branch head is an ancestor of (merged into) this issue's branch |
| `create_sub_issue` | `sub_issues: write`: create an issue as a sub-issue of this one, with labels (created if missing) and `blocked_by` relations |
| `move_sub_issue` | `sub_issues: write`, board tasks: move a sub-issue's card, where the board allows |
| `set_card_fields` | `update_issue: true`, on a board with `fields`: set the card's (or a sub-issue's) start date, end date and estimate in the project |
| `link_issue` | `relations: true`: add or remove `blocked_by`, `blocks`, `parent` or `sub_issue` links to another issue |
| `merge_into_parent` | `merge_into_parent: true`: merge this sub-issue's pushed work into the parent's branch with a merge commit, and close the sub-issue |

**Wikis** have no REST API: each is a git repository (`<repo>.wiki.git`), so the orchestrator keeps a checkout under `DATA_DIR/wikis` and pushes page changes with the installation token (the App's `contents: write` permission covers it). GitHub creates a wiki's repository only when its first page is saved, so turn on Wikis in the repository settings and create the first page in the web UI once. If someone edits the wiki at the same moment, the write is redone on top of their version.

Each agent works in a full clone of the repository, refreshed from GitHub when a task starts, so git commands in its shell (log, diff, blame, merge) never need GitHub access. The shell has no GitHub credentials; `fetch_from_github` fetches for it. Workspaces made by older versions as blob-less clones are converted the next time they're used.

Agents push only to `agent/<name>/issue-<n>` or `ao/issue-<n>` branches, or to the PR's own branch when called on a PR. They never push to or merge into the default branch.

### Sub-issues

GitHub sub-issues split an issue into parts. The orchestrator gives each issue in such a tree the shared branch `ao/issue-<n>`:

- A sub-issue's branch starts from its **parent's branch**, and its pull request targets that branch instead of the default branch. If the parent's branch doesn't exist yet, it's created where the sub-issue's branch left the default branch. The parent's own pull request then takes all of it to the default branch, through a person. Set `parent_branch: false` on an agent to have it treat sub-issues like any other issue. Only open parents in the same repository count.
- `list_sub_issues` checks each sub-issue's branch: its head must be an **ancestor** of the parent's branch on GitHub. A squash or rebase merge copies commits, so that work shows as not merged; `merge_into_parent` always uses a merge commit.
- The agent's prompt lists the issue's parent, sub-issues and dependencies, and says where its work merges.

## Project boards

Connect a GitHub Project so agents work it like a team: when a card lands in a column, that column's agent picks it up, does its stage, and moves the card on. A board is a file, `profiles/boards/<name>.yaml` (edit it in the admin UI under **Boards**); see [`profiles/boards/product.yaml.example`](profiles/boards/product.yaml.example).

```yaml
project: your-org/3            # org/project-number
status_field: Status
needs_human: Needs human
limits: { moves_per_issue: 10, entries_per_column: 3, budget_usd_per_issue: 30 }
columns:
  Backlog:     { agent: analyst, role: requirements, effort: medium, moves_to: [Ready] }
  Ready:       { agent: coder, role: implement, on_start: In progress, effort: high, moves_to: [In review] }
  In progress: { agent: coder, role: address-feedback, moves_to: [In review] }
  In review:   { agent: tester, role: verify, moves_to: [Done, In progress] }
  Done: {}
```

- Each column maps a **harness** (`agents`: profiles with their tools, skills and MCP servers, or `group:<name>`) and a **role** (a `library/roles` name, or inline text). `model` and `effort` override the agents' for that column. `moves_to: any` allows every column.
- With several agents, `mode` decides who gets a card: **pool** (default) gives it to the least busy agent; **all** has every agent work it at once and moves the card when they've all finished (needs-human wins, then sending it back, then the most common choice); **label** routes by the issue's labels (`routes: { frontend: web-dev, default: group:developers }`).
- Agents finish with `move_to_column`; the move happens after the agent is done, and its **handoff note** goes to the next stage's agent along with all earlier notes.
- All stages share one branch and PR per issue (`ao/issue-<n>`), so the tester tests the developer's work. The example tester only reports and sends cards back; agents never merge into the default branch.
- **Move requirements** (optional): a column can say what an agent must show before it moves a card *into* that column. `move_to_column` refuses a move that lacks them and tells the agent what to fix, so it can fix it in the same session. The evidence is checked again just before the card moves, so changing files after the move keeps the card where it is.
  - `evidence`: `pull_request` (an open PR has the agent's latest commit), `pushed` (it pushed commits in this task), `tests` (a test command it ran passed, and no files changed since), `review` (it submitted a verdict with `submit_review` on the current commit), `approval` (that verdict was APPROVE), `merged` (the card's branch is merged into the branch it targets: for a sub-issue, its parent's branch), `merged_into_parent` (the same, but checked only for sub-issues: other cards pass, and so does a sub-issue with no commits of its own, like docs-only work), `sub_issues` (every sub-issue's branch is merged into this card's branch, or the sub-issue is closed), `dependencies` (every issue the card is blocked by, as GitHub blocked-by relations, is closed). For `tests`, the orchestrator watches the agent's shell commands: common runners (`npm test`, `pytest`, `go test`, `cargo test`, `make test`, …) count, or set `test_command` to the command(s) that do.
  - `handoff_required`: fields the agent must fill in `move_to_column`'s `fields`: `status`, `decisions`, `verified`, `open_questions`, `risks`, `do_not_redo`. They're added to the handoff note.
  - `work_types` (top level) keeps a kind of card, matched by issue label, out of some columns: `work_types: { docs: { labels: [documentation], forbid: [In review] } }`.
  - These rules apply only to agents' `move_to_column`. People can move cards anywhere, and an agent can always move a card to `needs_human`. Boards without these settings work as before. Mistakes in them (an unknown evidence name, a column that doesn't exist) are reported when the board loads and refused when the file is saved.

```yaml
columns:
  In review: { agent: tester, role: verify, moves_to: [Done, In progress], evidence: [pull_request], handoff_required: [status] }
  Done: { evidence: [approval, tests], test_command: npm test, handoff_required: [verified, risks] }
```
- **Move map**: the board page draws the columns and the moves agents can make between them (`moves_to` forward and back, `on_start`), with what each column requires.
- **Sub-issues** (optional, top level): `sub_issues: { column: Backlog, moves_to: [Ready] }`. Sub-issues an agent creates on the board are added to it in `column` when its task finishes, which starts that column's agent; one that doesn't meet that column's requirements (e.g. `dependencies` while it's blocked) stays off the board until the parent moves it. Put `dependencies` on columns like Ready to make blocked-by relations a hard gate; without it, `move_sub_issue` still points out open blockers. An agent working a parent card may move its sub-issues' cards to the `moves_to` columns with `move_sub_issue` (or to `needs_human`); like its own move, that happens when it finishes and is checked again first. Such a move counts toward the sub-issue's loop guards. Only evidence about the sub-issue itself (`pull_request`, `merged`, `sub_issues`) can be checked for it, so a column that needs another agent's tests or review can't be entered this way.
- **Dates and estimates** (optional, top level): `fields: { start: Start date, end: End date, estimate: Estimate, start_on: [In progress], end_on: [Done] }` names the project's date fields and number field. GitHub issues have no dates of their own; in a Project they live in fields like these, which the roadmap view uses. Agents set them with `set_card_fields` (and `create_sub_issue` takes them for new sub-issues), and their prompt shows the card's current values. `start_on` fills in the start date (today, UTC) when a card enters one of those columns and has none yet; `end_on` sets the end date when it enters one. That happens for people's moves too. The board page shows the values per card.
- **Loop guards**: too many agent moves, too many visits to one column, or too much spend on a card sends it to `needs_human` with a comment. Moving a card away from a column stops the agent working on it.
- GitHub sends project webhooks only for **organization** projects, and the app needs the organization **Projects** permission (read and write). Boards are also polled every `poll_seconds` in case a webhook is missed. The first poll only records where cards are; it doesn't start agents for cards already on the board.
- The App must be **installed on the account that owns the project** (which may differ from the repositories' owner). The board page says where it's installed if not. For a project the App can't reach, such as a user-owned project, set `token_env: SOME_VAR` in the board file and put a token with project read/write access in that environment variable. Agents still use the App for everything else.

## On GitHub

| Where | How | What happens |
| --- | --- | --- |
| New issue | mention the handle, or assign it | branch `agent/<name>/issue-<n>`, then a PR |
| Issue comment | mention the handle | continues on the same branch and PR |
| PR, review, inline comment | mention, assign or request review | works on the PR's branch (forks: replies only) |
| Discussion | mention the handle | branch and PR if it changes anything |

Only people with write access (`TRIGGER_MIN_PERMISSION`) can start agents; bots are ignored, so agents can't trigger each other in a loop.

**While an agent works**, what people do on its issue or PR reaches it mid-task: comments (and edits), reviews and inline comments, labels, assignees, title or description edits, pushes, closing, reopening or merging. That includes the PR it opened for an issue. The agent gets it after its current step, or just before it would finish, so it keeps going and deals with it. Mentioning an agent that's already working on the thread tells it there instead of queueing another run; if it finished before seeing the mention, a follow-up run is queued. Activity from people below `TRIGGER_MIN_PERMISSION` is marked as information, not instructions. Bots are never forwarded. The task's log shows each item, and **Deliveries** marks these webhooks *forwarded*.

**Memory**: every run (request, reply, branch, PR, session) is stored per thread. A live agent keeps its Claude session open between tasks on the same thread (`LIVE_SESSION_IDLE_MINUTES`); a closed session is resumed by id next time, and a fresh one gets the thread's history in its prompt. **History** in the admin UI shows it all and can make an agent forget a thread.

## Configuration

See [`.env.example`](.env.example) for everything. The main ones:

| Variable | Default | |
| --- | --- | --- |
| `PUBLIC_URL` | `http://localhost:3000` | Where GitHub and admins reach the orchestrator |
| `GITHUB_URL` | `https://github.com` | Your GitHub Enterprise Server URL to use GHES |
| `ANTHROPIC_*` | | The model service (see above) |
| `ADMIN_USERS` / `ADMIN_TOKEN` | | Who can sign in to the admin UI |
| `PROFILES_DIR` | `/profiles` | Agent profiles |
| `MAX_CONCURRENT_TASKS` | `2` | Agents working at once |
| `MODEL_ERROR_RETRIES` | `3` | When the model API fails to answer (5xx, overloaded, dropped connection): each request is retried this many times, then a task that still fails is retried this many times, continuing its session |
| `MODEL_ERROR_RETRY_DELAY_SECONDS` | `20` | First wait before a task retry; doubles each time |
| `CLAUDE_CODE_EXECUTABLE` | bundled | A Claude Code-compatible executable agents run instead of the SDK's own (see [The model service](#the-model-service)) |
| `MAX_PULL_REQUESTS_PER_ISSUE` | `0` (no limit) | Most pull requests agents may open for one issue, counting closed ones. Past it, agents still push their branch and can update their open PR, but no new PR is opened |
| `ALLOWED_REPOS` | any | `owner/repo` or `owner/*` |
| `AGENT_ENV_PASSTHROUGH` | | Extra variables agents (and their MCP servers) may see |

Agents see only the model settings, `AGENT_ENV_PASSTHROUGH` and their profile's `env`. The GitHub App key, webhook secret and admin token never reach them.

## Deploying

`.github/workflows/deploy.yml` tests, publishes `ghcr.io/juhunc/agent-orchestrator` (amd64 + arm64), and deploys over SSH when `DEPLOY_HOST` and `DEPLOY_SSH_KEY` are set:

1. On the server: `mkdir ~/agent-orchestrator`, put a filled-in `.env` there.
2. In the repo's Actions secrets/variables: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, and preferably `DEPLOY_KNOWN_HOSTS` (`ssh-keyscan your-host`).
3. Push to `main`. With `DOMAIN` in `.env`, Caddy serves it over HTTPS (`BIND_ADDRESS=127.0.0.1`).

The image includes git, Python and common CLI tools. For project toolchains, build on it: `FROM ghcr.io/juhunc/agent-orchestrator` and install what your repos need.

## Security

- Agents run with permission prompts off (`bypassPermissions`); the container is the sandbox. Use a machine where that's acceptable.
- Thread content is untrusted input: only write-access users can start agents, but anyone can comment on public repos. Use `ALLOWED_REPOS`.
- GitHub credentials stay in the orchestrator; agents act on GitHub only through its tools, on agent branches. The only merge an agent can make is `merge_into_parent` (off by default), which merges a sub-issue into its parent issue's `ao/issue-<n>` branch, never into the default branch.

## Development

```bash
npm install
npm test            # unit tests + end-to-end runs of the real Agent SDK against a fake GitHub and a fake model API
npm run typecheck
npm run build       # admin UI → web/dist
npm run dev         # server on :3000
npm run dev:web     # UI with hot reload on :5173 (the build also emits a polyfilled bundle for older browsers: Chrome 61+, Firefox 60+, Safari 11+, Edge 79+)
```
