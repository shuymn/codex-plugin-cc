import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { main } from "../plugins/codex/scripts/codex-run.ts";
import {
  exitCodeOf,
  type FakeCall,
  type FakeEnv,
  firstLine,
  git,
  makeFakeEnv,
  makeRepo,
  makeTempDir,
  outputLine,
  runRunner,
  spawnRunner,
  waitForFile,
  waitUntilGone,
  writePrompt,
} from "./helpers.ts";

const APPROVALS = ["-c", 'approval_policy="never"', "-c", 'approvals_reviewer="user"'];

function setup(scenario = "ok") {
  const fake = makeFakeEnv({ scenario });
  const repo = makeRepo(fake.env);
  return { fake, repo };
}

function run(fake: FakeEnv, args: readonly string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return runRunner(args, { env: { ...fake.env, ...extraEnv }, cwd });
}

function onlyCall(fake: FakeEnv): FakeCall {
  const calls = fake.readLog();
  assert.equal(calls.length, 1, JSON.stringify(calls));
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.rejected, undefined, call.rejected);
  return call;
}

function optionValue(call: FakeCall, option: string): string | undefined {
  const index = call.argv.indexOf(option);
  return index === -1 ? undefined : call.argv[index + 1];
}

function lines(stdout: string): string[] {
  return stdout.replace(/\n$/, "").split("\n");
}

type LogLine = { run: string; exit: number; changes: number | null; unknown?: string; continued: boolean };

function readRunLog(fake: FakeEnv): LogLine[] {
  const file = path.join(fake.stateDir, "runs.jsonl");
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as LogLine);
}

// H2
test("usage errors exit 2 before anything starts: no codex, no run line, no run directory", () => {
  const { fake, repo } = setup();
  const prompt = writePrompt();
  const blank = writePrompt(" \n\t\n");
  const file = path.join(repo, "README.md");
  const cases: string[][] = [
    [],
    ["--prompt-file", "prompt.md"],
    ["--prompt-file", path.join(repo, "missing.md")],
    ["--prompt-file", repo],
    ["--prompt-file", blank],
    ["--prompt-file", prompt, "--cwd", path.join(repo, "missing")],
    ["--prompt-file", prompt, "--cwd", file],
    ["--prompt-file", prompt, "--write"],
    ["--prompt-file", prompt, "extra"],
    ["--prompt-file", prompt, "-C", repo],
    ["--prompt-file", prompt, "--read-only=yes"],
    ["--prompt-file"],
  ];
  fs.writeFileSync(path.join(repo, "prompt.md"), "relative\n");
  for (const args of cases) {
    const result = run(fake, args, repo);
    assert.equal(result.status, 2, `${JSON.stringify(args)}: ${result.stderr}`);
    assert.match(firstLine(result.stderr), /^codex-run: /);
    assert.equal(result.stdout, "", JSON.stringify(args));
  }
  assert.equal(fake.readLog().length, 0);
  assert.equal(fs.existsSync(path.join(fake.stateDir, "runs")), false);
});

test("--help prints usage and exits 0 without starting codex", () => {
  const { fake, repo } = setup();
  const result = run(fake, ["--help"], repo);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Usage: codex-run --prompt-file/);
  assert.equal(fake.readLog().length, 0);
});

// H3
test("the prompt file's bytes reach codex unchanged, with no text added", () => {
  const { fake, repo } = setup();
  const bytes = Buffer.concat([
    Buffer.from("--read-only \"quoted\" 'single' $(nope)\n\n  indented\r\nlast line without newline "),
    Buffer.from([0xff, 0xfe, 0x00]),
  ]);
  const result = run(fake, ["--prompt-file", writePrompt(bytes)], repo);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(onlyCall(fake).stdin, bytes.toString("base64"));
});

// H4
test("argv: workspace-write with --add-dir <scratch> by default, read-only without it", () => {
  const { fake, repo } = setup();
  const prompt = writePrompt();
  const write = run(fake, ["--prompt-file", prompt], repo);
  assert.equal(write.status, 0, write.stderr);
  const readOnly = run(fake, ["--prompt-file", prompt, "--read-only"], repo);
  assert.equal(readOnly.status, 0, readOnly.stderr);
  const [writeCall, readCall] = fake.readLog();
  assert.ok(writeCall && readCall);
  assert.deepEqual(writeCall.argv.slice(0, 5), [
    "exec",
    "-s",
    "workspace-write",
    "--add-dir",
    outputLine(write.stdout, "scratch"),
  ]);
  assert.deepEqual(writeCall.argv.slice(5, 10), [...APPROVALS, "--skip-git-repo-check"]);
  assert.deepEqual(readCall.argv.slice(0, 8), ["exec", "-s", "read-only", ...APPROVALS, "--skip-git-repo-check"]);
  assert.ok(!readCall.argv.includes("--add-dir"));
  for (const call of [writeCall, readCall]) {
    assert.equal(call.rejected, undefined);
    assert.deepEqual(call.argv.slice(-4, -1), ["--json", "-o", optionValue(call, "-o")]);
    assert.equal(call.argv.at(-1), "-");
    assert.ok(!call.argv.includes("-m"));
    assert.ok(!call.argv.some((arg) => arg.startsWith("model_reasoning_effort")));
  }
});

test("argv: --thread resumes with -s and --add-dir before resume; --model and --effort pass through", () => {
  const { fake, repo } = setup();
  const prompt = writePrompt();
  const first = run(fake, ["--prompt-file", prompt], repo);
  const thread = outputLine(first.stdout, "thread") ?? "";
  for (const sandbox of [[], ["--read-only"]]) {
    const result = run(
      fake,
      ["--prompt-file", prompt, "--thread", thread, "--model", "gpt x", "--effort", "xhigh", ...sandbox],
      repo,
    );
    assert.equal(result.status, 0, result.stderr);
  }
  const [, writeResume, readResume] = fake.readLog();
  assert.ok(writeResume && readResume);
  for (const call of [writeResume, readResume]) {
    assert.equal(call.rejected, undefined, call.rejected);
    const resumeAt = call.argv.indexOf("resume");
    assert.ok(resumeAt > call.argv.indexOf("-s"));
    assert.ok(call.argv.indexOf("--add-dir") < resumeAt);
    assert.deepEqual(call.argv.slice(-2), [thread, "-"]);
    assert.equal(optionValue(call, "-m"), "gpt x");
    assert.ok(call.argv.includes('model_reasoning_effort="xhigh"'));
  }
  assert.ok(writeResume.argv.includes("--add-dir"));
  assert.ok(!readResume.argv.includes("--add-dir"));
});

// H5, H6
test("a successful run prints the short report, and result.md holds the -o bytes", () => {
  const { fake, repo } = setup();
  const message = Buffer.concat([Buffer.from("# Title\n\n"), Buffer.alloc(1024 * 1024, "x"), Buffer.from("\nend")]);
  const messageFile = path.join(makeTempDir(), "message");
  fs.writeFileSync(messageFile, message);
  const actions = [
    { write: "a\nb.txt", content: "newline in the name\n" },
    ...Array.from({ length: 99 }, (_, index) => ({
      write: `files/f${String(index).padStart(3, "0")}.txt`,
      content: "x",
    })),
  ];
  const result = run(fake, ["--prompt-file", writePrompt()], repo, {
    FAKE_CODEX_MESSAGE_FILE: messageFile,
    FAKE_CODEX_ACTIONS: JSON.stringify(actions),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const out = lines(result.stdout);
  assert.ok(out.length <= 8 + 11, out.join("\n"));
  const runId = outputLine(result.stdout, "run");
  assert.equal(out[0], `run: ${runId}`);
  assert.match(out[1] ?? "", /^scratch: \//);
  assert.match(out[2] ?? "", /^thread: [0-9a-f-]{36}$/);
  assert.equal(out[3], "status: ok (exit 0)");
  const resultFile = path.join(fake.stateDir, "runs", runId ?? "", "result.md");
  assert.equal(out[4], `result: ${resultFile}`);
  assert.equal(out[5], `sandbox: workspace-write  cwd: ${repo}`);
  assert.match(out[6] ?? "", new RegExp(`^changes: 100 files \\(baseline [0-9a-f]{40}, paths relative to ${repo}\\)$`));
  assert.equal(out[7], "  A a\\nb.txt");
  assert.equal(out.length, 7 + 11);
  assert.equal(out.at(-1), `  ... full list: ${path.join(path.dirname(resultFile), "changes.txt")}`);
  assert.ok(fs.readFileSync(resultFile).equals(message));
  const listing = fs.readFileSync(path.join(path.dirname(resultFile), "changes.txt"), "utf8").split("\n");
  assert.match(listing[0] ?? "", /^baseline [0-9a-f]{40}$/);
  assert.match(listing[1] ?? "", /^final [0-9a-f]{40}$/);
  assert.equal(listing[2], "A\ta\\nb.txt");
  assert.equal(listing.length, 2 + 100 + 1);

  const [logLine] = readRunLog(fake);
  assert.equal(logLine?.run, runId);
  assert.equal(logLine?.exit, 0);
  assert.equal(logLine?.changes, 100);
  assert.doesNotMatch(JSON.stringify(logLine), /Title|a\\nb|files\//);
});

test("a run that fails before the thread starts prints no thread line and exits 1", () => {
  const { fake, repo } = setup("fail-before-thread");
  const result = run(fake, ["--prompt-file", writePrompt()], repo);
  assert.equal(result.status, 1);
  assert.equal(outputLine(result.stdout, "thread"), undefined);
  assert.equal(outputLine(result.stdout, "result"), undefined);
  assert.equal(outputLine(result.stdout, "status"), "failed (exit 1)");
  assert.equal(outputLine(result.stdout, "changes"), "none");
  assert.equal(firstLine(result.stderr), "codex-run: codex exited with 1: ERROR: could not start the thread");
  assert.equal(readRunLog(fake)[0]?.run, outputLine(result.stdout, "run"));
});

// H6
test("an agent message without an -o file is not a success", () => {
  const { fake, repo } = setup("no-output");
  const result = run(fake, ["--prompt-file", writePrompt()], repo);
  assert.equal(result.status, 1);
  assert.equal(outputLine(result.stdout, "result"), undefined);
  assert.match(firstLine(result.stderr), /without a final message/);
});

// H9
test("--read-only creates no scratch directory and does not check changes", () => {
  const { fake, repo } = setup();
  const result = run(fake, ["--prompt-file", writePrompt(), "--read-only"], repo, {
    FAKE_CODEX_ACTIONS: JSON.stringify([{ write: "new.txt", content: "x" }]),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(outputLine(result.stdout, "scratch"), undefined);
  assert.equal(outputLine(result.stdout, "sandbox"), `read-only  cwd: ${repo}`);
  assert.equal(outputLine(result.stdout, "changes"), "not checked: read-only");
  assert.deepEqual(fs.readdirSync(fake.tmp), []);
});

// H10
test("a failed codex with changes still exits 1 and lists the changes", () => {
  const { fake, repo } = setup("exit-nonzero");
  const result = run(fake, ["--prompt-file", writePrompt()], repo, {
    FAKE_CODEX_ACTIONS: JSON.stringify([{ write: "README.md", content: "changed\n" }]),
  });
  assert.equal(result.status, 1);
  assert.match(outputLine(result.stdout, "changes") ?? "", /^1 files \(baseline /);
  assert.match(result.stdout, /\n {2}M README\.md\n/);
  const stderr = result.stderr.trimEnd().split("\n");
  assert.equal(stderr[0], "codex-run: codex exited with 1: ERROR: boom");
  assert.deepEqual(stderr.slice(1), ["log line", "ERROR: boom"]);
});

test("a stopped run stops codex, reports the changes as interrupted, deletes the scratch directory, and exits 143", async () => {
  const { fake, repo } = setup("slow");
  const ready = path.join(makeTempDir(), "ready");
  const child = spawnRunner(["--prompt-file", writePrompt()], {
    env: { ...fake.env, FAKE_CODEX_READY_FILE: ready },
    cwd: repo,
  });
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  const exited = exitCodeOf(child);
  const codexPid = Number(await waitForFile(ready));
  // The thread line comes as soon as codex reports it.
  const deadline = Date.now() + 10_000;
  while (outputLine(stdout, "thread") === undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  child.kill("SIGTERM");
  assert.equal(await exited, 143);
  assert.ok(await waitUntilGone(codexPid));
  assert.deepEqual(
    fake
      .readLog()
      .filter((call) => call.signal)
      .map((call) => call.signal),
    ["SIGINT"],
  );
  assert.equal(outputLine(stdout, "status"), "interrupted (exit 143)");
  assert.match(outputLine(stdout, "thread") ?? "", /^[0-9a-f-]{36}$/);
  assert.match(outputLine(stdout, "changes") ?? "", /^unknown: interrupted \(baseline [0-9a-f]{40}\)$/);
  assert.equal(outputLine(stdout, "scratch left"), undefined);
  assert.deepEqual(fs.readdirSync(fake.tmp), []);
  assert.equal(readRunLog(fake)[0]?.unknown, "interrupted");
});

test("a process group that cannot be confirmed gone exits 1 even after a signal, and leaves the scratch directory", async () => {
  const fake = makeFakeEnv({ scenario: "slow" });
  const repo = makeRepo(fake.env);
  const ready = path.join(makeTempDir(), "ready");
  const saved = { ...process.env };
  process.env = { ...fake.env, FAKE_CODEX_READY_FILE: ready };
  let stdout = "";
  let stderr = "";
  let codexPid = 0;
  try {
    const running = main(["--prompt-file", writePrompt(), "--cwd", repo], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      stopTiming: {
        interruptGraceMs: 50,
        terminateGraceMs: 50,
        reapGraceMs: 200,
        // The group looks alive and cannot be signaled, as with EPERM.
        kill: (pid, signal) => {
          void pid;
          if (signal !== 0) {
            throw Object.assign(new Error("kill failed: EPERM"), { code: "EPERM" });
          }
        },
      },
    });
    codexPid = Number(await waitForFile(ready));
    process.kill(process.pid, "SIGTERM");
    assert.equal(await running, 1);
  } finally {
    process.env = saved;
    if (codexPid) {
      process.kill(codexPid, "SIGKILL");
    }
  }
  assert.ok(await waitUntilGone(codexPid));
  assert.match(firstLine(stderr), /^codex-run: could not signal the Codex process group .*EPERM/);
  assert.equal(outputLine(stdout, "status"), "failed (exit 1)");
  assert.match(outputLine(stdout, "changes") ?? "", /^unknown: Codex processes may still be running \(baseline /);
  const scratch = outputLine(stdout, "scratch");
  assert.ok(scratch);
  assert.equal(outputLine(stdout, "scratch left"), scratch);
  assert.ok(fs.existsSync(scratch));
  assert.equal(readRunLog(fake)[0]?.unknown, "reap-error");
});

// H11
test("a missing codex exits 3 before the run starts", () => {
  const fake = makeFakeEnv({ codex: false });
  const repo = makeRepo(fake.env);
  const result = run(fake, ["--prompt-file", writePrompt()], repo);
  assert.equal(result.status, 3, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(firstLine(result.stderr), "codex-run: codex was not found on PATH.");
  assert.equal(fs.existsSync(path.join(fake.stateDir, "runs")), false);
});

test("a failed turn is summarized from turn.failed, and an empty final message exits 1", () => {
  const failed = setup("turn-failed");
  const result = run(failed.fake, ["--prompt-file", writePrompt()], failed.repo);
  assert.equal(result.status, 1);
  assert.equal(firstLine(result.stderr), "codex-run: codex exited with 1: model overloaded");

  const empty = setup("empty-output");
  const emptyResult = run(empty.fake, ["--prompt-file", writePrompt()], empty.repo);
  assert.equal(emptyResult.status, 1);
  assert.match(firstLine(emptyResult.stderr), /without a final message/);
});

test("an error item with exit 0 is still a success", () => {
  const { fake, repo } = setup("warning-item");
  assert.equal(run(fake, ["--prompt-file", writePrompt()], repo).status, 0);
});

test("a codex that exits before reading a large prompt does not crash the runner", () => {
  const { fake, repo } = setup("early-exit");
  const result = run(fake, ["--prompt-file", writePrompt(`go ${"x".repeat(4 * 1024 * 1024)}`)], repo);
  assert.equal(result.status, 1);
  assert.match(firstLine(result.stderr), /^codex-run: codex exited with 1/);
});

test("a failure to record the thread stops codex and exits 1", { timeout: 60_000 }, async () => {
  const { fake, repo } = setup("slow");
  const threads = path.join(fake.stateDir, "threads");
  fs.mkdirSync(threads, { recursive: true });
  fs.chmodSync(threads, 0o500);
  try {
    const ready = path.join(makeTempDir(), "ready");
    const child = spawnRunner(["--prompt-file", writePrompt()], {
      env: { ...fake.env, FAKE_CODEX_READY_FILE: ready },
      cwd: repo,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    assert.equal(await exitCodeOf(child), 1);
    assert.match(firstLine(stderr), /^codex-run: could not record the Codex thread/);
    assert.match(outputLine(stdout, "thread") ?? "", /^[0-9a-f-]{36}$/);
    const codexPid = Number(await waitForFile(ready));
    assert.ok(await waitUntilGone(codexPid), "codex is still running");
    assert.deepEqual(fs.readdirSync(fake.tmp), []);
  } finally {
    fs.chmodSync(threads, 0o700);
  }
});

test("the stop ladder reaches a Codex binary behind a launcher that ignores SIGINT", { timeout: 60_000 }, async () => {
  const { fake, repo } = setup("launcher");
  const ready = path.join(makeTempDir(), "ready");
  const child = spawnRunner(["--prompt-file", writePrompt()], {
    env: { ...fake.env, FAKE_CODEX_READY_FILE: ready },
    cwd: repo,
  });
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
  for (const signal of binarySignals.slice(0, -1)) {
    assert.deepEqual(signal, ["SIGINT", true]);
  }
  assert.ok(Date.now() - started >= 9_000);
  assert.ok(await waitUntilGone(binaryPid), "the Codex binary is still running");
  assert.ok(await waitUntilGone(launcher.pid), "the launcher is still running");
  assert.deepEqual(fs.readdirSync(fake.tmp), []);
});

test("the runner exits as soon as a quick codex has finished", async () => {
  const { fake, repo } = setup();
  const doneFile = path.join(makeTempDir(), "done");
  const child = spawnRunner(["--prompt-file", writePrompt(), "--read-only"], {
    env: { ...fake.env, FAKE_CODEX_DONE_FILE: doneFile },
    cwd: repo,
  });
  const code = await exitCodeOf(child);
  const exitedAt = Date.now();
  assert.equal(code, 0);
  const done = Number(fs.readFileSync(doneFile, "utf8"));
  // Nothing may hold the runner open, such as the 2 second stream timer.
  assert.ok(exitedAt - done < 1_500, `the runner exited ${exitedAt - done} ms after codex`);
});

// H12
test("codex gets the scratch directory as TMPDIR, without the caller's GIT_DIR and GIT_WORK_TREE, and the scratch directory is deleted", () => {
  const { fake, repo } = setup();
  const worktree = path.join(makeTempDir(), "wt");
  git(repo, ["worktree", "add", "-q", "-b", "wt", worktree], fake.env);
  const other = makeRepo(fake.env);
  const result = run(fake, ["--prompt-file", writePrompt(), "--cwd", worktree], other, {
    GIT_DIR: path.join(other, ".git"),
    GIT_WORK_TREE: other,
    FAKE_CODEX_PROBE: "1",
    FAKE_CODEX_ACTIONS: JSON.stringify([{ write: "made-in-worktree.txt", content: "x" }]),
  });
  assert.equal(result.status, 0, result.stderr);
  const call = onlyCall(fake);
  const scratch = outputLine(result.stdout, "scratch");
  assert.ok(scratch);
  assert.equal(call.env?.TMPDIR, scratch);
  assert.equal(call.env?.GIT_DIR, undefined);
  assert.equal(call.env?.GIT_WORK_TREE, undefined);
  assert.ok(call.probe?.startsWith(`${scratch}${path.sep}`));
  assert.equal(fs.existsSync(scratch), false);
  assert.equal(outputLine(result.stdout, "scratch left"), undefined);
  assert.equal(call.cwd, worktree);
  // The workspace root and the snapshot come from --cwd, not from GIT_WORK_TREE.
  assert.match(
    outputLine(result.stdout, "changes") ?? "",
    new RegExp(`^1 files \\(baseline [0-9a-f]{40}, paths relative to ${fs.realpathSync(worktree)}\\)$`),
  );
  assert.match(result.stdout, /\n {2}A made-in-worktree\.txt\n/);
});
