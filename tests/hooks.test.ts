import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { type FakeEnv, makeFakeEnv, makeRepo, makeTempDir, PLUGIN_ROOT } from "./helpers.ts";

const SESSION_START = path.join(PLUGIN_ROOT, "scripts", "session-start-hook.ts");
const STOP_GATE = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.ts");

// The tests run inside Claude Code, so makeFakeEnv drops every CLAUDE_* and
// CODEX_* variable before the hooks see the environment.
function runHook(script: string, input: unknown, env: NodeJS.ProcessEnv, cwd: string) {
  return spawnSync(process.execPath, [script], {
    cwd,
    env,
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    timeout: 60_000,
  });
}

function enableGate(fake: FakeEnv, root: string): void {
  fs.mkdirSync(fake.dataDir, { recursive: true });
  fs.writeFileSync(path.join(fake.dataDir, "review-gate.json"), JSON.stringify({ workspaces: { [root]: true } }));
}

function decisionOf(stdout: string): { decision?: string; reason?: string } | null {
  return stdout.trim() ? (JSON.parse(stdout) as { decision?: string; reason?: string }) : null;
}

test("SessionStart exports the session id, transcript path, and data dir to CLAUDE_ENV_FILE", () => {
  const fake = makeFakeEnv();
  const envFile = path.join(makeTempDir(), "env.sh");
  const env = { ...fake.env, CLAUDE_ENV_FILE: envFile };
  const transcript = "/tmp/it's a $(path).jsonl";
  const result = runHook(SESSION_START, { session_id: "abc-123", transcript_path: transcript }, env, fake.home);
  assert.equal(result.status, 0, result.stderr);

  const printed = spawnSync(
    "/bin/sh",
    [
      "-c",
      `. "$1"; printf '%s\\n%s\\n%s' "$CODEX_COMPANION_SESSION_ID" "$CODEX_COMPANION_TRANSCRIPT_PATH" "$CLAUDE_PLUGIN_DATA"`,
      "sh",
      envFile,
    ],
    { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } },
  );
  assert.equal(printed.stdout, `abc-123\n${transcript}\n${fake.dataDir}`);
});

test("SessionStart without CLAUDE_ENV_FILE does nothing", () => {
  const fake = makeFakeEnv();
  const result = runHook(SESSION_START, { session_id: "abc" }, fake.env, fake.home);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("Stop does nothing when the gate is off", () => {
  const fake = makeFakeEnv();
  const repo = makeRepo(fake.env);
  const result = runHook(STOP_GATE, { cwd: repo, last_assistant_message: "done" }, fake.env, repo);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(fake.readLog().length, 0);
});

test("Stop runs a read-only, ephemeral Codex review and allows on ALLOW", () => {
  const fake = makeFakeEnv();
  fake.env.FAKE_CODEX_MESSAGE = "ALLOW: no edits";
  const repo = makeRepo(fake.env);
  enableGate(fake, repo);
  const result = runHook(STOP_GATE, { cwd: repo, last_assistant_message: "I edited a.ts" }, fake.env, repo);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  const [call] = fake.readLog();
  assert.ok(call);
  assert.equal(call.rejected, undefined);
  assert.deepEqual(call.argv.slice(0, 7), [
    "exec",
    "-s",
    "read-only",
    "-c",
    'approval_policy="never"',
    "-c",
    'approvals_reviewer="user"',
  ]);
  for (const flag of ["--skip-git-repo-check", "--ephemeral", "--json"]) {
    assert.ok(call.argv.includes(flag), flag);
  }
  assert.match(call.stdin ?? "", /Previous Claude response:\nI edited a\.ts/);
});

test("Stop blocks with Codex's reason on BLOCK", () => {
  const fake = makeFakeEnv();
  fake.env.FAKE_CODEX_MESSAGE = "BLOCK: the migration drops data\nmore detail";
  const repo = makeRepo(fake.env);
  enableGate(fake, repo);
  const decision = decisionOf(runHook(STOP_GATE, { cwd: repo }, fake.env, repo).stdout);
  assert.equal(decision?.decision, "block");
  assert.match(decision?.reason ?? "", /the migration drops data/);
});

test("Stop blocks when Codex fails, returns nothing, or answers in the wrong format", () => {
  const cases: [string, string | undefined, RegExp][] = [
    ["exit-nonzero", undefined, /failed \(exit 1\)/],
    ["turn-failed", undefined, /model overloaded/],
    ["empty-output", undefined, /no output/],
    ["ok", "Looks fine to me.", /unexpected answer/],
  ];
  for (const [scenario, message, expected] of cases) {
    const fake = makeFakeEnv({ scenario });
    if (message !== undefined) {
      fake.env.FAKE_CODEX_MESSAGE = message;
    }
    const repo = makeRepo(fake.env);
    enableGate(fake, repo);
    const result = runHook(STOP_GATE, { cwd: repo }, fake.env, repo);
    assert.equal(result.status, 0, result.stderr);
    const decision = decisionOf(result.stdout);
    assert.equal(decision?.decision, "block", scenario);
    assert.match(decision?.reason ?? "", expected);
  }
});

test("Stop lets the turn end with a note when codex is missing", () => {
  const fake = makeFakeEnv({ codex: false });
  const repo = makeRepo(fake.env);
  enableGate(fake, repo);
  const result = runHook(STOP_GATE, { cwd: repo }, fake.env, repo);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /\/codex:setup/);
});

test("Stop works with the gate on for a directory outside Git", () => {
  const fake = makeFakeEnv();
  fake.env.FAKE_CODEX_MESSAGE = "ALLOW: nothing to review";
  const plain = makeTempDir();
  enableGate(fake, plain);
  const result = runHook(STOP_GATE, { cwd: plain }, fake.env, plain);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  const [call] = fake.readLog();
  assert.ok(call?.argv.includes("--skip-git-repo-check"));
  assert.equal(call?.cwd, plain);
});

test("Stop treats unreadable hook input as empty", () => {
  const fake = makeFakeEnv();
  const repo = makeRepo(fake.env);
  const result = runHook(STOP_GATE, "not json", fake.env, repo);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});
