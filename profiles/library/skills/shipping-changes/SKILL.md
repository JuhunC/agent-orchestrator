---
name: shipping-changes
description: How to finish a task in this orchestrator - verify, commit, push and open a pull request with the GitHub tools. Use when your code changes are ready.
---
# Shipping changes

You can't push with `git push` or `gh`; the orchestrator holds the GitHub credentials. Use its tools:

1. Run the project's tests and linters. Fix failures you caused.
2. Review `git status` and `git diff` so only intended changes go out.
3. `commit_and_push` with a message in the repository's style (imperative summary line, body explaining why). You can call it more than once.
4. `open_pull_request` with:
   - a title that says what changes for users,
   - a body with a short summary, how you tested it, and anything reviewers should look at,
   - `Closes #<issue>` when working from an issue (added for you automatically).
5. Optionally `get_ci_status` after pushing and fix what fails.

On a pull request thread you're already on its branch: `commit_and_push` updates that PR, and there's nothing to open.
