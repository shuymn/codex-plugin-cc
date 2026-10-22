import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline";

import { isRecord, type JsonObject } from "./json.ts";

// `codex exec` drops its headless Never approval policy when the user config
// sets approvals_reviewer="auto_review", so every run states both explicitly.
export const APPROVAL_OVERRIDES: readonly string[] = [
  "-c",
  'approval_policy="never"',
  "-c",
  'approvals_reviewer="user"',
];

const INTERRUPT_GRACE_MS = 10_000;
const TERMINATE_GRACE_MS = 5_000;
const STDERR_TAIL_LINES = 40;
const MAX_STDERR_CHARS = 1_000_000;

const SIGNAL_NUMBERS: Readonly<Record<string, number>> = { SIGINT: 2, SIGTERM: 15 };

export class CodexNotFoundError extends Error {
  override name = "CodexNotFoundError";
}

export type ModelOptions = { model?: string; effort?: string };

export type CodexRunOptions = {
  cwd: string;
  // Omitted: the child's stdin is closed right away.
  stdin?: string;
  onThreadStarted?: (threadId: string) => void;
  // Interrupts the run like a signal would, for callers with a deadline.
  timeoutMs?: number;
};

export type CodexRunResult = {
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  // The signal the adapter itself received while codex ran.
  receivedSignal: NodeJS.Signals | null;
  timedOut: boolean;
  threadId: string | null;
  lastAgentMessage: string | null;
  errorMessage: string | null;
  stderr: string;
};

// Passes the model and effort through unchanged, and only when given.
export function modelArgs(options: ModelOptions): string[] {
  const args: string[] = [];
  if (options.model !== undefined) {
    args.push("-m", options.model);
  }
  if (options.effort !== undefined) {
    args.push("-c", `model_reasoning_effort=${JSON.stringify(options.effort)}`);
  }
  return args;
}

export function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + (SIGNAL_NUMBERS[signal] ?? 15);
}

export function cleanCodexStderr(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith("WARNING: proceeding, even though we could not update PATH:"))
    .slice(-STDERR_TAIL_LINES)
    .join("\n");
}

function asObject(value: unknown): JsonObject | null {
  return isRecord(value) ? value : null;
}

function stringField(object: JsonObject | null, key: string): string | null {
  const value = object?.[key];
  return typeof value === "string" ? value : null;
}

function isNotFound(error: unknown): boolean {
  return asObject(error)?.code === "ENOENT";
}

export function runCodex(args: readonly string[], options: CodexRunOptions): Promise<CodexRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let threadId: string | null = null;
    let lastAgentMessage: string | null = null;
    let turnFailure: string | null = null;
    let lastError: string | null = null;
    let stderr = "";
    let receivedSignal: NodeJS.Signals | null = null;
    let timedOut = false;
    let interrupting = false;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];

    const interrupt = (): void => {
      if (interrupting) {
        return;
      }
      interrupting = true;
      // exec turns SIGINT into a graceful turn interrupt; escalate if it hangs.
      child.kill("SIGINT");
      timers.push(
        setTimeout(() => child.kill("SIGTERM"), INTERRUPT_GRACE_MS),
        setTimeout(() => child.kill("SIGKILL"), INTERRUPT_GRACE_MS + TERMINATE_GRACE_MS),
      );
    };
    const onSignal = (signal: NodeJS.Signals): void => {
      receivedSignal ??= signal;
      interrupt();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    if (options.timeoutMs !== undefined) {
      timers.push(
        setTimeout(() => {
          timedOut = true;
          interrupt();
        }, options.timeoutMs),
      );
    }

    const cleanup = (): void => {
      settled = true;
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      for (const timer of timers) {
        clearTimeout(timer);
      }
    };

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      cleanup();
      reject(isNotFound(error) ? new CodexNotFoundError("codex was not found on PATH.") : error);
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS);
    });

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let event: JsonObject | null;
      try {
        const parsed: unknown = JSON.parse(line);
        event = asObject(parsed);
      } catch {
        return;
      }
      switch (event?.type) {
        case "thread.started": {
          const id = stringField(event, "thread_id");
          if (id && id !== threadId) {
            threadId = id;
            options.onThreadStarted?.(id);
          }
          break;
        }
        case "item.completed": {
          const item = asObject(event.item);
          if (item?.type === "agent_message") {
            lastAgentMessage = stringField(item, "text") ?? lastAgentMessage;
          }
          break;
        }
        case "turn.failed":
          turnFailure ??= stringField(asObject(event.error), "message");
          break;
        case "error":
          lastError = stringField(event, "message") ?? lastError;
          break;
        default:
          break;
      }
    });

    // A child that exits before reading all input closes the pipe; its exit
    // code reports the failure, so EPIPE here is not an error of its own.
    child.stdin.on("error", () => {});
    child.stdin.end(options.stdin ?? "");

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      cleanup();
      resolve({
        exitCode: code,
        exitSignal: signal,
        receivedSignal,
        timedOut,
        threadId,
        lastAgentMessage,
        errorMessage: turnFailure ?? lastError,
        stderr,
      });
    });
  });
}

export type CodexCommandResult = { status: number | null; stdout: string; stderr: string };

export function runCodexSync(args: readonly string[], cwd: string): CodexCommandResult {
  const result = spawnSync("codex", args, { cwd, encoding: "utf8", shell: false, timeout: 30_000 });
  if (result.error && isNotFound(result.error)) {
    throw new CodexNotFoundError("codex was not found on PATH.");
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
