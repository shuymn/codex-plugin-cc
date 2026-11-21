// codex-run: runs one Codex turn for a calling agent. See USAGE below and
// docs/design/codex-runner.md. bin/codex-run execs this file.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  type ChangeReport,
  compareTrees,
  formatChanges,
  snapshotProblem,
  type TimedSnapshot,
  timedSnapshot,
} from "./lib/changes.ts";
import {
  APPROVAL_OVERRIDES,
  CodexNotFoundError,
  type CodexRunResult,
  cleanCodexStderr,
  failureReason,
  modelArgs,
  runCodex,
  signalExitCode,
} from "./lib/codex-exec.ts";
import { escapeLine } from "./lib/escape.ts";
import { GitError, gitCommonDir, gitEnv, resolveWorkspaceRoot } from "./lib/git.ts";
import type { StopTiming } from "./lib/process-group.ts";
import { appendRunLog, createRunDir, newRunId, pruneRunDirs, type RunLogEntry } from "./lib/runs.ts";
import { createScratch, removeScratch, type Scratch } from "./lib/scratch.ts";
import { checkThread, recordThread, ThreadRefusedError } from "./lib/thread-store.ts";

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_CODEX_NOT_FOUND = 3;

const USAGE = `Usage: codex-run --prompt-file <absolute file> [--cwd <dir>] [--read-only] [--thread <id>]
                 [--model <model>] [--effort <effort>]
       codex-run --help

Runs one Codex turn with the file's text as the prompt, unchanged.

Options:
  --prompt-file <file>  The prompt, as an absolute path. Required.
  --cwd <dir>           Codex's working directory. Default: the current directory.
  --read-only           Run Codex read-only. Default: workspace-write.
  --thread <id>         Continue a thread codex-run started in the same repository.
  --model <model>       Pass -m <model> to Codex.
  --effort <effort>     Pass model_reasoning_effort to Codex.
  --help                Show this help.

Output (stdout):
  run: <id>                    always first
  scratch: <dir>               write-capable runs: Codex's TMPDIR, deleted afterwards
  thread: <id>                 once Codex reports the thread
  status: ok|failed|interrupted (exit <n>)
  result: <file>               Codex's final message, on exit 0 only
  sandbox: <mode>  cwd: <dir>
  changes: none | <n> files (...) | unknown: <reason> | not checked: read-only
  scratch left: <dir>          when the scratch directory was not deleted
Output without a status: line, or a write-capable run without a changes:
line, is incomplete.

Exit codes: 0 ok, 1 Codex failed or ended without a final message, 2 usage
error or refused --thread, 3 codex not on PATH, 128+n stopped by signal n.
`;

class UsageError extends Error {}

// Seams for in-process tests; the executable passes only the streams.
export type RunnerIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  stopTiming?: StopTiming;
};

type Request = {
  prompt: Buffer;
  cwd: string;
  readOnly: boolean;
  thread: string | null;
  model: string | undefined;
  effort: string | undefined;
};

function parseRequest(argv: string[]): Request | "help" {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        "prompt-file": { type: "string" },
        cwd: { type: "string" },
        "read-only": { type: "boolean" },
        thread: { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
        help: { type: "boolean" },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values } = parsed;
  if (values.help === true) {
    return "help";
  }

  const promptFile = values["prompt-file"];
  if (promptFile === undefined) {
    throw new UsageError("--prompt-file is required.");
  }
  if (!path.isAbsolute(promptFile)) {
    throw new UsageError(`--prompt-file must be an absolute path: ${escapeLine(promptFile)}`);
  }
  let prompt: Buffer;
  try {
    prompt = fs.readFileSync(promptFile);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
    throw new UsageError(`cannot read --prompt-file ${escapeLine(promptFile)} (${code})`);
  }
  if (prompt.toString("utf8").trim() === "") {
    throw new UsageError(`--prompt-file is blank: ${escapeLine(promptFile)}`);
  }

  const cwd = path.resolve(process.cwd(), values.cwd ?? ".");
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(cwd).isDirectory();
  } catch {
    // Reported below.
  }
  if (!isDirectory) {
    throw new UsageError(`--cwd is not a directory: ${escapeLine(cwd)}`);
  }

  return {
    prompt,
    cwd,
    readOnly: values["read-only"] === true,
    thread: values.thread ?? null,
    model: values.model,
    effort: values.effort,
  };
}

// A lookup only, so a missing codex is reported before the run starts.
function isOnPath(command: string): boolean {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, command);
    try {
      if (fs.statSync(candidate).isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      }
    } catch {
      // Not here.
    }
  }
  return false;
}

function codexArgs(request: Request, scratch: Scratch | null, resultFile: string): string[] {
  // Options of `codex exec` go before `resume`: the CLI rejects -s and
  // --add-dir after it.
  const runArgs = [
    ...modelArgs({
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.effort === undefined ? {} : { effort: request.effort }),
    }),
    "--json",
    "-o",
    resultFile,
  ];
  return [
    "exec",
    "-s",
    request.readOnly ? "read-only" : "workspace-write",
    ...(scratch === null ? [] : ["--add-dir", scratch.path]),
    ...APPROVAL_OVERRIDES,
    "--skip-git-repo-check",
    ...(request.thread === null ? [...runArgs, "-"] : ["resume", ...runArgs, request.thread, "-"]),
  ];
}

function hasFinalMessage(resultFile: string): boolean {
  try {
    return fs.readFileSync(resultFile, "utf8").trim() !== "";
  } catch {
    return false;
  }
}

type Outcome = { exit: number; summary: string | null; detail: string };

// The exit code and the stderr summary. A group that could not be confirmed
// gone takes precedence over a signal.
function outcomeOf(result: CodexRunResult, resultFile: string): Outcome {
  const tail = cleanCodexStderr(result.stderr);
  if (result.reapError !== null) {
    return { exit: EXIT_FAILED, summary: result.reapError, detail: tail };
  }
  if (result.receivedSignal !== null) {
    return { exit: signalExitCode(result.receivedSignal), summary: null, detail: "" };
  }
  if (result.callbackError !== null) {
    return {
      exit: EXIT_FAILED,
      summary: `could not record the Codex thread, so Codex was stopped: ${result.callbackError.message}`,
      detail: tail,
    };
  }
  if (result.exitCode !== 0) {
    const reason = failureReason(result);
    const status = result.exitCode === null ? `signal ${result.exitSignal ?? "unknown"}` : String(result.exitCode);
    return { exit: EXIT_FAILED, summary: `codex exited with ${status}${reason ? `: ${reason}` : ""}`, detail: tail };
  }
  if (!hasFinalMessage(resultFile)) {
    return { exit: EXIT_FAILED, summary: "codex finished without a final message.", detail: tail };
  }
  return { exit: EXIT_OK, summary: null, detail: "" };
}

function statusWord(exit: number): string {
  if (exit === EXIT_OK) {
    return "ok";
  }
  return exit > 128 ? "interrupted" : "failed";
}

function oneLine(text: string): string {
  return text.replaceAll(/\s*\n\s*/g, " ").trim();
}

function failUsage(io: RunnerIo, message: string, exit: number): number {
  io.stderr(`codex-run: ${oneLine(message)}\n`);
  return exit;
}

type Prepared = { request: Request; workspaceRoot: string; repo: string | null };

// Everything that may refuse the run before it starts. Returns the exit code
// when the run ends here.
function prepare(argv: string[], io: RunnerIo): Prepared | number {
  try {
    const request = parseRequest(argv);
    if (request === "help") {
      io.stdout(USAGE);
      return EXIT_OK;
    }
    // Resolved before Codex starts: the thread record needs both, and a Git
    // failure inside the thread-started callback would stop a running turn.
    const workspaceRoot = resolveWorkspaceRoot(request.cwd);
    const repo = gitCommonDir(request.cwd);
    if (request.thread !== null) {
      checkThread(request.thread, workspaceRoot, repo);
    }
    if (!isOnPath("codex")) {
      return failUsage(io, "codex was not found on PATH.", EXIT_CODEX_NOT_FOUND);
    }
    return { request, workspaceRoot, repo };
  } catch (error) {
    if (error instanceof UsageError || error instanceof ThreadRefusedError) {
      return failUsage(
        io,
        `${error.message}${error instanceof UsageError ? " See codex-run --help." : ""}`,
        EXIT_USAGE,
      );
    }
    if (error instanceof GitError) {
      return failUsage(io, error.message, EXIT_FAILED);
    }
    throw error;
  }
}

export async function main(argv: string[], io: RunnerIo): Promise<number> {
  const prepared = prepare(argv, io);
  if (typeof prepared === "number") {
    return prepared;
  }
  const { request, workspaceRoot, repo } = prepared;

  const started = Date.now();
  pruneRunDirs(started);
  const runId = newRunId(new Date(started));
  const runDir = createRunDir(runId);
  const resultFile = path.join(runDir, "result.md");
  io.stdout(`run: ${runId}\n`);

  const writable = !request.readOnly;
  let baseline: TimedSnapshot | null = null;
  let scratch: Scratch | null = null;
  let outcome: Outcome;
  let result: CodexRunResult | null = null;
  try {
    if (writable) {
      baseline = timedSnapshot(workspaceRoot);
      scratch = createScratch();
      io.stdout(`scratch: ${escapeLine(scratch.path)}\n`);
    }
    // The same sanitized environment as the runner's Git calls, so Codex works
    // on the checkout the change report measures.
    const env = { ...gitEnv(), ...(scratch === null ? {} : { TMPDIR: scratch.path }) };
    result = await runCodex(codexArgs(request, scratch, resultFile), {
      cwd: request.cwd,
      env,
      stdin: request.prompt,
      ...io.stopTiming,
      onThreadStarted: (threadId) => {
        io.stdout(`thread: ${threadId}\n`);
        recordThread(threadId, workspaceRoot, repo);
      },
    });
    outcome = outcomeOf(result, resultFile);
  } catch (error) {
    outcome =
      error instanceof CodexNotFoundError
        ? { exit: EXIT_CODEX_NOT_FOUND, summary: error.message, detail: "" }
        : { exit: EXIT_FAILED, summary: error instanceof Error ? error.message : String(error), detail: "" };
  }

  const reapError = result?.reapError ?? null;
  let report: ChangeReport = { kind: "read-only" };
  let finalMs: number | undefined;
  if (writable) {
    if (baseline === null) {
      report = { kind: "unknown", category: "snapshot-failed", reason: "no baseline snapshot", baseline: null };
    } else if (baseline.snapshot.kind !== "tree") {
      report = snapshotProblem(baseline.snapshot, "baseline", null);
    } else if (reapError !== null) {
      report = {
        kind: "unknown",
        category: "reap-error",
        reason: "Codex processes may still be running",
        baseline: baseline.snapshot.tree,
      };
    } else if (result?.receivedSignal) {
      report = { kind: "unknown", category: "interrupted", reason: "interrupted", baseline: baseline.snapshot.tree };
    } else {
      let final: TimedSnapshot;
      try {
        final = timedSnapshot(workspaceRoot);
      } catch (error) {
        // Such as a temporary index that could not be created.
        const reason = error instanceof Error ? error.message : String(error);
        final = { snapshot: { kind: "failed", reason, submodules: [] }, ms: 0 };
      }
      finalMs = final.ms;
      report =
        final.snapshot.kind === "tree"
          ? compareTrees(workspaceRoot, baseline.snapshot.tree, final.snapshot.tree)
          : snapshotProblem(final.snapshot, "final", baseline.snapshot.tree);
    }
  }

  // Codex may still be using the scratch directory after a reapError.
  const scratchLeft = scratch !== null && (reapError !== null || !removeScratch(scratch));

  if (outcome.summary !== null) {
    io.stderr(`codex-run: ${oneLine(outcome.summary)}\n${outcome.detail ? `${outcome.detail}\n` : ""}`);
  }

  const entry: RunLogEntry = {
    run: runId,
    time: new Date(started).toISOString(),
    sandbox: request.readOnly ? "read-only" : "workspace-write",
    continued: request.thread !== null,
    exit: outcome.exit,
    durationMs: Date.now() - started,
    changes: report.kind === "changes" ? report.entries.length : null,
    ...(report.kind === "unknown" ? { unknown: report.category } : {}),
    ...(baseline === null
      ? {}
      : { snapshotMs: { baseline: baseline.ms, ...(finalMs === undefined ? {} : { final: finalMs }) } }),
  };
  try {
    appendRunLog(entry);
  } catch (error) {
    io.stderr(
      `codex-run: could not append to the run log: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }

  const lines = [
    `status: ${statusWord(outcome.exit)} (exit ${outcome.exit})`,
    ...(outcome.exit === EXIT_OK ? [`result: ${escapeLine(resultFile)}`] : []),
    `sandbox: ${request.readOnly ? "read-only" : "workspace-write"}  cwd: ${escapeLine(request.cwd)}`,
    ...formatChanges(report, workspaceRoot, runDir),
    ...(scratchLeft && scratch !== null ? [`scratch left: ${escapeLine(scratch.path)}`] : []),
  ];
  io.stdout(`${lines.join("\n")}\n`);
  return outcome.exit;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2), {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    });
  } catch (error) {
    process.stderr.write(`codex-run: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = EXIT_FAILED;
  }
}
