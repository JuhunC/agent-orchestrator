# Agent Orchestrator

Run AI coding agents from GitHub. Mention an agent on an issue, pull request, review or discussion (or assign it) and the orchestrator:

1. reacts 👀, assigns the agent's handle and labels the thread `agent:<name>`,
2. checks out the repo on a branch (`agent/<name>/issue-12`, or the PR's own branch),
3. runs the agent's CLI (`claude -p`, `agent -p`, `codex exec`, `gemini -p`, or your own command like `myClaude -p`) with the thread, the conversation and **everything that agent did on this thread before**,
4. keeps one progress comment up to date while it works,
5. commits, pushes and opens (or updates) a pull request, and replies with the agent's summary.

An admin UI shows every agent working live, and lets you stop, retry and start agents, turn them on and off, edit them, and clear what they remember.

```
GitHub ──webhook──▶ orchestrator ──spawn──▶ claude -p / agent -p / codex / gemini / myClaude -p
   ▲                    │  SQLite: tasks, events, history            │
   └── comments, PRs ◀──┴──────────── git push ◀── workspace ◀───────┘
```

## Quick start

```bash
docker run -d --name orchestrator -p 3000:3000 -v orchestrator-data:/data \
  -e PUBLIC_URL=https://orchestrator.example.com \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  ghcr.io/juhunc/agent-orchestrator:latest
```

1. Get the admin token: `docker logs orchestrator | grep adminToken` (or set `ADMIN_TOKEN` yourself).
2. Open `PUBLIC_URL`, sign in with the token, go to **Settings → Create GitHub App**. GitHub shows you the app it's about to create; confirm, and the credentials are saved in the data volume.
3. Click **Install on repositories** and pick the repos.
4. On any issue in those repos: `@aorch-claude please add input validation to the signup form`.

GitHub must be able to reach `PUBLIC_URL/api/github/webhooks`. To try it on a laptop, create a channel at <https://smee.io> and set `WEBHOOK_PROXY_URL` to it.

## Talking to agents on GitHub

| Where | How | What the agent works on |
| --- | --- | --- |
| New issue | mention the handle in the title or body, or assign it | a new branch, then a PR that `Closes #n` |
| Issue comment | mention the handle | same branch and PR as before, if there is one |
| Pull request, review, inline review comment | mention the handle, assign it, or request its review | the PR's own branch (forks: replies only) |
| Discussion or discussion comment | mention the handle | a new branch and PR, if it changes anything |

- Only people with **write** access (configurable with `TRIGGER_MIN_PERMISSION`) can start agents. Others are rejected, and so are bots, so agents can't trigger each other in a loop.
- **Handles** are GitHub logins. Use ones nobody owns (the defaults `aorch-*` are free) so mentions don't ping strangers. If you want agents to show up as real assignees, create machine accounts with those logins and add them as collaborators.
- One agent works on one thread at a time. Mention it again while it's busy and the request is queued.

### History and context

Every run is stored: the request, the agent's reply, branch, commits, PR, and the agent's session id. When an agent is mentioned on a thread again, its earlier runs on that thread **and on linked threads** (the PR it opened for an issue, and the other way round) go into the prompt. Agents with `resume_args` also continue their previous CLI session. In the admin UI, **History** shows all of this per thread and can make an agent forget a thread or reset its checkout.

## Agents

Agents are defined in [`config/agents.yaml`](config/agents.yaml) (reloaded on start) or in the admin UI. The image ships with Claude Code, Cursor CLI, OpenAI Codex and Gemini CLI configured.

```yaml
agents:
  - name: my-claude              # used in branch names and labels
    handle: aorch-my-claude      # what people @-mention
    command: myClaude
    args: [-p, "{prompt}"]       # or leave {prompt} out to get the prompt on stdin
    output: text                 # stdout is the reply; `::progress:: …` lines become progress steps
    env:
      ANTHROPIC_API_KEY: ${MY_CLAUDE_API_KEY}
```

| Field | |
| --- | --- |
| `command`, `args` | Placeholders: `{prompt}` `{prompt_file}` `{session_id}` `{workdir}` `{branch}` `{repo}` `{task_id}` |
| `resume_args` | Used instead of `args` when the agent already has a session on this thread |
| `output` | `claude-stream-json` (Claude Code, Cursor CLI), `codex-json`, `gemini-stream-json`, `text` |
| `env` | Extra variables; `${NAME}` is read from the orchestrator's environment |
| `timeout_minutes` | Default `TASK_TIMEOUT_MINUTES` (60) |
| `open_pull_request` | `false` makes a read-only agent that only replies |
| `expose_github_token` | Give the agent `GH_TOKEN` for the repo (default off) |

Agents also get `AO_TASK_ID`, `AO_REPO`, `AO_THREAD_KIND`, `AO_THREAD_NUMBER`, `AO_THREAD_URL`, `AO_BRANCH`, `AO_REQUESTED_BY` and `AO_PROMPT_FILE`. They **don't** get the GitHub App key, webhook secret or admin token; only the variables listed in `config.ts` (API keys for the bundled CLIs) plus `AGENT_ENV_PASSTHROUGH` and the agent's own `env`.

**Custom binaries:** put them in `agents-bin/` next to `docker-compose.yml` on the server (mounted at `/opt/agents/bin`, on `PATH`), or build your own image `FROM ghcr.io/juhunc/agent-orchestrator`.

## Configuration

All settings are environment variables; see [`.env.example`](.env.example).

| Variable | Default | |
| --- | --- | --- |
| `GITHUB_URL` | `https://github.com` | Target GitHub. Set it to your GitHub Enterprise Server URL to use GHES. |
| `GITHUB_API_URL` | derived | `https://api.github.com`, or `$GITHUB_URL/api/v3` for GHES |
| `PUBLIC_URL` | `http://localhost:3000` | Where GitHub and admins reach the orchestrator |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | | Use an existing GitHub App instead of creating one in the UI |
| `ADMIN_USERS` | | GitHub logins allowed to sign in with GitHub. The account that created the app in the UI is allowed too. |
| `ADMIN_TOKEN` | generated | Token sign-in for the admin UI and API (`Authorization: Bearer …`) |
| `MAX_CONCURRENT_TASKS` | `2` | Also adjustable in the UI |
| `TRIGGER_MIN_PERMISSION` | `write` | `read`, `triage`, `write`, `maintain` or `admin` |
| `ALLOWED_REPOS` | any | `owner/repo` or `owner/*`, comma separated |
| `HISTORY_LIMIT` | `10` | Earlier runs given to an agent as context |
| `PROGRESS_UPDATE_SECONDS` | `20` | How often the progress comment is edited |
| `AGENT_LABEL_PREFIX` | `agent:` | `none` disables labels |
| `WEBHOOK_PROXY_URL` | | smee.io channel for local development |
| `DATA_DIR` | `/data` | SQLite database, workspaces, agent sessions, app credentials |

## Deploying

`.github/workflows/deploy.yml` runs the tests, publishes a multi-arch image to `ghcr.io/juhunc/agent-orchestrator` (`latest`, `sha-<commit>`, and `vX.Y.Z` for tags), then deploys it to your server over SSH.

On the server (any Linux box with Docker and the compose plugin):

```bash
mkdir -p ~/agent-orchestrator && cd ~/agent-orchestrator
curl -fsSLO https://raw.githubusercontent.com/JuhunC/agent-orchestrator/main/.env.example
cp .env.example .env && nano .env      # PUBLIC_URL, API keys, ADMIN_USERS, DOMAIN for HTTPS
```

In the GitHub repo, under **Settings → Secrets and variables → Actions**:

| Name | Kind | |
| --- | --- | --- |
| `DEPLOY_HOST` | secret or variable | server hostname or IP |
| `DEPLOY_USER` | secret or variable | SSH user that can run `docker` (default `deploy`) |
| `DEPLOY_SSH_KEY` | secret | private key for that user |
| `DEPLOY_KNOWN_HOSTS` | secret or variable | output of `ssh-keyscan your-host` (recommended) |
| `DEPLOY_PORT`, `DEPLOY_PATH` | variable | default `22` and `agent-orchestrator` |

Every push to `main` then copies `deploy/docker-compose.yml`, pins the new image, restarts the container and waits for its health check. Data lives in the `data` volume and survives deploys. With `DOMAIN` set in `.env`, a Caddy container serves it over HTTPS with an automatic certificate (set `BIND_ADDRESS=127.0.0.1` so port 3000 isn't public).

## Security

- Agents run with their CLI's permission prompts turned off (`--dangerously-skip-permissions`, `--yolo`, …). The container is the sandbox: run it on a machine where that's acceptable, and give agents API keys with sensible spend limits.
- Only people with write access can start an agent, but the prompt includes the whole thread, and on public repos anyone can comment. Treat thread content as untrusted input (prompt injection) and use `ALLOWED_REPOS` to keep agents off repos you don't control.
- Agents never get the GitHub App's key. Git operations use short-lived installation tokens passed per command, so tokens aren't written to `.git/config`. Pushes go to `agent/<name>/…` branches or the PR's branch, never the default branch.
- Agents only see a GitHub token when `expose_github_token: true`.

## Development

```bash
npm install
npm test            # unit tests + end-to-end run against a fake GitHub API
npm run typecheck
npm run build       # admin UI → web/dist
npm run dev         # server on :3000 (AUTH_DISABLED=true to skip sign-in)
npm run dev:web     # UI with hot reload on :5173, proxying /api to :3000
```

The server is TypeScript run directly by Node 24 (no build step). The UI is React + Vite.
