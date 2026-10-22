// Contract with the real Codex CLI (the version mise pins). Runs only with
// CODEX_CLI_CONTRACT=1 (`pnpm run test:cli-contract`).
//
// Each case runs the adapter or the Stop hook against the real `codex` with a
// CODEX_HOME whose config.toml is invalid. If the argv the plugin builds gets
// through Codex's argument parser, Codex fails while loading the config, before
// any model or network call; a rejected argv fails earlier with a usage error.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { makeFakeEnv, makeRepo, PLUGIN_ROOT, runAdapter } from "./helpers.ts";

const enabled = process.env.CODEX_CLI_CONTRACT === "1";
const CONFIG_ERROR = /Error loading config\.toml/;
const USAGE_ERROR = /unexpected argument|Usage: codex|error: .*required/;

function realCodexDir(): string {
  const found = spawnSync("/bin/sh", ["-c", "command -v codex"], { encoding: "utf8" }).stdout.trim();
  assert.ok(found, "the Codex CLI must be on PATH (mise install)");
  return path.dirname(found);
}

function setup() {
  const fake = makeFakeEnv({ codex: false });
  const codexHome = path.join(fake.home, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "config.toml"), "model = [unclosed\n");
  fake.env.PATH = `${realCodexDir()}${path.delimiter}${fake.env.PATH ?? ""}`;
  fake.env.CODEX_HOME = codexHome;
  fake.env.CODEX_COMPANION_SESSION_ID = "contract-session";
  const repo = makeRepo(fake.env);
  return { fake, repo };
}

function assertReachedConfigLoading(result: { status: number | null; stderr: string }, label: string): void {
  assert.equal(result.status, 1, `${label}: ${result.stderr}`);
  assert.match(result.stderr, CONFIG_ERROR, label);
  assert.doesNotMatch(result.stderr, USAGE_ERROR, label);
}

test("the real CLI accepts the argv of every task, review, and adversarial-review form", { skip: !enabled }, () => {
  const { fake, repo } = setup();

  // A recorded thread, so the resume forms get as far as spawning codex.
  const threadId = randomUUID();
  const threadsDir = path.join(fake.dataDir, "threads", "contract-session");
  fs.mkdirSync(threadsDir, { recursive: true });
  fs.writeFileSync(path.join(threadsDir, `${threadId}.json`), JSON.stringify({ cwd: repo, updatedAt: "" }));
  fs.writeFileSync(path.join(threadsDir, "latest"), threadId);

  const cases: [string, string][] = [
    ["task", "go"],
    ["task", "--read-only --model m --effort high go"],
    ["task", "--resume --model m --effort high go"],
    ["task", `--thread ${threadId} --read-only go`],
    ["review", "--base main --model m --effort high"],
    ["adversarial-review", "--model m --effort high focus"],
  ];
  for (const [sub, input] of cases) {
    assertReachedConfigLoading(runAdapter(sub, input, { env: fake.env, cwd: repo }), `${sub} ${input}`);
  }

  // A dirty tree selects `review --uncommitted`.
  fs.writeFileSync(path.join(repo, "README.md"), "changed\n");
  assertReachedConfigLoading(runAdapter("review", "", { env: fake.env, cwd: repo }), "review --uncommitted");
  assertReachedConfigLoading(runAdapter("adversarial-review", "", { env: fake.env, cwd: repo }), "adversarial");
});

test("the real CLI accepts the Stop hook's argv", { skip: !enabled }, () => {
  const { fake } = setup();
  const plain = fs.realpathSync(fs.mkdtempSync(path.join(fake.home, "plain-")));
  fs.mkdirSync(fake.dataDir, { recursive: true });
  fs.writeFileSync(path.join(fake.dataDir, "review-gate.json"), JSON.stringify({ workspaces: { [plain]: true } }));
  const result = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.ts")], {
    cwd: plain,
    env: fake.env,
    input: JSON.stringify({ cwd: plain }),
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  // A usage error would exit 2; failing at config loading exits 1, and the
  // reason carries the config error line from Codex's stderr.
  const decision = JSON.parse(result.stdout) as { decision: string; reason: string };
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /failed \(exit 1\): Error loading config\.toml/);
  assert.doesNotMatch(decision.reason, USAGE_ERROR);
});

test("setup reads the real CLI's version", { skip: !enabled }, () => {
  const { fake, repo } = setup();
  const result = runAdapter("setup", "", { env: fake.env, cwd: repo });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /- codex: codex-cli \d+\.\d+\.\d+/);
});
