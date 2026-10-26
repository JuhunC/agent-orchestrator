import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { after, test } from "node:test";
import { startHarness } from "./harness.ts";

// A stand-in for a custom Claude Code build: records how it was started, then runs the bundled binary.
const sdkPackages = resolve("node_modules/@anthropic-ai");
const platform = `${process.platform}-${process.arch}`;
const bundled = [platform, `${platform}-musl`].map((name) => join(sdkPackages, `claude-agent-sdk-${name}`, "claude")).find((path) => existsSync(path));
assert.ok(bundled, `no bundled Claude Code binary for ${platform} under ${sdkPackages}`);

const dir = mkdtempSync(join(tmpdir(), "ao-exe-"));
const bin = join(dir, "bin");
const calls = join(dir, "calls.log");
mkdirSync(bin);
writeFileSync(join(bin, "custom-claude"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexec '${bundled}' "$@"\n`);
chmodSync(join(bin, "custom-claude"), 0o755);

const h = await startHarness(
  { "agents/coder/agent.md": "---\nhandle: aorch-coder\ndescription: coder\n---\nYou code.\n" },
  { CLAUDE_CODE_EXECUTABLE: "custom-claude", PATH: `${bin}${delimiter}${process.env.PATH}` },
);
after(() => h.stop());

test("agents run CLAUDE_CODE_EXECUTABLE (found on PATH) instead of the bundled Claude Code", async () => {
  const task = await h.waitForTask((await h.mentionOnNewIssue(1, "aorch-coder", "say hi")).id);
  assert.equal(task.status, "succeeded", task.error ?? "");
  assert.equal(task.resultText, "OK", "the model's reply came back through the custom executable");
  assert.ok(existsSync(calls), "the custom executable was started");
  assert.match(readFileSync(calls, "utf8"), /--output-format stream-json/);
});
