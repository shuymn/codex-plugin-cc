import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  type FakeCall,
  type FakeEnv,
  firstLine,
  git,
  makeFakeEnv,
  makeRepo,
  exitCodeOf,
  makeTempDir,
  PLUGIN_ROOT,
  runAdapter,
  spawnAdapter,
  waitForFile,
  waitUntilGone,
} from "./helpers.ts";

const APPROVALS = ["-c", 'approval_policy="never"', "-c", 'approvals_reviewer="user"'];

function setup(scenario = "ok", sessionId: string | null = "session-a") {
  const fake = makeFakeEnv({ scenario });
  if (sessionId !== null) {
    fake.env.CODEX_COMPANION_SESSION_ID = sessionId;
  }
  const repo = makeRepo(fake.env);
  return { fake, repo };
}

function onlyCall(fake: FakeEnv): FakeCall {
  const calls = fake.readLog();
  assert.equal(calls.length, 1, JSON.stringify(calls));
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.rejected, undefined, call.rejected);
  return call;
}

function threadIdFrom(stdout: string): string {
  const match = /^Codex thread: (\S+)$/m.exec(stdout);
  assert.ok(match?.[1], stdout);
  return match[1];
}

function sandboxOf(call: FakeCall): string | undefined {
  return call.argv[call.argv.indexOf("-s") + 1];
}

// EARS 1
test("task passes option-like words, quotes, and newlines in the text to codex verbatim", () => {
  const { fake, repo } = setup();
  const text = `please --write this\n--read-only --resume --model x\n"quoted" 'single' $HOME`;
  const result = runAdapter("task", `--wait ${text}`, { env: fake.env, cwd: repo });
  assert.equal(result.status, 0, result.stderr);
  const call = onlyCall(fake);
  assert.equal(call.stdin, text);
  assert.equal(sandboxOf(call), "workspace-write");
  assert.ok(!call.argv.includes("-m"));
});

// EARS 2 (adapter side; the shell side is in commands.test.ts)
test("task passes shell syntax through without running it", () => {
  const { fake, repo } = setup();
  const text = "run $(touch pwned) and `touch pwned2` with $HOME";
  const result = runAdapter("task", text, { env: fake.env, cwd: repo });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(onlyCall(fake).stdin, text);
  assert.ok(!fs.existsSync(path.join(repo, "pwned")));
  assert.ok(!fs.existsSync(path.join(repo, "pwned2")));
});

test("task argv: workspace-write by default, read-only on request, approvals and git check always", () => {
  const { fake, repo } = setup();
  assert.equal(runAdapter("task", "do it", { env: fake.env, cwd: repo }).status, 0);
  assert.equal(runAdapter("task", "--read-only look only", { env: fake.env, cwd: repo }).status, 0);
  const calls = fake.readLog();
  assert.equal(calls.length, 2);
  const [write, readOnly] = calls;
  assert.ok(write && readOnly);
  assert.deepEqual(write.argv.slice(0, 8), ["exec", "-s", "workspace-write", ...APPROVALS, "--skip-git-repo-check"]);
  assert.equal(sandboxOf(readOnly), "read-only");
  assert.ok(readOnly.argv.includes("--skip-git-repo-check"));
  assert.equal(write.argv.at(-1), "-");
});

// EARS 3
test("an unknown leading option exits 2 without starting codex", () => {
  for (const sub of ["task", "review", "adversarial-review", "setup", "transfer"]) {
    const fake = makeFakeEnv();
    const result = runAdapter(sub, "--write do it", { env: fake.env, cwd: fake.home });
    assert.equal(result.status, 2, `${sub}: ${result.stderr}`);
    assert.match(firstLine(result.stderr), /--write/);
    assert.equal(fake.readLog().length, 0);
  }
});

// EARS 4
test("--help and -h print usage, exit 0, and never start codex", () => {
  for (const sub of ["task", "review", "adversarial-review", "setup", "transfer"]) {
    for (const flag of ["--help", "-h"]) {
      const fake = makeFakeEnv();
      const result = runAdapter(sub, flag, { env: fake.env, cwd: fake.home });
      assert.equal(result.status, 0, `${sub} ${flag}: ${result.stderr}`);
      assert.match(result.stdout, /^Usage: /);
      assert.equal(fake.readLog().length, 0);
    }
  }
});

test("a missing or unknown subcommand is a usage error", () => {
  const fake = makeFakeEnv();
  assert.equal(runAdapter("status", "", { env: fake.env, cwd: fake.home }).status, 2);
  assert.equal(fake.readLog().length, 0);
});

// EARS 5
test("--cwd runs codex there and records the thread under that workspace", () => {
  const { fake } = setup();
  const other = makeRepo(fake.env);
  const elsewhere = makeTempDir();
  const sub = path.join(other, "sub");
  fs.mkdirSync(sub);
  const result = runAdapter("task", `--cwd ${sub} do it`, { env: fake.env, cwd: elsewhere });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(onlyCall(fake).cwd, sub);
  assert.match(result.stdout, new RegExp(`--cwd ${sub}`));

  // Resume from the same workspace root, even from another directory in it.
  const resumed = runAdapter("task", `--cwd ${other} --resume continue`, { env: fake.env, cwd: elsewhere });
  assert.equal(resumed.status, 0, resumed.stderr);
  // From elsewhere without --cwd the workspace differs, so resume is refused.
  const refused = runAdapter("task", "--resume continue", { env: fake.env, cwd: elsewhere });
  assert.equal(refused.status, 2);
});

test("--cwd that is not a directory exits 2", () => {
  const { fake, repo } = setup();
  const file = path.join(repo, "README.md");
  for (const sub of ["task", "review", "adversarial-review", "setup", "transfer"]) {
    const result = runAdapter(sub, `--cwd ${file} go`, { env: fake.env, cwd: repo });
    assert.equal(result.status, 2, sub);
  }
  assert.equal(fake.readLog().length, 0);
});

// EARS 6
test("--prompt-file content goes to codex unchanged", () => {
  const { fake, repo } = setup();
  const content = "  line one\n--write\n\n$(nope)\n";
  fs.writeFileSync(path.join(repo, "prompt.md"), content);
  const result = runAdapter("task", "--prompt-file prompt.md", { env: fake.env, cwd: repo });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(onlyCall(fake).stdin, content);
});

test("--prompt-file with text, an empty file, or no text at all exits 2", () => {
  const { fake, repo } = setup();
  fs.writeFileSync(path.join(repo, "prompt.md"), "content");
  fs.writeFileSync(path.join(repo, "empty.md"), " \n");
  assert.equal(runAdapter("task", "--prompt-file prompt.md and text", { env: fake.env, cwd: repo }).status, 2);
  assert.equal(runAdapter("task", "--prompt-file empty.md", { env: fake.env, cwd: repo }).status, 2);
  assert.equal(runAdapter("task", "--prompt-file missing.md", { env: fake.env, cwd: repo }).status, 2);
  assert.equal(runAdapter("task", "--wait", { env: fake.env, cwd: repo }).status, 2);
  assert.equal(fake.readLog().length, 0);
});

// EARS 7
test("--resume without a recorded thread or without a session id exits 2 and says what to do", () => {
  const { fake, repo } = setup();
  const noThread = runAdapter("task", "--resume go on", { env: fake.env, cwd: repo });
  assert.equal(noThread.status, 2);
  assert.match(firstLine(noThread.stderr), /no Codex thread yet.*without --resume/);

  const anonymous = setup("ok", null);
  const noSession = runAdapter("task", "--resume go on", { env: anonymous.fake.env, cwd: anonymous.repo });
  assert.equal(noSession.status, 2);
  assert.match(firstLine(noSession.stderr), /no Claude session id/);

  const badSession = setup("ok", "../escape");
  const invalid = runAdapter("task", "--resume go on", { env: badSession.fake.env, cwd: badSession.repo });
  assert.equal(invalid.status, 2);
  assert.equal(fake.readLog().length + anonymous.fake.readLog().length + badSession.fake.readLog().length, 0);
});

test("--resume and --thread together exit 2", () => {
  const { fake, repo } = setup();
  assert.equal(runAdapter("task", "--resume --thread abc go", { env: fake.env, cwd: repo }).status, 2);
  assert.equal(fake.readLog().length, 0);
});

// EARS 8
test("sessions A and B in one repo each resume their own thread", () => {
  const { fake, repo } = setup();
  const envA = { ...fake.env, CODEX_COMPANION_SESSION_ID: "session-a" };
  const envB = { ...fake.env, CODEX_COMPANION_SESSION_ID: "session-b" };
  const threadA = threadIdFrom(runAdapter("task", "task a", { env: envA, cwd: repo }).stdout);
  const threadB = threadIdFrom(runAdapter("task", "task b", { env: envB, cwd: repo }).stdout);
  assert.notEqual(threadA, threadB);

  assert.equal(runAdapter("task", "--resume more a", { env: envA, cwd: repo }).status, 0);
  assert.equal(runAdapter("task", "--resume more b", { env: envB, cwd: repo }).status, 0);
  const calls = fake.readLog();
  assert.equal(calls.length, 4);
  const [, , resumeA, resumeB] = calls;
  assert.deepEqual(resumeA?.argv.slice(-2), [threadA, "-"]);
  assert.ok(resumeA?.argv.includes("resume"));
  assert.equal(resumeA?.stdin, "more a");
  assert.deepEqual(resumeB?.argv.slice(-2), [threadB, "-"]);
});

test("parallel tasks in one session can each be resumed with --thread", async () => {
  const { fake, repo } = setup();
  const runs = ["task a", "task b"].map(
    (input) =>
      new Promise<string>((resolve, reject) => {
        const child = spawnAdapter("task", input, { env: fake.env, cwd: repo });
        let stdout = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`exit ${code}`))));
      }),
  );
  const [threadA, threadB] = (await Promise.all(runs)).map(threadIdFrom);
  assert.ok(threadA && threadB && threadA !== threadB);

  for (const threadId of [threadA, threadB]) {
    const result = runAdapter("task", `--thread ${threadId} continue`, { env: fake.env, cwd: repo });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`--thread ${threadId}`));
  }
  const resumes = fake.readLog().slice(2);
  assert.deepEqual(
    resumes.map((call) => call.argv.at(-2)),
    [threadA, threadB],
  );
});

test("--thread for a thread this session did not start exits 2", () => {
  const { fake, repo } = setup();
  const thread = threadIdFrom(runAdapter("task", "a", { env: fake.env, cwd: repo }).stdout);
  const other = { ...fake.env, CODEX_COMPANION_SESSION_ID: "session-z" };
  assert.equal(runAdapter("task", `--thread ${thread} go`, { env: other, cwd: repo }).status, 2);
  assert.equal(runAdapter("task", "--thread ../../x go", { env: fake.env, cwd: repo }).status, 2);
  assert.equal(fake.readLog().length, 1);
});

// EARS 9
test("resume is refused when the recorded workspace differs", () => {
  const { fake, repo } = setup();
  const otherRepo = makeRepo(fake.env);
  assert.equal(runAdapter("task", "a", { env: fake.env, cwd: repo }).status, 0);
  const result = runAdapter("task", "--resume go", { env: fake.env, cwd: otherRepo });
  assert.equal(result.status, 2);
  assert.match(firstLine(result.stderr), /belongs to/);
  assert.equal(fake.readLog().length, 1);
});

// EARS 10, 11
test("reviews always run read-only with explicit approvals, whatever the options", () => {
  const { fake, repo } = setup();
  fs.writeFileSync(path.join(repo, "README.md"), "changed\n");
  const inputs = ["", "--wait", "--model m --effort high", "--base main", "--base HEAD --model m"];
  for (const sub of ["review", "adversarial-review"]) {
    for (const input of inputs) {
      const result = runAdapter(sub, input, { env: fake.env, cwd: repo });
      assert.equal(result.status, 0, `${sub} ${input}: ${result.stderr}`);
    }
  }
  const calls = fake.readLog();
  assert.equal(calls.length, inputs.length * 2);
  for (const call of calls) {
    assert.equal(call.rejected, undefined);
    assert.deepEqual(call.argv.slice(0, 7), ["exec", "-s", "read-only", ...APPROVALS]);
    assert.ok(!call.argv.includes("workspace-write"));
  }
});

// EARS 11
test("--model and --effort are passed unchanged, and only when given", () => {
  const { fake, repo } = setup();
  assert.equal(runAdapter("task", '--model "gpt x" --effort xhigh go', { env: fake.env, cwd: repo }).status, 0);
  assert.equal(runAdapter("task", "go", { env: fake.env, cwd: repo }).status, 0);
  const [withModel, without] = fake.readLog();
  assert.ok(withModel && without);
  assert.equal(withModel.argv[withModel.argv.indexOf("-m") + 1], "gpt x");
  assert.ok(withModel.argv.includes('model_reasoning_effort="xhigh"'));
  assert.ok(!without.argv.includes("-m"));
  assert.ok(!without.argv.some((arg) => arg.startsWith("model_reasoning_effort")));
});

// EARS 12
test("a codex failure prints a summary line, then the cleaned stderr tail, and exits 1", () => {
  const { fake, repo } = setup("exit-nonzero");
  const result = runAdapter("task", "go", { env: fake.env, cwd: repo });
  assert.equal(result.status, 1);
  const lines = result.stderr.trimEnd().split("\n");
  assert.equal(lines[0], "codex-plugin: codex exited with 1: ERROR: boom");
  assert.deepEqual(lines.slice(1), ["log line", "ERROR: boom"]);
});

test("a failed turn is summarized from turn.failed", () => {
  const { fake, repo } = setup("turn-failed");
  const result = runAdapter("task", "go", { env: fake.env, cwd: repo });
  assert.equal(result.status, 1);
  assert.equal(firstLine(result.stderr), "codex-plugin: codex exited with 1: model overloaded");
});

test("an error item with exit 0 is still a success", () => {
  const { fake, repo } = setup("warning-item");
  const result = runAdapter("task", "go", { env: fake.env, cwd: repo });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Fake final message\./);
});

test("an empty final message exits 1", () => {
  const { fake, repo } = setup("empty-output");
  const result = runAdapter("task", "go", { env: fake.env, cwd: repo });
  assert.equal(result.status, 1);
  assert.match(firstLine(result.stderr), /without a final message/);
});

test("a codex that exits before reading a large stdin does not crash the adapter", () => {
  const { fake, repo } = setup("early-exit");
  const result = runAdapter("task", `go ${"x".repeat(4 * 1024 * 1024)}`, { env: fake.env, cwd: repo });
  assert.equal(result.status, 1);
  assert.match(firstLine(result.stderr), /^codex-plugin: codex exited with 1/);
});

// EARS 13
test("a successful task prints the thread and resume hints and stores the mapping atomically", () => {
  const { fake, repo } = setup();
  const result = runAdapter("task", "go", { env: fake.env, cwd: repo });
  assert.equal(result.status, 0, result.stderr);
  const threadId = threadIdFrom(result.stdout);
  assert.match(result.stdout, /^Codex thread: \S+\nFake final message\.\n\n---\n/);
  assert.match(result.stdout, new RegExp(`\\(sandbox: workspace-write, cwd: ${repo}, workspace: ${repo}\\)`));
  assert.match(result.stdout, new RegExp(`Continue: /codex:rescue --thread ${threadId} <follow-up>`));
  assert.match(result.stdout, new RegExp(`Terminal: codex resume ${threadId}`));

  const dir = path.join(fake.dataDir, "threads", "session-a");
  assert.deepEqual(fs.readdirSync(dir).toSorted(), [`${threadId}.json`, "latest"].toSorted());
  assert.equal(fs.readFileSync(path.join(dir, "latest"), "utf8").trim(), threadId);
  const record = JSON.parse(fs.readFileSync(path.join(dir, `${threadId}.json`), "utf8")) as { cwd: string };
  assert.equal(record.cwd, repo);
});

test("without a session id the task runs but only offers the terminal resume", () => {
  const { fake, repo } = setup("ok", null);
  const result = runAdapter("task", "go", { env: fake.env, cwd: repo });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Continue:/);
  assert.ok(!fs.existsSync(path.join(fake.dataDir, "threads")));
});

test("task runs outside a Git repository", () => {
  const { fake } = setup();
  const plain = makeTempDir();
  const result = runAdapter("task", "go", { env: fake.env, cwd: plain });
  assert.equal(result.status, 0, result.stderr);
});

// EARS 14
test("review stops before choosing a target when git status fails", () => {
  for (const sub of ["review", "adversarial-review"]) {
    const { fake, repo } = setup();
    // A corrupt index makes `git status` fail while the repository is still found.
    fs.writeFileSync(path.join(repo, ".git", "index"), "not an index");
    const result = runAdapter(sub, "", { env: fake.env, cwd: repo });
    assert.equal(result.status, 1, `${sub}: ${result.stderr}`);
    assert.match(result.stderr, /git status failed/);
    assert.equal(fake.readLog().length, 0, sub);
  }
});

test("review with text exits 2 and points to adversarial-review", () => {
  const { fake, repo } = setup();
  const result = runAdapter("review", "focus on auth", { env: fake.env, cwd: repo });
  assert.equal(result.status, 2);
  assert.match(firstLine(result.stderr), /adversarial-review/);
  assert.equal(fake.readLog().length, 0);
});

test("review picks uncommitted changes when the tree is dirty, else the default branch", () => {
  const { fake, repo } = setup();
  git(repo, ["checkout", "-q", "-b", "feature"], fake.env);
  fs.writeFileSync(path.join(repo, "new.txt"), "untracked\n");
  const dirty = runAdapter("review", "", { env: fake.env, cwd: repo });
  assert.equal(dirty.status, 0, dirty.stderr);
  assert.match(dirty.stdout, /^# Codex Review\n\nTarget: uncommitted changes\n\nReview body from Codex\.\n$/);

  fs.rmSync(path.join(repo, "new.txt"));
  const clean = runAdapter("review", "", { env: fake.env, cwd: repo });
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /Target: branch vs main/);

  const [first, second] = fake.readLog();
  assert.ok(first && second);
  assert.ok(first.argv.includes("--uncommitted"));
  const mainCommit = git(repo, ["rev-parse", "main"], fake.env);
  assert.equal(second.argv[second.argv.indexOf("--base") + 1], mainCommit);
});

test("--base is resolved to a commit id before it reaches codex", () => {
  const { fake, repo } = setup();
  const head = git(repo, ["rev-parse", "HEAD"], fake.env);
  assert.equal(runAdapter("review", "--base main", { env: fake.env, cwd: repo }).status, 0);
  assert.equal(runAdapter("adversarial-review", "--base main focus", { env: fake.env, cwd: repo }).status, 0);
  const [review, adversarial] = fake.readLog();
  assert.ok(review && adversarial);
  assert.deepEqual(review.argv.slice(7, 10), ["review", "--base", head]);
  assert.match(adversarial.stdin ?? "", new RegExp(`git diff ${head}\\.\\.\\.HEAD`));
  assert.match(adversarial.stdin ?? "", /User focus: focus/);
});

test("an invalid --base or a directory outside Git exits 2 without starting codex", () => {
  const { fake, repo } = setup();
  for (const input of ["--base nope", "--base '-x'", "--base 'main;touch x'"]) {
    assert.equal(runAdapter("review", input, { env: fake.env, cwd: repo }).status, 2, input);
  }
  const plain = makeTempDir();
  assert.equal(runAdapter("review", "", { env: fake.env, cwd: plain }).status, 2);
  assert.equal(runAdapter("adversarial-review", "", { env: fake.env, cwd: plain }).status, 2);
  assert.equal(fake.readLog().length, 0);
});

test("adversarial-review sends the filled prompt and renders the findings by severity", () => {
  const { fake, repo } = setup();
  fs.writeFileSync(path.join(repo, "README.md"), "changed\n");
  const result = runAdapter("adversarial-review", "--wait look at\n  races", { env: fake.env, cwd: repo });
  assert.equal(result.status, 0, result.stderr);
  const call = onlyCall(fake);
  assert.ok(call.argv.includes(path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json")));
  assert.match(call.stdin ?? "", /User focus: look at\n {2}races/);
  assert.match(call.stdin ?? "", /git diff HEAD/);
  assert.doesNotMatch(call.stdin ?? "", /\{\{/);
  assert.match(result.stdout, /^# Codex Adversarial Review\n\nTarget: uncommitted changes\nVerdict: needs-attention/);
  assert.ok(result.stdout.indexOf("[critical] Data loss") < result.stdout.indexOf("[low] Minor gap"));
  assert.match(result.stdout, /src\/a\.ts:10-12/);
});

// EARS 15
test("adversarial output that is not valid JSON or breaks the schema exits 1 with the raw output", () => {
  for (const scenario of ["bad-json", "schema-violation"]) {
    const { fake, repo } = setup(scenario);
    const result = runAdapter("adversarial-review", "", { env: fake.env, cwd: repo });
    assert.equal(result.status, 1, scenario);
    assert.match(firstLine(result.stderr), /invalid review/);
    assert.match(result.stderr, /Raw output:\n/);
    assert.equal(result.stdout, "");
  }
});

// EARS 16
test("SIGTERM is forwarded to codex as SIGINT and the adapter exits 143 after codex exits", async () => {
  const { fake, repo } = setup("slow");
  const ready = path.join(makeTempDir(), "ready");
  const adapterTmp = makeTempDir();
  const env = { ...fake.env, FAKE_CODEX_READY_FILE: ready, TMPDIR: adapterTmp };
  const child = spawnAdapter("task", "go", { env, cwd: repo });
  const exited = exitCodeOf(child);
  await waitForFile(ready);
  child.kill("SIGTERM");
  assert.equal(await exited, 143);
  const signals = fake.readLog().filter((call) => call.signal);
  assert.deepEqual(
    signals.map((call) => call.signal),
    ["SIGINT"],
  );
  // The temporary output directory is gone.
  assert.deepEqual(fs.readdirSync(adapterTmp), []);
});

test("the stop ladder reaches a Codex binary behind a launcher that ignores SIGINT", { timeout: 60_000 }, async () => {
  const { fake, repo } = setup("launcher");
  const ready = path.join(makeTempDir(), "ready");
  const adapterTmp = makeTempDir();
  const env = { ...fake.env, FAKE_CODEX_READY_FILE: ready, TMPDIR: adapterTmp };
  const child = spawnAdapter("task", "go", { env, cwd: repo });
  const exited = exitCodeOf(child);
  const binaryPid = Number(await waitForFile(ready));
  const started = Date.now();
  child.kill("SIGTERM");
  assert.equal(await exited, 143);

  const calls = fake.readLog();
  const launcher = calls.find((call) => call.launcher);
  assert.ok(launcher);
  // The binary ignored SIGINT (sent to the group, and forwarded once more by
  // the launcher) and was stopped by the ladder's SIGTERM after the 10 second
  // grace, which the launcher would no longer have forwarded.
  const binarySignals = calls
    .filter((call) => call.pid === binaryPid && call.signal)
    .map((call) => [call.signal, call.ignored ?? false]);
  assert.deepEqual(binarySignals.at(-1), ["SIGTERM", false]);
  assert.ok(binarySignals.length >= 2);
  for (const signal of binarySignals.slice(0, -1)) {
    assert.deepEqual(signal, ["SIGINT", true]);
  }
  assert.ok(Date.now() - started >= 9_000);
  assert.ok(await waitUntilGone(binaryPid), "the Codex binary is still running");
  assert.ok(await waitUntilGone(launcher.pid), "the launcher is still running");
  assert.deepEqual(fs.readdirSync(adapterTmp), []);
});

test("a failure to record the thread stops codex, cleans up, and exits 1", { timeout: 60_000 }, async () => {
  const { fake, repo } = setup("slow");
  const threads = path.join(fake.dataDir, "threads");
  fs.mkdirSync(threads, { recursive: true });
  fs.chmodSync(threads, 0o500);
  try {
    const ready = path.join(makeTempDir(), "ready");
    const adapterTmp = makeTempDir();
    const env = { ...fake.env, FAKE_CODEX_READY_FILE: ready, TMPDIR: adapterTmp };
    const child = spawnAdapter("task", "go", { env, cwd: repo });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    assert.equal(await exitCodeOf(child), 1);
    assert.match(firstLine(stderr), /^codex-plugin: could not record the Codex thread/);
    const codexPid = Number(await waitForFile(ready));
    assert.ok(await waitUntilGone(codexPid), "codex is still running");
    assert.deepEqual(
      fake
        .readLog()
        .filter((call) => call.signal)
        .map((call) => call.signal),
      ["SIGINT"],
    );
    assert.deepEqual(fs.readdirSync(adapterTmp), []);
  } finally {
    fs.chmodSync(threads, 0o700);
  }
});

// EARS 17
test("a missing codex exits 3 and points to /codex:setup", () => {
  const fake = makeFakeEnv({ codex: false });
  const repo = makeRepo(fake.env);
  for (const [sub, input] of [
    ["task", "go"],
    ["review", ""],
    ["adversarial-review", ""],
  ] as const) {
    const result = runAdapter(sub, input, { env: fake.env, cwd: repo });
    assert.equal(result.status, 3, `${sub}: ${result.stderr}`);
    assert.match(firstLine(result.stderr), /\/codex:setup/);
  }
});

test("setup reports version, login, and gate state, and toggles the gate", () => {
  const { fake, repo } = setup();
  const enabled = runAdapter("setup", "--enable-review-gate", { env: fake.env, cwd: repo });
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.match(enabled.stdout, /codex: codex-cli 0\.0\.0-fake/);
  assert.match(enabled.stdout, /auth: logged in/);
  assert.match(enabled.stdout, new RegExp(`review gate: enabled for ${repo}`));
  const gate = JSON.parse(fs.readFileSync(path.join(fake.dataDir, "review-gate.json"), "utf8")) as unknown;
  assert.deepEqual(gate, { workspaces: { [repo]: true } });

  const disabled = runAdapter("setup", "--disable-review-gate", { env: fake.env, cwd: repo });
  assert.match(disabled.stdout, /review gate: disabled/);
  assert.equal(
    runAdapter("setup", "--enable-review-gate --disable-review-gate", { env: fake.env, cwd: repo }).status,
    2,
  );
});

test("setup reports the Git version and warns when it is older than 2.45", () => {
  const { fake, repo } = setup();
  const current = runAdapter("setup", "", { env: fake.env, cwd: repo });
  assert.match(current.stdout, /^- git: git version \d+\.\d+/m);
  assert.doesNotMatch(current.stdout, /Git 2\.45/);

  const realGit = spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  const oldGit = makeTempDir();
  fs.writeFileSync(
    path.join(oldGit, "git"),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version 2.44.0"; exit 0; fi\nexec "${realGit}" "$@"\n`,
    { mode: 0o755 },
  );
  const env = { ...fake.env, PATH: `${oldGit}${path.delimiter}${fake.env.PATH ?? ""}` };
  const result = runAdapter("setup", "", { env, cwd: repo });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^- git: git version 2\.44\.0/m);
  assert.match(result.stdout, /Update Git to 2\.45 or later/);
});

test("setup tells the user to log in or install codex", () => {
  const loggedOut = setup("logged-out");
  const result = runAdapter("setup", "", { env: loggedOut.fake.env, cwd: loggedOut.repo });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /auth: not logged in/);
  assert.match(result.stdout, /codex login/);

  const missing = makeFakeEnv({ codex: false });
  const noCodex = runAdapter("setup", "", { env: missing.env, cwd: makeRepo(missing.env) });
  assert.equal(noCodex.status, 0);
  assert.match(noCodex.stdout, /codex: not found/);
  assert.match(noCodex.stdout, /npm install -g @openai\/codex/);
});

test("transfer --help says --cwd does not set the imported thread's directory", () => {
  const fake = makeFakeEnv();
  const result = runAdapter("transfer", "--help", { env: fake.env, cwd: fake.home });
  assert.match(result.stdout, /working directory comes from the transcript/);
});

test("the adapter exits as soon as a quick codex has finished", async () => {
  const { fake, repo } = setup();
  const doneFile = path.join(makeTempDir(), "done");
  const child = spawnAdapter("task", "go", { env: { ...fake.env, FAKE_CODEX_DONE_FILE: doneFile }, cwd: repo });
  const code = await exitCodeOf(child);
  const exitedAt = Date.now();
  assert.equal(code, 0);
  const done = Number(fs.readFileSync(doneFile, "utf8"));
  // Nothing may hold the adapter open, such as the 2 second stream timer.
  assert.ok(exitedAt - done < 1_500, `the adapter exited ${exitedAt - done} ms after codex`);
});
