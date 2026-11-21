import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { firstLine, git, makeFakeEnv, makeRepo, makeTempDir, outputLine, runRunner, writePrompt } from "./helpers.ts";

function threadRecord(stateDir: string, thread: string): { cwd: string; repo: string | null } {
  return JSON.parse(fs.readFileSync(path.join(stateDir, "threads", `${thread}.json`), "utf8")) as {
    cwd: string;
    repo: string | null;
  };
}

// H7
test("--thread continues a thread from another worktree of the same repository", () => {
  const fake = makeFakeEnv();
  const repo = makeRepo(fake.env);
  const worktree = path.join(makeTempDir(), "wt");
  git(repo, ["worktree", "add", "-q", "-b", "wt", worktree], fake.env);
  const prompt = writePrompt();

  const first = runRunner(["--prompt-file", prompt, "--read-only"], { env: fake.env, cwd: repo });
  assert.equal(first.status, 0, first.stderr);
  const thread = outputLine(first.stdout, "thread") ?? "";
  const repoDir = fs.realpathSync(path.join(repo, ".git"));
  assert.equal(threadRecord(fake.stateDir, thread).cwd, repo);
  assert.equal(threadRecord(fake.stateDir, thread).repo, repoDir);

  const moved = runRunner(["--prompt-file", prompt, "--thread", thread, "--cwd", worktree], {
    env: fake.env,
    cwd: repo,
  });
  assert.equal(moved.status, 0, moved.stderr);
  const [, resumed] = fake.readLog();
  assert.equal(resumed?.cwd, worktree);
  assert.deepEqual(resumed?.argv.slice(-2), [thread, "-"]);
  assert.ok(resumed?.argv.includes("resume"));
  assert.equal(threadRecord(fake.stateDir, thread).cwd, fs.realpathSync(worktree));
  assert.equal(threadRecord(fake.stateDir, thread).repo, repoDir);
});

test("--thread for another repository, an unknown id, or an invalid id exits 2 before codex starts", () => {
  const fake = makeFakeEnv();
  const repo = makeRepo(fake.env);
  const other = makeRepo(fake.env);
  const prompt = writePrompt();
  const first = runRunner(["--prompt-file", prompt, "--read-only"], { env: fake.env, cwd: repo });
  const thread = outputLine(first.stdout, "thread") ?? "";

  const elsewhere = runRunner(["--prompt-file", prompt, "--thread", thread], { env: fake.env, cwd: other });
  assert.equal(elsewhere.status, 2);
  assert.match(firstLine(elsewhere.stderr), new RegExp(`belongs to ${repo} .*codex resume ${thread}`));
  assert.equal(elsewhere.stdout, "");

  const unknown = runRunner(["--prompt-file", prompt, "--thread", "0000-unknown"], { env: fake.env, cwd: repo });
  assert.equal(unknown.status, 2);
  assert.match(firstLine(unknown.stderr), /not started by codex-run.*codex resume 0000-unknown/);

  const invalid = runRunner(["--prompt-file", prompt, "--thread", "../x"], { env: fake.env, cwd: repo });
  assert.equal(invalid.status, 2);
  assert.equal(fake.readLog().length, 1);
});

test("a thread recorded outside Git continues only in the same directory, and a Git record never matches by path", () => {
  const fake = makeFakeEnv();
  const plain = makeTempDir();
  const prompt = writePrompt();
  const first = runRunner(["--prompt-file", prompt, "--read-only"], { env: fake.env, cwd: plain });
  assert.equal(first.status, 0, first.stderr);
  const thread = outputLine(first.stdout, "thread") ?? "";
  assert.equal(threadRecord(fake.stateDir, thread).repo, null);
  assert.equal(
    runRunner(["--prompt-file", prompt, "--read-only", "--thread", thread], { env: fake.env, cwd: plain }).status,
    0,
  );
  assert.equal(
    runRunner(["--prompt-file", prompt, "--read-only", "--thread", thread], { env: fake.env, cwd: makeTempDir() })
      .status,
    2,
  );

  // The same directory, now a repository: the non-Git record no longer matches.
  git(plain, ["init", "-q", "-b", "main"], fake.env);
  assert.equal(
    runRunner(["--prompt-file", prompt, "--read-only", "--thread", thread], { env: fake.env, cwd: plain }).status,
    2,
  );

  // A Git record does not match a directory at its path that is no longer in Git.
  const repo = makeRepo(fake.env);
  const gitRun = runRunner(["--prompt-file", prompt, "--read-only"], { env: fake.env, cwd: repo });
  const gitThread = outputLine(gitRun.stdout, "thread") ?? "";
  assert.equal(threadRecord(fake.stateDir, gitThread).cwd, repo);
  fs.rmSync(path.join(repo, ".git"), { recursive: true });
  const result = runRunner(["--prompt-file", prompt, "--read-only", "--thread", gitThread], {
    env: fake.env,
    cwd: repo,
  });
  assert.equal(result.status, 2);
  assert.match(firstLine(result.stderr), /belongs to/);
});
