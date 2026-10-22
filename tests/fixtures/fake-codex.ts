// Stand-in for the Codex CLI in tests. It validates the argv shape the way the
// real parser would (including which options may follow a subcommand), records
// every call as one JSON line in FAKE_CODEX_LOG, and plays a scenario chosen
// by FAKE_CODEX_SCENARIO.

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const scenario = process.env.FAKE_CODEX_SCENARIO ?? "ok";
const logPath = process.env.FAKE_CODEX_LOG;
const argv = process.argv.slice(2);

type ExecCall = {
  sandbox: string | null;
  subcommand: "review" | "resume" | null;
  outputFile: string | null;
  outputSchema: string | null;
  resumeId: string | null;
  readsStdin: boolean;
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
const GLOBAL_VALUE_OPTIONS = new Set(["-c", "-m", "-o", "--output-schema"]);
const GLOBAL_FLAGS = new Set(["--json", "--ephemeral", "--skip-git-repo-check"]);
// Options the real CLI accepts only before the subcommand.
const TOP_LEVEL_VALUE_OPTIONS = new Set(["-s"]);

function parseExec(args: readonly string[]): ExecCall {
  const call: ExecCall = {
    sandbox: null,
    subcommand: null,
    outputFile: null,
    outputSchema: null,
    resumeId: null,
    readsStdin: false,
  };
  const seen = new Set<string>();
  let reviewTarget: string | null = null;
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

    if (positionals.length === 0 && call.subcommand === null && (arg === "review" || arg === "resume")) {
      call.subcommand = arg;
      continue;
    }
    if (TOP_LEVEL_VALUE_OPTIONS.has(arg)) {
      if (call.subcommand !== null) {
        reject(`${arg} after the ${call.subcommand} subcommand`);
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
      } else if (arg === "--output-schema") {
        call.outputSchema = value;
      }
      continue;
    }
    if (GLOBAL_FLAGS.has(arg)) {
      continue;
    }
    if (call.subcommand === "review" && (arg === "--uncommitted" || arg === "--base")) {
      if (reviewTarget !== null) {
        reject("more than one review target");
      }
      reviewTarget = arg === "--base" ? takeValue() : arg;
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
  if (call.subcommand === "review") {
    if (reviewTarget === null || positionals.length > 0) {
      reject("review needs exactly one target and no prompt");
    }
  } else if (call.subcommand === "resume") {
    if (positionals.length !== 2 || positionals[1] !== "-") {
      reject("resume needs <id> -");
    }
    call.resumeId = positionals[0] ?? null;
    call.readsStdin = true;
  } else {
    if (positionals.length !== 1 || positionals[0] !== "-") {
      reject("exec needs - as the prompt");
    }
    call.readsStdin = true;
  }
  return call;
}

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const VALID_REVIEW = {
  verdict: "needs-attention",
  summary: "Do not ship yet.",
  findings: [
    {
      severity: "low",
      title: "Minor gap",
      body: "Low severity body.",
      file: "src/b.ts",
      line_start: 3,
      line_end: 3,
      confidence: 0.4,
      recommendation: "",
    },
    {
      severity: "critical",
      title: "Data loss",
      body: "Writes can be lost.",
      file: "src/a.ts",
      line_start: 10,
      line_end: 12,
      confidence: 0.9,
      recommendation: "Write atomically.",
    },
  ],
  next_steps: ["Fix the write path."],
};

function finalText(call: ExecCall): string {
  if (process.env.FAKE_CODEX_MESSAGE !== undefined) {
    return process.env.FAKE_CODEX_MESSAGE;
  }
  if (scenario === "bad-json") {
    return "this is not JSON {";
  }
  if (scenario === "schema-violation") {
    return JSON.stringify({ ...VALID_REVIEW, extra: true });
  }
  if (call.outputSchema !== null) {
    return JSON.stringify(VALID_REVIEW);
  }
  return call.subcommand === "review" ? "Review body from Codex.\n" : "Fake final message.";
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function runExec(call: ExecCall): Promise<void> {
  if (scenario === "early-exit") {
    log({ stdin: null });
    process.stderr.write("fake-codex: exiting before reading stdin\n");
    process.exit(1);
  }
  const stdin = call.readsStdin ? await readStdin() : "";
  log({ stdin });

  const threadId = call.resumeId ?? randomUUID();
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
    // adapter may stop the run as soon as it sees that event.
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
    process.stderr.write("WARNING: proceeding, even though we could not update PATH: noise\nlog line\nERROR: boom\n");
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

  if (scenario === "empty-output") {
    if (call.outputFile) {
      fs.writeFileSync(call.outputFile, "");
    }
  } else {
    const text = finalText(call);
    emit({ type: "item.completed", item: { id: "m1", type: "agent_message", text } });
    if (call.outputFile) {
      fs.writeFileSync(call.outputFile, text);
    }
  }
  emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
  if (process.env.FAKE_CODEX_DONE_FILE) {
    fs.writeFileSync(process.env.FAKE_CODEX_DONE_FILE, String(Date.now()));
  }
}

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: { migrationItems: { details: { sessions: { path: string }[] } }[] };
  error?: unknown;
};

// Mirrors the real importer: a Claude transcript is importable only when a
// record carries a cwd and there is at least one user message.
function isImportable(sourcePath: string): boolean {
  let hasCwd = false;
  let hasUserMessage = false;
  for (const line of fs.readFileSync(sourcePath, "utf8").split("\n")) {
    try {
      const record = JSON.parse(line) as { type?: string; cwd?: unknown; message?: unknown };
      hasCwd ||= typeof record.cwd === "string";
      hasUserMessage ||= record.type === "user" && record.message !== undefined;
    } catch {
      // The real importer skips lines that are not JSON.
    }
  }
  return hasCwd && hasUserMessage;
}

function writeLedger(sourcePath: string): void {
  if (scenario === "transfer-no-ledger" || !isImportable(sourcePath)) {
    return;
  }
  const codexHome = process.env.CODEX_HOME ?? "";
  const sha = createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, "external_agent_session_imports.json"),
    JSON.stringify({
      records: [{ source_path: sourcePath, content_sha256: sha, imported_thread_id: randomUUID(), imported_at: 1 }],
    }),
  );
}

function runAppServer(): void {
  log({ stdin: null });
  const stubborn = scenario === "transfer-stubborn";
  // Stays alive after stdin closes and on SIGINT and SIGTERM, so only SIGKILL ends it.
  if (stubborn) {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => log({ signal, ignored: true }));
    }
    setInterval(() => {}, 1000);
  } else {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => {
        log({ signal });
        process.exit(signal === "SIGINT" ? 130 : 143);
      });
    }
  }
  // Ready only once the signal handlers are in place.
  if (process.env.FAKE_CODEX_READY_FILE) {
    fs.writeFileSync(process.env.FAKE_CODEX_READY_FILE, String(process.pid));
  }
  const lines = readline.createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const message = JSON.parse(line) as RpcMessage;
    log({ rpc: message });
    // Alive but silent: never answers anything.
    if (scenario === "transfer-hang" || stubborn) {
      return;
    }
    if (message.method === "initialize") {
      send({ id: message.id, result: { userAgent: "fake" } });
      return;
    }
    if (message.method !== "externalAgentConfig/import") {
      return;
    }
    if (scenario === "transfer-unsupported") {
      send({ id: message.id, error: { code: -32601, message: "method not found" } });
      return;
    }
    const sourcePath = message.params?.migrationItems[0]?.details.sessions[0]?.path ?? "";
    // A server request the client must refuse, a completion for some other
    // import, and the response. The matching completion, and the ledger that
    // goes with it, come only later, so a client that stops waiting at the
    // first completion finds no ledger.
    send({ id: "server-1", method: "item/tool/requestUserInput", params: {} });
    send({ method: "externalAgentConfig/import/completed", params: { importId: "other", itemTypeResults: [] } });
    log({ completed: "other" });
    send({ id: message.id, result: { importId: "import-1" } });
    setTimeout(() => {
      writeLedger(sourcePath);
      log({ completed: "import-1" });
      send({ method: "externalAgentConfig/import/completed", params: { importId: "import-1", itemTypeResults: [] } });
    }, 300);
  });
  lines.on("close", () => {
    log({ appServerClosed: true });
    if (!stubborn) {
      process.exit(0);
    }
  });
}

// Like the npm launcher of the real CLI: runs the actual binary as a child,
// forwards signals only while the child has not been signaled yet, and
// mirrors the child's exit.
function runLauncher(): void {
  const child = spawn(process.execPath, [process.argv[1] ?? "", ...argv], {
    stdio: "inherit",
    env: { ...process.env, FAKE_CODEX_SCENARIO: "ignore-sigint" },
  });
  log({ launcher: true, childPid: child.pid });
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

async function main(): Promise<void> {
  // Simulates a slow start, before anything else happens.
  const startupDelayMs = Number(process.env.FAKE_CODEX_STARTUP_DELAY_MS ?? "0");
  if (startupDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, startupDelayMs));
  }
  if (argv.length === 1 && argv[0] === "--version") {
    log({});
    process.stdout.write("codex-cli 0.0.0-fake\n");
    return;
  }
  if (argv.length === 2 && argv[0] === "login" && argv[1] === "status") {
    log({});
    if (scenario === "logged-out") {
      process.stderr.write("Not logged in\n");
      process.exit(1);
    }
    process.stderr.write("Logged in using ChatGPT\n");
    return;
  }
  if (argv.length === 1 && argv[0] === "app-server") {
    runAppServer();
    return;
  }
  if (argv[0] === "exec") {
    const call = parseExec(argv.slice(1));
    if (scenario === "launcher") {
      runLauncher();
      return;
    }
    await runExec(call);
    return;
  }
  reject("unknown command");
}

await main();
