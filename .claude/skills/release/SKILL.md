---
name: release
description: Release an agent-orchestrator version (vX.Y.Z) once a change is committed - full test run against the exact commit, tag, push, CI check. Use whenever the user asks to release, ship or publish, or a request says to release each item.
---
# Releasing agent-orchestrator

Versions are git tags only (package.json stays 0.1.0). Next version: patch-bump `git tag --sort=-v:refname | head -1`. Work is committed straight on `main`; each item the user asks for is its own commit and release.

1. **Commit**: first line is the change in plain words; then why, then `- ` bullets; end with the attribution line from the system reminder.
2. **Full suite on that commit**, in a scratch worktree so editing can go on (≈12 min for ~85 tests; never two suites at once, timing tests flake):
   ```bash
   WT=<scratchpad>/wt-<ver>; git worktree add -q --detach "$WT" <sha> && ln -s "$PWD/node_modules" "$WT/node_modules"
   (cd "$WT" && npm run typecheck && npm test) > "$WT.log" 2>&1; echo "exit $?" >> "$WT.log"   # run_in_background
   grep -E "^ℹ (tests|pass|fail)|^exit|^✖" "$WT.log"
   ```
   Several commits waiting: one suite on the newest commit covers them (each already passed its own targeted tests).
3. **Tag and push**. In zsh, brace the variable before `:` (`$sha:r…` is a zsh modifier and silently breaks the refspec):
   ```bash
   git tag -a "$ver" "$sha" -m "$ver: <summary>"
   git push -q origin "${sha}:refs/heads/main" && git push -q origin "$ver"
   git worktree remove --force "$WT"
   ```
   Several releases: tag each commit in order and push main to the newest. CI deploys only main's tip, one deploy at a time.
4. **CI**: `gh run list --limit 10 --json headBranch,status,conclusion`; wait with `gh run watch <id> --exit-status --interval 30` in the background. The test job also runs `test/docker/isolation.docker-test.ts` inside the built image. A cancelled *deploy* job on an older tag is the guard making way for a newer one. While `DEPLOY_HOST`/`DEPLOY_SSH_KEY` are unset the deploy is skipped: the user updates with `docker compose pull && docker compose up -d`.
