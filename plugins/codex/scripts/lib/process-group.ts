import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

// Runs `codex` in its own process group and stops the whole group in stages.
//
// The npm build of the CLI is a Node launcher that runs the native binary as
// its child, and the launcher forwards only the first signal it receives. So
// every stop signal goes to the group (the launcher and everything under it):
// SIGINT first, which exec turns into a graceful turn interrupt, then SIGTERM,
// then SIGKILL. The result settles only once the group is gone and the output
// streams are closed, so callers can delete their temporary files safely.

export const INTERRUPT_GRACE_MS = 10_000;
export const TERMINATE_GRACE_MS = 5_000;
// Bounds the wait for stdout and stderr to close after the group is gone, in
// case a process that left the group still holds them open.
const STREAM_CLOSE_GRACE_MS = 2_000;
const POLL_MS = 50;

export class CodexNotFoundError extends Error {
  override name = "CodexNotFoundError";
}

// Thrown when the adapter received a signal and stopped the group; the
// process should exit with 128 + n.
export class InterruptedError extends Error {
  override name = "InterruptedError";
  signal: NodeJS.Signals;

  constructor(signal: NodeJS.Signals) {
    super(`interrupted by ${signal}`);
    this.signal = signal;
  }
}

export type StopTiming = { interruptGraceMs?: number; terminateGraceMs?: number };

export type GroupOptions = StopTiming & {
  cwd: string;
  // Stops the group after this long and reports timedOut.
  timeoutMs?: number;
  // Runs first when stopping, e.g. to close stdin for a graceful shutdown.
  onStop?: () => void;
};

export type GroupExit = {
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  // The signal the adapter itself received while the group ran.
  receivedSignal: NodeJS.Signals | null;
  timedOut: boolean;
};

export type SupervisedGroup = {
  child: ChildProcessWithoutNullStreams;
  stop: () => void;
  exited: Promise<GroupExit>;
};

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function spawnCodexGroup(args: readonly string[], options: GroupOptions): SupervisedGroup {
  const child = spawn("codex", args, {
    cwd: options.cwd,
    shell: false,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const interruptGraceMs = options.interruptGraceMs ?? INTERRUPT_GRACE_MS;
  const terminateGraceMs = options.terminateGraceMs ?? TERMINATE_GRACE_MS;
  const timers: NodeJS.Timeout[] = [];
  let receivedSignal: NodeJS.Signals | null = null;
  let timedOut = false;
  let stopping = false;
  let killDeadline = Number.POSITIVE_INFINITY;

  const signalGroup = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) {
      return;
    }
    try {
      process.kill(-child.pid, signal);
    } catch {
      // The group is already gone.
    }
  };
  const groupAlive = (): boolean => {
    if (child.pid === undefined) {
      return false;
    }
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      return error instanceof Error && "code" in error && error.code === "EPERM";
    }
  };

  const stop = (): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    try {
      options.onStop?.();
    } catch {
      // Stopping must go on even if the graceful step fails.
    }
    signalGroup("SIGINT");
    killDeadline = Date.now() + interruptGraceMs + terminateGraceMs;
    timers.push(
      setTimeout(() => signalGroup("SIGTERM"), interruptGraceMs),
      setTimeout(() => signalGroup("SIGKILL"), interruptGraceMs + terminateGraceMs),
    );
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    receivedSignal ??= signal;
    stop();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  if (options.timeoutMs !== undefined) {
    timers.push(
      setTimeout(() => {
        timedOut = true;
        stop();
      }, options.timeoutMs),
    );
  }

  const cleanup = (): void => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    for (const timer of timers) {
      clearTimeout(timer);
    }
  };

  let streamsClosed = false;
  const streamsClosedPromise = new Promise<void>((resolve) => {
    child.on("close", () => {
      streamsClosed = true;
      resolve();
    });
  });

  const exited = new Promise<GroupExit>((resolve, reject) => {
    let settled = false;
    child.on("error", (error) => {
      if (settled || child.pid !== undefined) {
        return;
      }
      settled = true;
      cleanup();
      reject(isNotFound(error) ? new CodexNotFoundError("codex was not found on PATH.") : error);
    });
    child.on("exit", (exitCode, exitSignal) => {
      if (settled) {
        return;
      }
      settled = true;
      void (async () => {
        // Anything left in the group (the launcher's child, or processes
        // Codex started) is stopped too, and waited for within the ladder.
        while (groupAlive() && Date.now() < killDeadline + 1_000) {
          stop();
          await sleep(POLL_MS);
        }
        if (!streamsClosed) {
          await Promise.race([streamsClosedPromise, sleep(STREAM_CLOSE_GRACE_MS)]);
          child.stdout.destroy();
          child.stderr.destroy();
        }
        cleanup();
        resolve({ exitCode, exitSignal, receivedSignal, timedOut });
      })();
    });
  });

  child.stdin.on("error", () => {});
  return { child, stop, exited };
}
