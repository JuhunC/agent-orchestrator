---
name: codebase-map
description: Where agent-orchestrator's code lives, and the checklist of files to update when adding a feature, setting, table or agent tool. Use before exploring the source for a change.
---
# Where things are (src/)
- `triggers.ts`: webhooks → intents (mentions, assignment, account aliases), sender permission, own-echo filter, redelivery dedupe, `accept()` creates tasks.
- `runner/run-task.ts`: one task end to end (workspace, prompts, session run, model retries, fallback model, usage limits, end of task: card moves, sub-issues, issue state, related starts, result comment). `scheduler.ts`: the queue (`queue-order.ts` priority, replicas, board `max_running`, spend and usage limits). `inbox.ts`: GitHub activity reaching running agents. `progress.ts`: progress/result comments. `spend.ts`, `incidents.ts` (alerts, `/metrics`), `outcomes.ts`, `usage-report.ts`, `limits.ts`/`limit-store.ts`.
- `runtime/`: `mirrors.ts` (one shared bare copy per repository; checkouts borrow its objects), `github-tools.ts` (the agent's `github` MCP tools; write tools dry-run guarded), `session.ts` + `manager.ts` (Claude Code sessions: live, resume, model-proxy grants), `options.ts` (SDK options, agent env, fallback models), `workspace.ts` (checkouts), `isolation.ts` (agent OS user), `model-proxy.ts`, `related-agents.ts`, `sub-issues.ts`, `evidence.ts` (board move checks), `cleanup.ts`, `backup.ts`, `usage.ts`.
- `github/`: `app.ts` (App, installation tokens, bot identity), `accounts.ts` (agents' GitHub accounts, own-write record), `threads.ts` (fetch thread, comments, `signed()` marker), `relations.ts`, `projects.ts`, `labels.ts`, `wiki.ts`.
- `boards/`: `loader.ts`, `rules.ts` (board file parsing), `engine.ts` (card moves, column agents, loop guards).
- `schedules/`: `when.ts` (cron/@daily/"every 6h" parsing, next run in a time zone, describe), `runner.ts` (add/change/remove, due runs every 30 s, agent.md sync, tracking issue, skip/pause/finish rules, prompt info), `tools.ts` (the agent's create/list/update/delete_schedule). Routes in `server/schedules-api.ts`; UI `web/src/components/Schedules.tsx`. Tasks carry `scheduleId`, trigger `schedule`.
- `profiles/`: `loader.ts` (agent.md, `GITHUB_DEFAULTS`), `reference.ts` (options reference), `types.ts`, `store.ts`, `version.ts` (profile fingerprint per task).
- `server/`: `api.ts` (every /api route), `auth.ts`, `roles.ts` (viewer/operator, audit log), `http.ts`, `secrets.ts` (`seal`/`unseal`).
- `db.ts`: schema (`CREATE … IF NOT EXISTS`, `addColumn` migrations) and all queries. `config.ts`: every env var.
- `web/src`: `api.ts` (shared types), `pages/`, `components/`.

# Adding something: also update
- **Env var** (`config.ts`): README configuration table and `.env.example`.
- **agent.md `github.*` key**: `profiles/types.ts`, `loader.ts` (`GITHUB_DEFAULTS`: `test/unit.test.ts` requires each key documented in `reference.ts` with the same default; `null` defaults are skipped), `web/src/api.ts`, an AgentDetail chip if people should see it.
- **Other agent.md key**: `loader.ts`, `types.ts`, `reference.ts`, `web/src/api.ts`.
- **Board file key**: `boards/rules.ts` parser (unit test), `boards/loader.ts`, `reference.ts`, `profiles/boards/product.yaml.example`.
- **Task field**: `types.ts`, `db.ts` (`addColumn`, `toTask`, `NewTask`, `createTask`, `TASK_COLUMNS` if it changes), `web/src/api.ts`.
- **Queries about real work** must skip dry runs: `AND dry_run = 0`.
- **Agent tool that writes to GitHub**: add it to `WRITE_TOOLS` in `github-tools.ts` (dry runs); bodies go through `signed()`/`clampBody` so the orchestrator recognises its own webhooks.
- **Admin write route**: if operators may use it, add it to `OPERATOR_WRITES` in `server/roles.ts`.
- **A problem worth alerting on**: `recordIncident(kind, severity, message)` and the kind in `incidents.ts`.
- **A new limit**: add a row to the `/api/guards` list in `server/api.ts` (Settings → Loop guards).
- **Background job**: hourly timers live in `startWorkspaceCleanup`, `startOutcomeChecks` (pull requests, branch cleanup), `startAccountChecks`, `startBackups`/`startRetention`, `startBoards` (polling, archiving), `startSchedules` (every 30 s); start them in `index.ts`, `.unref()` the timers.
- **Folders the agent user must read or write** (isolation): add to `sharedRoots()` in `isolation.ts`; git run there must go through `git()` (it keeps files group-readable).
- README: the matching section; keep sentences short and plain.
