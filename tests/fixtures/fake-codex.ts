// Stand-in for the Codex CLI in tests. It validates the argv shape the way the
// real parser would (including which options may follow a subcommand), records
// every call as one JSON line in FAKE_CODEX_LOG, and plays a scenario chosen
// by FAKE_CODEX_SCENARIO.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const scenario = process.env.FAKE_CODEX_SCENARIO ?? "ok";
const logPath = process.env.FAKE_CODEX_LOG;
const argv = process.argv.slice(2);

type ExecCall = {
  sandbox: string | null;
  subcommand: "resume" | null;
  outputFile: string | null;
  resumeId: string | null;
};

function log(entry: Record<string, unknown>): void {
  if (logPath) {
    fs.appendFileSync(
      logPath,
      `${JSON.stringify({ argv, cwd: process.cwd(), scenario, pid: process.pid, ...entry })}\n`,
    );
  }
}

function reject(reason: string): never {
  log({ rejected: reason });
  process.stderr.write(`fake-codex: unexpected argv (${reason}): ${JSON.stringify(argv)}\n`);
  process.exit(2);
}

// Options shared by every exec level (global = true in the real CLI).
const GLOBAL_VALUE_OPTIONS = new Set(["-c", "-m", "-o"]);
const GLOBAL_FLAGS = new Set(["--json", "--skip-git-repo-check"]);
// Options the real CLI accepts only before the subcommand.
const TOP_LEVEL_VALUE_OPTIONS = new Set(["-s", "--add-dir"]);

function parseExec(args: readonly string[]): ExecCall {
  const call: ExecCall = { sandbox: null, subcommand: null, outputFile: null, resumeId: null };
  const seen = new Set<string>();
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const takeValue = (): string => {
      const value = args[index + 1];
      if (value === undefined) {
        reject(`missing value for ${arg}`);
      }
      index += 1;
      return value;
    };

    if (positionals.length === 0 && call.subcommand === null && arg === "resume") {
      call.subcommand = arg;
      continue;
    }
    if (TOP_LEVEL_VALUE_OPTIONS.has(arg)) {
      if (call.subcommand !== null) {
        reject(`${arg} after the ${call.subcommand} subcommand`);
      }
      // --add-dir may repeat; its value is only checked to be there.
      if (arg === "--add-dir") {
        takeValue();
        continue;
      }
      if (seen.has(arg)) {
        reject(`duplicate ${arg}`);
      }
      seen.add(arg);
      call.sandbox = takeValue();
      if (!["read-only", "workspace-write"].includes(call.sandbox)) {
        reject(`sandbox ${call.sandbox}`);
      }
      continue;
    }
    if (GLOBAL_VALUE_OPTIONS.has(arg)) {
      const value = takeValue();
      // -c may repeat; its value is only skipped here.
      if (arg === "-c") {
        continue;
      }
      if (seen.has(arg)) {
        reject(`duplicate ${arg}`);
      }
      seen.add(arg);
      if (arg === "-o") {
        call.outputFile = value;
      }
      continue;
    }
    if (GLOBAL_FLAGS.has(arg)) {
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      reject(`unknown option ${arg}`);
    }
    positionals.push(arg);
  }

  if (call.sandbox === null) {
    reject("missing -s");
  }
  if (call.subcommand === "resume") {
    if (positionals.length !== 2 || positionals[1] !== "-") {
      reject("resume needs <id> -");
    }
    call.resumeId = positionals[0] ?? null;
  } else if (positionals.length !== 1 || positionals[0] !== "-") {
    reject("exec needs - as the prompt");
  }
  return call;
}

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function finalText(): Buffer {
  if (process.env.FAKE_CODEX_MESSAGE_FILE !== undefined) {
    return fs.readFileSync(process.env.FAKE_CODEX_MESSAGE_FILE);
  }
  return Buffer.from(process.env.FAKE_CODEX_MESSAGE ?? "Fake final message.");
}

// Edits to the working tree, relative to the cwd, applied in order:
// FAKE_CODEX_ACTIONS='[{"write":"a.txt","content":"x"},{"delete":"b.txt"}]'.
type Action = { write?: string; content?: string; delete?: string };

function applyActions(): void {
  const actions = JSON.parse(process.env.FAKE_CODEX_ACTIONS ?? "[]") as Action[];
  for (const action of actions) {
    if (action.write !== undefined) {
      fs.mkdirSync(path.dirname(path.resolve(action.write)), { recursive: true });
      fs.writeFileSync(action.write, action.content ?? "");
    } else if (action.delete !== undefined) {
      fs.rmSync(action.delete);
    }
  }
}

// What a probe would report: TMPDIR and the Git variables Codex received.
function codexEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if ((key === "TMPDIR" || key.startsWith("GIT_")) && value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

// Leaves a file in $TMPDIR without cleaning up, like a probe script.
function writeProbe(): string | undefined {
  if (process.env.FAKE_CODEX_PROBE !== "1" || !process.env.TMPDIR) {
    return undefined;
  }
  const dir = path.join(process.env.TMPDIR, "probe");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "probe.sh");
  fs.writeFileSync(file, "echo probe\n");
  return file;
}

// Leaves a directory in $TMPDIR that the runner cannot delete: a file in a
// directory without write permission. The test restores the permission.
function lockScratch(): void {
  if (process.env.FAKE_CODEX_LOCK_SCRATCH !== "1" || !process.env.TMPDIR) {
    return;
  }
  const dir = path.join(process.env.TMPDIR, "locked");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "file"), "x");
  fs.chmodSync(dir, 0o500);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  // Base64, so the test can compare the bytes exactly.
  return Buffer.concat(chunks).toString("base64");
}

async function runExec(call: ExecCall): Promise<void> {
  if (scenario === "early-exit") {
    log({ stdin: null });
    process.stderr.write("fake-codex: exiting before reading stdin\n");
    process.exit(1);
  }
  const stdin = await readStdin();
  const probe = writeProbe();
  lockScratch();
  log({ stdin, env: codexEnv(), ...(probe === undefined ? {} : { probe }) });
  applyActions();

  const threadId = call.resumeId ?? randomUUID();
  if (scenario === "fail-before-thread") {
    process.stderr.write("ERROR: could not start the thread\n");
    process.exit(1);
  }
  if (scenario === "escape") {
    // Leaves a grandchild in its own process group that keeps stdout and
    // stderr open for a few seconds, then ends on the first signal.
    const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
      detached: true,
      stdio: ["ignore", "inherit", "inherit"],
    });
    process.on("SIGINT", () => process.exit(130));
    process.on("SIGTERM", () => process.exit(143));
    if (process.env.FAKE_CODEX_READY_FILE) {
      fs.writeFileSync(process.env.FAKE_CODEX_READY_FILE, `${process.pid} ${grandchild.pid ?? 0}`);
    }
    setInterval(() => {}, 1000);
    return;
  }
  if (scenario === "slow" || scenario === "ignore-sigint") {
    // `slow` ends on the first signal; `ignore-sigint` behaves like a Codex
    // binary that keeps running after SIGINT and only stops on SIGTERM. The
    // handlers and the ready file come before thread.started, because the
    // runner may stop the run as soon as it sees that event.
    const onSignal = (signal: NodeJS.Signals): void => {
      if (scenario === "ignore-sigint" && signal === "SIGINT") {
        log({ signal, ignored: true });
        return;
      }
      log({ signal });
      process.exit(signal === "SIGINT" ? 130 : 143);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    if (process.env.FAKE_CODEX_READY_FILE) {
      fs.writeFileSync(process.env.FAKE_CODEX_READY_FILE, String(process.pid));
    }
    emit({ type: "thread.started", thread_id: threadId });
    emit({ type: "turn.started" });
    setInterval(() => {}, 1000);
    return;
  }
  emit({ type: "thread.started", thread_id: threadId });
  emit({ type: "turn.started" });
  if (scenario === "exit-nonzero") {
    process.stderr.write(
      "WARNING: proceeding, even though we could not create PATH aliases: noise\nlog line\nERROR: boom\n",
    );
    process.exit(1);
  }
  if (scenario === "turn-failed") {
    emit({ type: "error", message: "Reconnecting... 1/5" });
    emit({ type: "turn.failed", error: { message: "model overloaded" } });
    process.stderr.write("turn failed\n");
    process.exit(1);
  }
  if (scenario === "warning-item") {
    emit({ type: "item.completed", item: { id: "w1", type: "error", message: "under-development feature warning" } });
  }

  if (scenario === "output-dir") {
    // A directory, not a file, at the -o path.
    if (call.outputFile) {
      fs.mkdirSync(call.outputFile);
    }
  } else if (scenario === "empty-output") {
    if (call.outputFile) {
      fs.writeFileSync(call.outputFile, "");
    }
  } else {
    const text = finalText();
    emit({ type: "item.completed", item: { id: "m1", type: "agent_message", text: text.toString("utf8") } });
    // no-output: an agent message without an -o file.
    if (call.outputFile && scenario !== "no-output") {
      fs.writeFileSync(call.outputFile, text);
    }
  }
  emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
  if (process.env.FAKE_CODEX_DONE_FILE) {
    fs.writeFileSync(process.env.FAKE_CODEX_DONE_FILE, String(Date.now()));
  }
}

// Like the npm launcher of the real CLI: runs the actual binary as a child,
// forwards signals only while the child has not been signaled yet, and
// mirrors the child's exit.
function runLauncher(): void {
  const child = spawn(process.execPath, [process.argv[1] ?? "", ...argv], {
    stdio: "inherit",
    env: { ...process.env, FAKE_CODEX_SCENARIO: "ignore-sigint" },
  });
  log({ launcher: true });
  const forward = (signal: NodeJS.Signals): void => {
    if (!child.killed) {
      child.kill(signal);
    }
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => forward(signal));
  }
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 1);
    }
  });
}

if (argv[0] !== "exec") {
  reject("unknown command");
}
const call = parseExec(argv.slice(1));
if (scenario === "launcher") {
  runLauncher();
} else {
  await runExec(call);
}
