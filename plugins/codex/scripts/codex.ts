// Thin adapter between the plugin's slash commands and the Codex CLI.
//
//   node codex.ts <task|review|adversarial-review|setup|transfer> <<'CODEX_PLUGIN_ARGS_<nonce>'
//   <raw slash-command arguments>
//   CODEX_PLUGIN_ARGS_<nonce>
//
// The subcommand comes from argv; the user's arguments come only from stdin.
// Exit codes: 0 success, 1 Codex failed, 2 usage error, 3 codex not found,
// 128+n interrupted by signal n.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { type ArgumentSpec, parseLeadingOptions, readArgumentInput, UsageError } from "./lib/args.ts";
import {
  APPROVAL_OVERRIDES,
  type CodexRunResult,
  CodexNotFoundError,
  cleanCodexStderr,
  ensureReaped,
  failureReason,
  type ModelOptions,
  modelArgs,
  runCodex,
  runCodexSync,
  signalExitCode,
} from "./lib/codex-exec.ts";
import { currentSessionId, PLUGIN_ROOT } from "./lib/env.ts";
import { isReviewGateEnabled, setReviewGate } from "./lib/gate-config.ts";
import {
  detectDefaultBranch,
  gitToplevel,
  hasUncommittedChanges,
  resolveCommit,
  resolveWorkspaceRoot,
} from "./lib/git.ts";
import { parseReviewOutput, renderReviewResult } from "./lib/review-render.ts";
import { recordThread, resolveResumeThread } from "./lib/thread-store.ts";
import { InterruptedError } from "./lib/process-group.ts";
import { importClaudeSession, resolveClaudeSessionPath } from "./lib/transfer.ts";

const EXIT_CODEX_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_CODEX_NOT_FOUND = 3;

type Options = Partial<Record<string, string | true>>;
type Subcommand = {
  spec: ArgumentSpec;
  usage: string;
  run: (options: Options, text: string) => Promise<number>;
};

class CodexFailure extends Error {
  override name = "CodexFailure";
  detail: string;

  constructor(summary: string, detail: string) {
    super(summary);
    this.detail = detail;
  }
}

function stringOption(options: Options, key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" ? value : undefined;
}

function modelOptions(options: Options): ModelOptions {
  const model = stringOption(options, "model");
  const effort = stringOption(options, "effort");
  return { ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) };
}

function resolveCwd(options: Options): string {
  const requested = stringOption(options, "cwd");
  if (requested === undefined) {
    return process.cwd();
  }
  const resolved = path.resolve(process.cwd(), requested);
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(resolved).isDirectory();
  } catch {
    // Reported below.
  }
  if (!isDirectory) {
    throw new UsageError(`--cwd is not a directory: ${resolved}`);
  }
  return resolved;
}

function quoteArgument(value: string): string {
  return /^[\w./~:@%+-]+$/.test(value) ? value : `"${value}"`;
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-"));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function readOutputFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

// Throws CodexFailure when codex failed or produced no final message.
function finalMessage(result: CodexRunResult, outputFile: string): string {
  if (result.exitCode !== 0) {
    const stderr = cleanCodexStderr(result.stderr);
    const reason = failureReason(result);
    const status = result.exitCode === null ? `signal ${result.exitSignal ?? "unknown"}` : String(result.exitCode);
    throw new CodexFailure(`codex exited with ${status}${reason ? `: ${reason}` : ""}`, stderr);
  }
  const fromFile = readOutputFile(outputFile);
  const message = fromFile.trim() ? fromFile : (result.lastAgentMessage ?? "");
  if (!message.trim()) {
    throw new CodexFailure("codex finished without a final message.", cleanCodexStderr(result.stderr));
  }
  return message.endsWith("\n") ? message : `${message}\n`;
}

function interpolate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key: string) => values[key] ?? "");
}

// ---------------------------------------------------------------- task

const TASK_USAGE = `Usage: /codex:rescue [options] <task text>

Runs a Codex task. The text after the leading options goes to Codex verbatim.

Options:
  --wait               Run in the foreground (handled by Claude Code).
  --read-only          Run Codex in a read-only sandbox (default: workspace-write).
  --resume             Continue the latest Codex thread of this Claude session.
  --thread <id>        Continue the given Codex thread of this Claude session.
  --cwd, -C <dir>      Run Codex in <dir>.
  --model <model>      Pass -m <model> to Codex.
  --effort <effort>    Pass model_reasoning_effort to Codex.
  --prompt-file <file> Read the task text from <file> instead.
  --help, -h           Show this help.
Put "--" before text that starts with "-".
`;

async function runTask(options: Options, text: string): Promise<number> {
  const cwd = resolveCwd(options);
  const promptFile = stringOption(options, "prompt-file");
  let prompt = text;
  if (promptFile !== undefined) {
    if (text !== "") {
      throw new UsageError("--prompt-file cannot be combined with task text.");
    }
    const promptPath = path.resolve(cwd, promptFile);
    try {
      prompt = fs.readFileSync(promptPath, "utf8");
    } catch {
      throw new UsageError(`cannot read --prompt-file ${promptPath}`);
    }
    if (prompt.trim() === "") {
      throw new UsageError(`--prompt-file is empty: ${promptPath}`);
    }
  } else if (text.trim() === "") {
    throw new UsageError("missing task text. Describe what Codex should do, or pass --prompt-file.");
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = currentSessionId();
  const requestedThread = stringOption(options, "thread");
  const resumeId =
    options.resume === true || requestedThread !== undefined
      ? resolveResumeThread(sessionId, workspaceRoot, requestedThread)
      : null;
  const sandbox = options["read-only"] === true ? "read-only" : "workspace-write";

  return withTempDir(async (dir) => {
    const outputFile = path.join(dir, "last.md");
    const runArgs = [...modelArgs(modelOptions(options)), "--json", "-o", outputFile];
    const args = [
      "exec",
      "-s",
      sandbox,
      ...APPROVAL_OVERRIDES,
      "--skip-git-repo-check",
      ...(resumeId === null ? [...runArgs, "-"] : ["resume", ...runArgs, resumeId, "-"]),
    ];

    let recorded = false;
    const result = await runCodex(args, {
      cwd,
      stdin: prompt,
      onThreadStarted: (threadId) => {
        process.stdout.write(`Codex thread: ${threadId}\n`);
        if (sessionId !== null) {
          recorded = recordThread(sessionId, threadId, workspaceRoot);
        }
      },
    });
    ensureReaped(result);
    if (result.receivedSignal) {
      return signalExitCode(result.receivedSignal);
    }
    if (result.callbackError) {
      throw new CodexFailure(
        `could not record the Codex thread, so Codex was stopped: ${result.callbackError.message}`,
        cleanCodexStderr(result.stderr),
      );
    }
    const message = finalMessage(result, outputFile);
    const threadId = result.threadId ?? "unknown";
    const cwdOption = options.cwd === undefined ? "" : ` --cwd ${quoteArgument(cwd)}`;
    // Without a Claude session id the thread is not recorded, so only the terminal can resume it.
    const continueHint = recorded ? `Continue: /codex:rescue --thread ${threadId}${cwdOption} <follow-up>   |  ` : "";
    process.stdout.write(
      [
        message,
        "---",
        `Codex thread: ${threadId}  (sandbox: ${sandbox}, cwd: ${cwd}, workspace: ${workspaceRoot})`,
        `${continueHint}Terminal: codex resume ${threadId}`,
        "",
      ].join("\n"),
    );
    return 0;
  });
}

// ---------------------------------------------------------------- reviews

type ReviewTarget = { args: string[]; label: string; instructions: string };

function resolveReviewTarget(cwd: string, base: string | undefined): ReviewTarget {
  if (gitToplevel(cwd) === null) {
    throw new UsageError(`reviews need a Git repository, and ${cwd} is not inside one.`);
  }
  let ref = base;
  if (ref === undefined) {
    if (hasUncommittedChanges(cwd)) {
      return {
        args: ["--uncommitted"],
        label: "uncommitted changes",
        instructions:
          "Review the uncommitted changes. Use `git status` and `git diff HEAD` to collect the staged, unstaged, and untracked changes, and read untracked files in full.",
      };
    }
    const detected = detectDefaultBranch(cwd);
    if (detected === null) {
      throw new UsageError("there are no uncommitted changes and no default branch was found. Pass --base <ref>.");
    }
    ref = detected;
  }
  const commit = resolveCommit(cwd, ref);
  if (commit === null) {
    throw new UsageError(`--base ${ref} does not name a commit.`);
  }
  return {
    args: ["--base", commit],
    label: `branch vs ${ref}`,
    instructions: `Review the changes of the current branch against ${ref}: use \`git diff ${commit}...HEAD\`, where ${commit} is ${ref}.`,
  };
}

const REVIEW_USAGE = `Usage: /codex:review [options]

Runs Codex's built-in read-only review of the uncommitted changes, or of the
branch against the default branch when there are none.

Options:
  --wait             Run in the foreground (handled by Claude Code).
  --base <ref>       Review the branch against <ref>.
  --cwd, -C <dir>    Review the repository at <dir>.
  --model <model>    Pass -m <model> to Codex.
  --effort <effort>  Pass model_reasoning_effort to Codex.
  --help, -h         Show this help.
Focus text is not accepted; use /codex:adversarial-review for that.
`;

async function runReview(options: Options): Promise<number> {
  const cwd = resolveCwd(options);
  const target = resolveReviewTarget(cwd, stringOption(options, "base"));
  return withTempDir(async (dir) => {
    const outputFile = path.join(dir, "last.md");
    const args = [
      "exec",
      "-s",
      "read-only",
      ...APPROVAL_OVERRIDES,
      "review",
      ...target.args,
      ...modelArgs(modelOptions(options)),
      "--json",
      "-o",
      outputFile,
    ];
    const result = await runCodex(args, { cwd });
    ensureReaped(result);
    if (result.receivedSignal) {
      return signalExitCode(result.receivedSignal);
    }
    const message = finalMessage(result, outputFile);
    process.stdout.write(`# Codex Review\n\nTarget: ${target.label}\n\n${message}`);
    return 0;
  });
}

const ADVERSARIAL_USAGE = `Usage: /codex:adversarial-review [options] [focus text]

Runs a read-only Codex review that challenges the change and its design.

Options:
  --wait             Run in the foreground (handled by Claude Code).
  --base <ref>       Review the branch against <ref>.
  --cwd, -C <dir>    Review the repository at <dir>.
  --model <model>    Pass -m <model> to Codex.
  --effort <effort>  Pass model_reasoning_effort to Codex.
  --help, -h         Show this help.
`;

async function runAdversarialReview(options: Options, text: string): Promise<number> {
  const cwd = resolveCwd(options);
  const target = resolveReviewTarget(cwd, stringOption(options, "base"));
  const template = fs.readFileSync(path.join(PLUGIN_ROOT, "prompts", "adversarial-review.md"), "utf8");
  const prompt = interpolate(template, {
    TARGET_LABEL: target.label,
    USER_FOCUS: text.trim() ? text : "No extra focus provided.",
    TARGET_INSTRUCTIONS: target.instructions,
  });
  return withTempDir(async (dir) => {
    const outputFile = path.join(dir, "last.json");
    const args = [
      "exec",
      "-s",
      "read-only",
      ...APPROVAL_OVERRIDES,
      ...modelArgs(modelOptions(options)),
      "--output-schema",
      path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json"),
      "--json",
      "-o",
      outputFile,
      "-",
    ];
    const result = await runCodex(args, { cwd, stdin: prompt });
    ensureReaped(result);
    if (result.receivedSignal) {
      return signalExitCode(result.receivedSignal);
    }
    const raw = finalMessage(result, outputFile);
    const parsed = parseReviewOutput(raw);
    if (!parsed.ok) {
      throw new CodexFailure(`Codex returned an invalid review: ${parsed.error}`, `Raw output:\n${raw.trimEnd()}`);
    }
    process.stdout.write(
      renderReviewResult(parsed.review, { title: "Codex Adversarial Review", targetLabel: target.label }),
    );
    return 0;
  });
}

// ---------------------------------------------------------------- setup

const SETUP_USAGE = `Usage: /codex:setup [options]

Reports whether the Codex CLI is installed and logged in, and the state of the
stop-time review gate for this workspace.

Options:
  --enable-review-gate   Turn the review gate on for this workspace.
  --disable-review-gate  Turn the review gate off for this workspace.
  --cwd, -C <dir>        Use the workspace at <dir>.
  --help, -h             Show this help.
`;

function firstLine(value: string): string {
  return (
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

async function runSetup(options: Options): Promise<number> {
  const cwd = resolveCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  if (options["enable-review-gate"] === true) {
    setReviewGate(workspaceRoot, true);
  } else if (options["disable-review-gate"] === true) {
    setReviewGate(workspaceRoot, false);
  }

  const nextSteps: string[] = [];
  let codexLine: string;
  let authLine: string;
  try {
    const version = runCodexSync(["--version"], cwd);
    codexLine = version.status === 0 ? firstLine(version.stdout) : `error (${firstLine(version.stderr)})`;
    const login = runCodexSync(["login", "status"], cwd);
    const detail = firstLine(`${login.stdout}\n${login.stderr}`);
    if (login.status === 0) {
      authLine = `logged in${detail ? ` (${detail})` : ""}`;
    } else {
      authLine = `not logged in${detail ? ` (${detail})` : ""}`;
      nextSteps.push("Run `!codex login` to sign in to Codex.");
    }
  } catch (error) {
    if (!(error instanceof CodexNotFoundError)) {
      throw error;
    }
    codexLine = "not found on PATH";
    authLine = "unknown";
    nextSteps.push("Install the Codex CLI (`npm install -g @openai/codex`), then rerun /codex:setup.");
  }

  const gate = isReviewGateEnabled(workspaceRoot) ? "enabled" : "disabled";
  const lines = [
    "# Codex Setup",
    "",
    `- codex: ${codexLine}`,
    `- auth: ${authLine}`,
    `- review gate: ${gate} for ${workspaceRoot}`,
    "",
    nextSteps.length === 0 ? "Codex is ready." : ["Next steps:", ...nextSteps.map((step) => `- ${step}`)].join("\n"),
    "",
  ];
  process.stdout.write(lines.join("\n"));
  return 0;
}

// ---------------------------------------------------------------- transfer

const TRANSFER_USAGE = `Usage: /codex:transfer [options]

Imports the current Claude Code session into a resumable Codex thread.

Options:
  --source <jsonl>  Import this Claude transcript instead of the current one.
  --cwd, -C <dir>   Start the Codex app server in <dir>. The imported thread's
                    working directory comes from the transcript, not from here.
  --help, -h        Show this help.
`;

async function runTransfer(options: Options): Promise<number> {
  const cwd = resolveCwd(options);
  const sourcePath = resolveClaudeSessionPath(cwd, stringOption(options, "source"));
  const threadId = await importClaudeSession(cwd, sourcePath);
  process.stdout.write(
    [
      "Transferred the Claude session into a Codex thread with visible turn history.",
      `Codex session ID: ${threadId}`,
      `Resume in Codex: codex resume ${threadId}`,
      "",
    ].join("\n"),
  );
  return 0;
}

// ---------------------------------------------------------------- dispatch

const SUBCOMMANDS: Readonly<Record<string, Subcommand>> = {
  task: {
    spec: {
      booleans: ["wait", "read-only", "resume"],
      values: ["cwd", "model", "effort", "prompt-file", "thread"],
      text: "optional",
      exclusive: [["resume", "thread"]],
    },
    usage: TASK_USAGE,
    run: runTask,
  },
  review: {
    spec: {
      booleans: ["wait"],
      values: ["cwd", "base", "model", "effort"],
      text: "forbidden",
      textForbiddenHint: "/codex:review takes no focus text; use /codex:adversarial-review for that.",
    },
    usage: REVIEW_USAGE,
    run: (options) => runReview(options),
  },
  "adversarial-review": {
    spec: { booleans: ["wait"], values: ["cwd", "base", "model", "effort"], text: "optional" },
    usage: ADVERSARIAL_USAGE,
    run: runAdversarialReview,
  },
  setup: {
    spec: {
      booleans: ["enable-review-gate", "disable-review-gate"],
      values: ["cwd"],
      text: "forbidden",
      exclusive: [["enable-review-gate", "disable-review-gate"]],
    },
    usage: SETUP_USAGE,
    run: (options) => runSetup(options),
  },
  transfer: {
    spec: { booleans: [], values: ["cwd", "source"], text: "forbidden" },
    usage: TRANSFER_USAGE,
    run: (options) => runTransfer(options),
  },
};

const MAIN_USAGE = `Usage: node codex.ts <${Object.keys(SUBCOMMANDS).join("|")}> < arguments

Arguments are read from stdin. Pass --help on stdin for a subcommand's options.
`;

async function main(): Promise<number> {
  const name = process.argv[2];
  if (name === "--help" || name === "-h") {
    process.stdout.write(MAIN_USAGE);
    return 0;
  }
  const subcommand = name === undefined ? undefined : SUBCOMMANDS[name];
  if (subcommand === undefined || process.argv.length > 3) {
    throw new UsageError(`expected exactly one subcommand.\n${MAIN_USAGE}`);
  }
  const parsed = parseLeadingOptions(await readArgumentInput(), subcommand.spec);
  if (parsed.help) {
    process.stdout.write(subcommand.usage);
    return 0;
  }
  return subcommand.run(parsed.options, parsed.text);
}

function fail(code: number, summary: string, detail = ""): number {
  process.stderr.write(`codex-plugin: ${summary}\n${detail ? `${detail}\n` : ""}`);
  return code;
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof UsageError) {
    process.exitCode = fail(EXIT_USAGE, error.message);
  } else if (error instanceof CodexNotFoundError) {
    process.exitCode = fail(EXIT_CODEX_NOT_FOUND, `${error.message} Run /codex:setup.`);
  } else if (error instanceof CodexFailure) {
    process.exitCode = fail(EXIT_CODEX_FAILED, error.message, error.detail);
  } else if (error instanceof InterruptedError) {
    process.exitCode = signalExitCode(error.signal);
  } else {
    // Everything else, such as TransferError and ReapError, is a Codex failure.
    process.exitCode = fail(EXIT_CODEX_FAILED, error instanceof Error ? error.message : String(error));
  }
}
