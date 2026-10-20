#!/usr/bin/env bash
# A stand-in for a custom agent CLI (like `myClaude -p`). Reads the prompt from stdin,
# reports progress with ::progress:: lines, edits the repo, and replies on stdout.
set -euo pipefail
prompt="$(cat)"
echo "::progress:: Read the request"

if [[ "$prompt" == *"SLEEP_FOREVER"* ]]; then
  sleep 600
fi
if [[ "$prompt" == *"PLEASE_FAIL"* ]]; then
  echo "something went wrong" >&2
  exit 3
fi
if [[ "$prompt" == *"Your previous work here"* ]]; then
  echo "I remember my earlier run on this thread."
fi
if [[ -n "${GITHUB_WEBHOOK_SECRET:-}${GITHUB_APP_PRIVATE_KEY:-}" ]]; then
  echo "SECRET_LEAK"
fi

echo "Hello from task ${AO_TASK_ID}" >> GREETING.md
echo "::progress:: Wrote GREETING.md"
echo "Added a greeting to GREETING.md."
