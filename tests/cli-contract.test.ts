// Contract with the real Codex CLI (the version mise pins). Runs only with
// CODEX_CLI_CONTRACT=1 (`pnpm run test:cli-contract`).
//
// Each case runs codex-run against the real `codex` with a CODEX_HOME whose
// config.toml is invalid. If the argv the runner builds gets through Codex's
// argument parser, Codex fails while loading the config, before any model or
// network call; a rejected argv fails earlier with a usage error.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { makeFakeEnv, makeRepo, runRunner, writePrompt } from "./helpers.ts";

const enabled = process.env.CODEX_CLI_CONTRACT === "1";
const CONFIG_ERROR = /Error loading config\.toml/;
const USAGE_ERROR = /unexpected argument|Usage: codex|error: .*required/;

function realCodexDir(): string {
  const found = spawnSync("/bin/sh", ["-c", "command -v codex"], { encoding: "utf8" }).stdout.trim();
  assert.ok(found, "the Codex CLI must be on PATH (mise install)");
  return path.dirname(found);
}

test("the real CLI accepts the argv of new and resumed runs in both sandboxes", { skip: !enabled }, () => {
  const fake = makeFakeEnv({ codex: false });
  const codexHome = path.join(fake.home, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "config.toml"), "model = [unclosed\n");
  fake.env.PATH = `${realCodexDir()}${path.delimiter}${fake.env.PATH ?? ""}`;
  fake.env.CODEX_HOME = codexHome;
  const repo = makeRepo(fake.env);

  // A recorded thread, so the resumed forms get as far as spawning codex.
  const threadId = randomUUID();
  const threadsDir = path.join(fake.stateDir, "threads");
  fs.mkdirSync(threadsDir, { recursive: true });
  fs.writeFileSync(
    path.join(threadsDir, `${threadId}.json`),
    JSON.stringify({ cwd: repo, repo: fs.realpathSync(path.join(repo, ".git")), updatedAt: "" }),
  );

  const prompt = writePrompt();
  const model = ["--model", "m", "--effort", "high"];
  const cases: string[][] = [
    [],
    ["--read-only"],
    [...model],
    ["--read-only", ...model],
    ["--thread", threadId, ...model],
    ["--thread", threadId, "--read-only", ...model],
  ];
  for (const args of cases) {
    const label = JSON.stringify(args);
    const result = runRunner(["--prompt-file", prompt, ...args], { env: fake.env, cwd: repo });
    assert.equal(result.status, 1, `${label}: ${result.stderr}`);
    assert.match(result.stderr, CONFIG_ERROR, label);
    assert.doesNotMatch(result.stderr, USAGE_ERROR, label);
  }
});
