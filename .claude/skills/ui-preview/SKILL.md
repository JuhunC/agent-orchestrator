---
name: ui-preview
description: Look at the agent-orchestrator admin UI in the browser pane with local data, to check a UI change at desktop and phone width.
---
1. `npm run build` (the UI goes to web/dist).
2. A data folder in the scratchpad: `profiles/agents/<name>/agent.md` files, and `data/`. Seed settings with a small script run with `DATA_DIR=<…>/data` that imports `src/db.ts` (and `seal` from `src/server/secrets.ts` for secrets), e.g. a registered GitHub account: `setSetting("agent_account:coder", JSON.stringify({ login, id, name, avatarUrl: "", scopes, token: seal("x"), savedAt }))`.
3. `.claude/launch.json`: configuration `orchestrator-preview`, `runtimeExecutable` `node`, `runtimeArgs` `["--disable-warning=ExperimentalWarning", "src/index.ts"]`, `port` 3123, `env` `{ PORT: "3123", DATA_DIR, PROFILES_DIR, AUTH_DISABLED: "true", WEB_DIST_DIR: "web/dist" }` (add any env the feature needs).
4. `preview_start` it, navigate to `http://localhost:3123/#/<page>`. Bring a panel into view with javascript_tool: `[...document.querySelectorAll('h2')].find(h => h.textContent === '<Title>').closest('section').scrollIntoView()`. Screenshot at scale 0.6–0.8; `resize_window` mobile for phone width, then desktop.
5. `preview_stop`, and delete `.claude/launch.json` (it isn't part of the repo).

A flood of `ERR_CONNECTION_REFUSED` in the console comes from an earlier preview's event stream reconnecting: ignore it.
