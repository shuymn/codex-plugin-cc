import readline from "node:readline";

import { isRecord, type JsonObject } from "./json.ts";
import { type GroupExit, spawnCodexGroup, type StopTiming } from "./process-group.ts";

export { CodexNotFoundError } from "./process-group.ts";

// `codex exec` drops its headless Never approval policy when the user config
// sets approvals_reviewer="auto_review", so every run states both explicitly.
export const APPROVAL_OVERRIDES: readonly string[] = [
  "-c",
  'approval_policy="never"',
  "-c",
  'approvals_reviewer="user"',
];

const STDERR_TAIL_LINES = 40;
const MAX_STDERR_CHARS = 1_000_000;

const SIGNAL_NUMBERS: Readonly<Record<string, number>> = { SIGINT: 2, SIGTERM: 15 };

export type CodexRunOptions = StopTiming & {
  cwd: string;
  // The whole environment of codex; process.env when omitted.
  env?: NodeJS.ProcessEnv;
  // Written to the child's stdin as is. Omitted: stdin is closed right away.
  stdin?: string | Uint8Array;
  // An exception here stops codex and is returned as callbackError.
  onThreadStarted?: (threadId: string) => void;
};

export type CodexRunResult = GroupExit & {
  errorMessage: string | null;
  stderr: string;
  callbackError: Error | null;
};

export function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + (SIGNAL_NUMBERS[signal] ?? 15);
}

// The CLI's notice that it could not set up its PATH helpers (0.169.0 words
// it "create PATH aliases", earlier versions "update PATH"); never the reason
// for a failure.
const PATH_WARNING = /^WARNING: proceeding, even though we could not (?:update PATH|create PATH aliases):/;

export function cleanCodexStderr(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !PATH_WARNING.test(line))
    .slice(-STDERR_TAIL_LINES)
    .join("\n");
}

// One line explaining why codex failed: the turn's error from the JSONL
// events, else the last line of the cleaned stderr tail that mentions an
// error, else its last line.
export function failureReason(errorMessage: string | null, cleanedTail: string): string {
  if (errorMessage) {
    return errorMessage;
  }
  const lines = cleanedTail.split("\n").filter(Boolean);
  return lines.findLast((line) => /error/i.test(line)) ?? lines.at(-1) ?? "";
}

function asObject(value: unknown): JsonObject | null {
  return isRecord(value) ? value : null;
}

function stringField(object: JsonObject | null, key: string): string | null {
  const value = object?.[key];
  return typeof value === "string" ? value : null;
}

export async function runCodex(args: readonly string[], options: CodexRunOptions): Promise<CodexRunResult> {
  // spawnCodexGroup reads only its own fields of the options.
  const group = spawnCodexGroup(args, options);
  const { child } = group;

  // Only to report each thread once.
  let threadId: string | null = null;
  let turnFailure: string | null = null;
  let lastError: string | null = null;
  let stderr = "";
  let callbackError: Error | null = null;

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
          try {
            options.onThreadStarted?.(id);
          } catch (error) {
            callbackError ??= error instanceof Error ? error : new Error(String(error));
            group.stop();
          }
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
  // code reports the failure, so EPIPE is not an error of its own.
  child.stdin.end(options.stdin ?? "");

  try {
    const exit = await group.exited;
    return {
      ...exit,
      errorMessage: turnFailure ?? lastError,
      stderr,
      callbackError,
    };
  } finally {
    lines.close();
  }
}
